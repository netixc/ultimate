import { resolve } from 'node:path'
import { createServer } from 'vite-plus'
import react from '@vitejs/plugin-react'
import { chromium } from 'playwright-core'
import type { Page } from 'playwright-core'
import { expect, it } from 'vitest'
import { browserBinary } from '../../../../../extensions/browser/server.ts'
import { navigationUrl } from '../../navigation.ts'

async function withFleet(run: (page: Page) => Promise<void>, deferMount = false) {
  const sdk = '/fleet-test-sdk.jsx'
  const harness = '/fleet-test-harness.jsx'
  const vite = await createServer({
    configFile: false,
    root: resolve('.'),
    optimizeDeps: { include: ['react', 'react-dom/client', 'react/jsx-runtime'] },
    plugins: [
      react(),
      {
        name: 'fleet-refresh-test',
        configureServer(server) {
          server.middlewares.use('/fleet-test', async (_request, response) => {
            const code = await server.transformRequest(harness)
            response.setHeader('Content-Type', 'text/html')
            response.end(
              await server.transformIndexHtml(
                '/fleet-test',
                `<!doctype html><title>Fleet synthetic refresh fixture</title><div id="root" style="display:flex;height:600px"></div><script type="module">${code!.code}</script>`,
              ),
            )
          })
        },
        resolveId(id) {
          if (id === '@/sdk') return sdk
          if (id === sdk || id === harness) return id
          return undefined
        },
        load(id) {
          if (id === harness)
            return `
          import React from 'react';
          import {createRoot} from 'react-dom/client';
          import fleet from '/.ultimate/extensions/fleet/web.tsx';
          window.mountFleet = () => createRoot(document.getElementById('root')).render(React.createElement(fleet.slots['shell.rail'][0]));
          if (!new URL(location.href).searchParams.has('defer')) window.mountFleet();
        `
          if (id === sdk)
            return `
          import {useCallback, useEffect, useState} from 'react';
          export const actionRef = () => ({});
          export const defineWebExtension = value => value;
          export const errorMessage = String;
          export const notify = () => {};
          export const prepareInstanceNavigation = async () => {};
          export const useSystem = () => ({project:{name:'home'}});
          export const useUiState = () => [null];
          export const useConversations = () => [];
          export function useDocOf() {
            const [version, setVersion] = useState(0);
            useEffect(() => {
              const update = () => setVersion(value => value + 1);
              window.addEventListener('local-update', update);
              return () => window.removeEventListener('local-update', update);
            }, []);
            return version;
          }
          const project = {id:'home',name:'workbench-config',initials:'wo',port:'4750',url:'/',current:true,inFlight:false,awaiting:1,available:true};
          const snapshot = {home:project,machines:[{id:'device',name:'device',shortName:'de',online:null,projects:[project]}]};
          let pending;
          window.inventoryCalls = 0;
          window.inventoryAborts = 0;
          export function useAction() {
            const [state, setState] = useState({loading:true});
            const refetch = useCallback(() => {
              window.inventoryCalls++;
              if (pending) { window.inventoryAborts++; pending(); }
              setState(previous => ({...previous,loading:true}));
              window.inventoryPending = true;
              return new Promise(resolve => {
                pending = resolve;
                window.releaseInventory = () => {
                  pending = undefined;
                  window.inventoryPending = false;
                  setState({data:snapshot,loading:false});
                  resolve(snapshot);
                };
              });
            }, []);
            useEffect(() => { void refetch(); }, [refetch]);
            return {...state,refetch};
          }
        `
          return undefined
        },
      },
    ],
    server: { host: '127.0.0.1', port: 0 },
  })
  await vite.listen()
  const browser = await chromium.launch({ executablePath: await browserBinary(), headless: true })
  try {
    const page = await browser.newPage()
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto(vite.resolvedUrls!.local[0] + 'fleet-test' + (deferMount ? '?defer' : ''))
    await page.waitForFunction(
      deferMount ? "typeof window.mountFleet === 'function'" : 'window.inventoryCalls >= 1',
    )
    await run(page)
    expect(errors).toEqual([])
  } finally {
    await browser.close()
    await vite.close()
  }
}

it.each(['automatic', 'manual'])(
  'finishes pending navigation on pre-mount reload (%s), then resets after mounting',
  async (reload) => {
    await withFleet(async (page) => {
      const state = {
        open: false,
        pinned: true,
        homeUrl: 'https://home.example.test:4750/',
        homeName: 'source',
        homeProjectId: 'original',
        homeMachine: 'source-device',
        homePort: '4750',
      }
      await page.goto(navigationUrl(page.url(), state, state.homeUrl))
      await page.waitForFunction("typeof window.mountFleet === 'function'")
      expect(await page.locator('.fleet').count()).toBe(0)
      if (reload === 'automatic') {
        await Promise.all([
          page.waitForEvent('domcontentloaded'),
          page.evaluate('location.reload()'),
        ])
      } else await page.reload()
      await page.waitForFunction("typeof window.mountFleet === 'function'")
      expect(await page.evaluate("performance.getEntriesByType('navigation')[0].type")).toBe(
        'reload',
      )
      expect(await page.locator('.fleet').count()).toBe(0)
      expect(new URL(page.url()).hash).toContain('fleet=')
      await page.evaluate('window.mountFleet()')
      await page.locator('.fleet-rail[data-pinned="true"]').waitFor()
      expect(await page.locator('.home-copy').textContent()).toBe('source:4750')
      await page.waitForFunction("location.hash === ''")
      await page.reload()
      await page.waitForFunction("typeof window.mountFleet === 'function'")
      await page.evaluate('window.mountFleet()')
      await page.locator('.fleet-rail[data-pinned="false"][data-expanded="true"]').waitFor()
      expect(new URL(page.url()).hash).toBe('')
    }, true)
  },
)

it('lets a slow inventory finish and coalesces local changes instead of cancelling it', async () => {
  await withFleet(async (page) => {
    const burst = async () => {
      for (let index = 0; index < 5; index++) {
        await page.evaluate(
          "window.dispatchEvent(new Event('local-update')); window.dispatchEvent(new Event('focus'))",
        )
      }
    }
    await burst()
    expect(await page.evaluate('window.inventoryCalls')).toBe(1)
    expect(await page.evaluate('window.inventoryAborts')).toBe(0)
    await page.evaluate('window.releaseInventory()')
    await page.waitForFunction('window.inventoryCalls === 2')
    expect(await page.locator('.fleet .count').textContent()).toBe('1')
    expect(await page.locator('.fleet .project-row').count()).toBe(1)
    await burst()
    expect(await page.evaluate('window.inventoryCalls')).toBe(2)
    await page.evaluate('window.releaseInventory()')
    await page.waitForFunction('window.inventoryCalls === 3')
    await page.evaluate('window.releaseInventory()')
    await page.waitForFunction('window.inventoryPending === false')
    expect(await page.evaluate('window.inventoryAborts')).toBe(0)
  })
})

it('paints the complete reference home port beside its awaiting badge instead of clipping its last digit', async () => {
  await withFleet(async (page) => {
    await page.evaluate('window.releaseInventory()')
    await page.locator('.home-row .count').waitFor()
    expect(await page.locator('.home-copy .port').textContent()).toBe(':4750')
    expect(
      await page.locator('.home-copy .port').evaluate((port) => {
        const right = port.getBoundingClientRect().right
        for (let parent = port.parentElement; parent; parent = parent.parentElement) {
          if (
            getComputedStyle(parent).overflowX !== 'visible' &&
            right > parent.getBoundingClientRect().right
          )
            return false
        }
        return true
      }),
    ).toBe(true)
  })
})
