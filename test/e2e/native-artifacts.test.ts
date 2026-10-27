import { resolve } from 'node:path'
import { createServer as httpServer } from 'node:http'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import { createServer } from 'vite-plus'
import react from '@vitejs/plugin-react'
import { chromium } from 'playwright-core'
import { expect, it } from 'vitest'
import { browserBinary } from '../../extensions/browser/server.ts'
import { buildDocument } from '../../.ultimate/extensions/native-artifacts/sandbox.ts'
import type {
  ArtifactAnchor,
  ArtifactSnapshot,
} from '../../.ultimate/extensions/artifacts/types.ts'
import type { NativeDocument } from '../../.ultimate/extensions/native-artifacts/types.ts'
import { until } from '../helpers.ts'

it('captures element and cross-node text targets, validates stale boundaries, and rejects forged messages', async () => {
  const snapshot: ArtifactSnapshot = {
    artifact: {
      id: 'browser',
      title: 'Native artifact',
      ownerConversation: 1,
      recipientConversation: 1,
      source: { workspace: '/workspace', path: 'index.html', assets: ['pixel.png'] },
      contentHash: 'one',
      updatedAt: 1,
    },
    html: '<h1>Review artifact</h1><p>Hello <strong>brave</strong> world</p><a href="https://blocked.example" style="outline:1px dotted red;outline-offset:4px;color:navy">A static link</a><p><button>Control</button></p><img src="pixel.png" alt="Decorative sample" width="40" height="40"><section><p id="paragraph">Paragraph text with a natural boundary.</p><span>Next inline</span><div>Following block</div></section>',
    assets: [
      {
        path: 'pixel.png',
        mime: 'image/png',
        base64:
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9XcAAAAASUVORK5CYII=',
      },
    ],
  }
  const vite = await createServer({
    configFile: false,
    root: resolve('.'),
    optimizeDeps: { include: ['react', 'react-dom/client', 'react/jsx-runtime'] },
    plugins: [
      react(),
      {
        name: 'native-frame-test',
        configureServer(server) {
          server.middlewares.use('/native-test', async (_request, response) => {
            const code = await server.transformRequest('/native-harness.jsx')
            const html = await server.transformIndexHtml(
              '/native-test',
              `<!doctype html><html><head><title>Native frame test</title><style>#root > div{display:flex;height:100%;flex-direction:column}iframe{flex:1;min-height:0;width:100%;border:0;background:white}[role=status]{position:absolute;width:1px;height:1px;clip-path:inset(50%);overflow:hidden}</style></head><body style="margin:0;background:#171717;color:white"><div id="root" style="height:700px"></div><script type="module">${code!.code}</script></body></html>`,
            )
            response.setHeader('Content-Type', 'text/html')
            response.end(html)
          })
        },
        resolveId(id) {
          if (id === '/native-harness.jsx') return id
          return undefined
        },
        load(id) {
          if (id === '/native-harness.jsx')
            return `
      import React from 'react';
      import {createRoot} from 'react-dom/client';
      import {ArtifactFrame} from '/.ultimate/extensions/native-artifacts/viewer.tsx';
      const root = createRoot(document.getElementById('root'));
      window.received = []; window.statuses = []; window.errors = []; window.ready = 0;
      window.props = {mode:'element',capture:0,anchors:[],onTarget:a=>window.received.push(a),onStatuses:s=>window.statuses.push(s),onError:e=>window.errors.push(e),onReady:()=>window.ready++};
      window.install = (doc, patch={}) => { Object.assign(window.props,patch); if(doc)window.props.document=doc; root.render(React.createElement(ArtifactFrame,window.props)); };
    `
          return undefined
        },
      },
    ],
    server: { host: '127.0.0.1', port: 0 },
  })
  await vite.listen()
  const origin = vite.resolvedUrls!.local[0].replace(/\/$/, '')
  const makeDocument = (): NativeDocument => ({
    artifact: snapshot.artifact,
    ...buildDocument(snapshot, origin),
  })
  const browser = await chromium.launch({
    executablePath: await browserBinary(),
    headless: true,
    env: { ...process.env, TMPDIR: undefined },
  })
  try {
    const page = await browser.newPage({ viewport: { width: 1000, height: 760 } })
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto(origin + '/native-test')
    await page.waitForFunction(() => typeof (window as any).install === 'function')
    const install = async (doc: NativeDocument | null, patch: object = {}) => {
      await page.evaluate(([d, p]) => (window as any).install(d, p), [doc, patch])
    }
    const first = makeDocument()
    await install(first)
    await until(async () => await page.evaluate(() => (window as any).ready === 1))
    const iframe = page.locator('iframe')
    expect(await iframe.getAttribute('sandbox')).toBe('allow-scripts')
    const child = page.frameLocator('iframe')
    const originalMarkup = await child.locator('body').evaluate((body) => body.innerHTML)
    const link = child.locator('a')
    const originalStyle = await link.getAttribute('style')
    await link.hover()
    await until(
      async () =>
        await link.evaluate(
          (node) =>
            node.style.outlineWidth === '2px' &&
            node.style.getPropertyPriority('outline') === 'important',
        ),
    )
    await install(null, { mode: 'view' })
    await until(async () => (await link.getAttribute('style')) === originalStyle)
    expect(await child.locator('body').evaluate((body) => body.innerHTML)).toBe(originalMarkup)
    await link.hover()
    expect(await link.getAttribute('style')).toBe(originalStyle)
    await install(null, { mode: 'element' })
    await link.hover()
    await child.locator('button').hover()
    expect(await link.getAttribute('style')).toBe(originalStyle)
    await child.locator('button').evaluate((button) => button.focus())
    expect(await child.locator('button').evaluate((button) => button.style.outlineWidth)).toBe(
      '2px',
    )
    await child.locator('button').evaluate((button) => button.blur())
    expect(await child.locator('button').getAttribute('style')).toBeNull()
    await link.click()
    await until(async () => await page.evaluate(() => (window as any).received.length === 1))
    const element = (await page.evaluate(() => (window as any).received[0])) as ArtifactAnchor
    expect(element).toMatchObject({ kind: 'element', text: 'A static link' })
    expect(page.url()).toBe(origin + '/native-test')
    await install(null, { mode: 'text' })
    // Selection remains native; only the external Capture counter submits it.
    await child
      .locator('p')
      .first()
      .evaluate((p) => {
        const range = document.createRange()
        range.setStart(p.firstChild!, 3)
        range.setEnd(p.lastChild!, 3)
        const selection = getSelection()!
        selection.removeAllRanges()
        selection.addRange(range)
      })
    expect(await page.evaluate(() => (window as any).received.length)).toBe(1)
    await install(null, { capture: 1 })
    await until(async () => await page.evaluate(() => (window as any).received.length === 2))
    const text = (await page.evaluate(() => (window as any).received[1])) as ArtifactAnchor
    expect(text).toMatchObject({
      kind: 'text',
      text: 'lo brave wo',
      start: { path: [0], offset: 3 },
      end: { path: [2], offset: 3 },
    })
    const missing = { ...element, selector: '#absent' }
    await install(null, { anchors: [element, text, missing] })
    await until(
      async () =>
        await page.evaluate(
          () => JSON.stringify((window as any).statuses.at(-1)) === '["same","same","missing"]',
        ),
    )
    // The old quote elsewhere is not a relocation candidate, even when it appears more than once.
    snapshot.html =
      snapshot.html.replace('brave', 'bold') + '<p>Hello brave world</p><p>Hello brave world</p>'
    await install(makeDocument())
    await until(async () => await page.evaluate(() => (window as any).ready === 2))
    await until(
      async () =>
        await page.evaluate(
          () => JSON.stringify((window as any).statuses.at(-1)) === '["same","changed","missing"]',
        ),
    )
    const current = (await page.evaluate(() => (window as any).props.document)) as NativeDocument
    // A same-channel target from another window/origin cannot reach the parent callback.
    await page.evaluate(async (channel) => {
      const data = {
        type: 'target',
        channel,
        anchor: {
          kind: 'text',
          selector: 'p',
          text: 'forged',
          start: { path: [0], offset: 0 },
          end: { path: [0], offset: 6 },
        },
      }
      // Exact frame window, but not the opaque origin.
      dispatchEvent(
        new MessageEvent('message', {
          source: document.querySelector('iframe')!.contentWindow,
          origin: location.origin,
          data,
        }),
      )
      // A real opaque sibling has origin 'null', but is not the artifact frame window.
      await new Promise<void>((done) => {
        const sibling = document.createElement('iframe')
        sibling.setAttribute('sandbox', 'allow-scripts')
        sibling.srcdoc = `<script>parent.postMessage(${JSON.stringify(data)},${JSON.stringify(location.origin)})</script>`
        sibling.addEventListener(
          'load',
          () => {
            sibling.remove()
            done()
          },
          { once: true },
        )
        document.body.append(sibling)
      })
    }, current.channel)
    const frame = page.frames().find((f) => f !== page.mainFrame())!
    await frame.evaluate(
      ({ channel, parentOrigin }) => {
        // Correct source but wrong origin: must not switch into element capture mode.
        dispatchEvent(
          new MessageEvent('message', {
            source: parent,
            origin: 'https://wrong.example',
            data: { type: 'configure', channel, mode: 'element', anchors: [] },
          }),
        )
        // Correct origin but wrong source is rejected independently.
        dispatchEvent(
          new MessageEvent('message', {
            source: window,
            origin: parentOrigin,
            data: { type: 'configure', channel, mode: 'element', anchors: [] },
          }),
        )
        // A malformed frame payload and wrong-channel payload must be ignored by the host.
        parent.postMessage(
          {
            type: 'target',
            channel,
            anchor: { kind: 'text', selector: 'p', text: 'x'.repeat(2001) },
          },
          parentOrigin,
        )
        parent.postMessage(
          {
            type: 'target',
            channel: 'wrong',
            anchor: { kind: 'element', selector: 'p', text: 'forged' },
          },
          parentOrigin,
        )
      },
      { channel: current.channel, parentOrigin: origin },
    )
    await child.locator('h1').click()
    await install(null, { capture: 2 })
    await until(async () => await page.evaluate(() => (window as any).errors.length === 1))
    expect(await page.evaluate(() => (window as any).received.length)).toBe(2)
    expect(await page.getByRole('status').textContent()).toContain('Select some text')
    await install(null, { mode: 'element' })
    await child.locator('button').click()
    await until(async () => await page.evaluate(() => (window as any).received.length === 3))
    await child.locator('img').click()
    await until(async () => await page.evaluate(() => (window as any).received.length === 4))
    expect(await page.evaluate(() => (window as any).received[2])).toMatchObject({
      kind: 'element',
      text: 'Control',
    })
    expect(await page.evaluate(() => (window as any).received[3])).toMatchObject({
      kind: 'element',
      text: '',
    })
    await install(null, { mode: 'text' })
    await child.locator('#paragraph').click({ clickCount: 3 })
    const nativeSelection = await child.locator('#paragraph').evaluate(() => {
      const range = getSelection()!.getRangeAt(0)
      return {
        quote: range.toString(),
        endType: range.endContainer.nodeType,
        endOffset: range.endOffset,
      }
    })
    expect(nativeSelection).toEqual({
      quote: 'Paragraph text with a natural boundary.',
      endType: 1,
      endOffset: 0,
    })
    await install(null, { capture: 3 })
    await until(async () => await page.evaluate(() => (window as any).received.length === 5))
    expect(await page.evaluate(() => (window as any).received[4])).toMatchObject({
      kind: 'text',
      text: nativeSelection.quote,
      end: { offset: 0 },
    })
    expect(errors).toEqual([])
  } finally {
    await browser.close()
    await vite.close()
  }
})

it('keeps retained stylesheet closing tags from injecting navigation or resources', async () => {
  const server = httpServer((_request, response) => {
    response.setHeader('Content-Type', 'text/html')
    response.end(
      '<!doctype html><title>Passive parent</title><script>window.messages=[];addEventListener("message",e=>window.messages.push(e.data))</script>',
    )
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const browser = await chromium.launch({
    executablePath: await browserBinary(),
    headless: true,
    env: { ...process.env, TMPDIR: undefined },
  })
  try {
    const page = await browser.newPage()
    const leaked: string[] = []
    page.on('request', (request) => {
      if (request.url().startsWith('https://blocked.example')) leaked.push(request.url())
    })
    await page.goto(origin)
    const snapshot: ArtifactSnapshot = {
      artifact: {
        id: 'css-breakout',
        title: 'CSS breakout regression',
        ownerConversation: 1,
        recipientConversation: 1,
        source: { workspace: '/workspace', path: 'index.html', assets: ['site.css'] },
        contentHash: 'one',
        updatedAt: 1,
      },
      html: '<link rel="stylesheet" href="site.css"><p>Still here</p>',
      assets: [
        {
          path: 'site.css',
          mime: 'text/css',
          base64: Buffer.from(
            `p{color:red}/* </style><meta http-equiv="refresh" content="0;url=https://blocked.example/refresh"> */p:after{content:'</style><img src="https://blocked.example/image"><meta http-equiv="refresh" content="0;url=https://blocked.example/refresh">'}`,
          ).toString('base64'),
        },
      ],
    }
    const doc = buildDocument(snapshot, origin)
    await page.evaluate((srcdoc) => {
      const frame = document.createElement('iframe')
      frame.setAttribute('sandbox', 'allow-scripts')
      frame.srcdoc = srcdoc
      document.body.append(frame)
    }, doc.srcdoc)
    await until(
      async () =>
        await page.evaluate(() => (window as any).messages.some((m: any) => m.type === 'ready')),
    )
    const child = page.frames().find((frame) => frame !== page.mainFrame())!
    await child.waitForLoadState('load')
    expect(await child.evaluate(() => location.href)).toBe('about:srcdoc')
    expect(await child.locator('p').textContent()).toBe('Still here')
    expect(await child.locator('meta[http-equiv="refresh"], img').count()).toBe(0)
    expect(leaked).toEqual([])
  } finally {
    await browser.close()
    await new Promise<void>((done) => server.close(() => done()))
  }
})
