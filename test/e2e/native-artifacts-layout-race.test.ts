import { writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { chromium } from 'playwright-core'
import { expect, it } from 'vitest'
import { browserBinary } from '../../extensions/browser/server.ts'
import { context } from '../../server/harness.ts'
import type { LayoutState } from '../../.ultimate/extensions/artifacts/types.ts'
import { fauxServer, post, temp, until } from '../helpers.ts'

it('ignores a saved old-frame layout response after a clean live revision has been measured', async () => {
  const home = await temp('ultimate-native-layout-race-')
  const server = await fauxServer({
    ultimateRoot: resolve('.'),
    projectRoot: resolve('.'),
    userHome: home,
    home: join(home, 'state'),
    port: 0,
  })
  const browser = await chromium.launch({
    executablePath: await browserBinary(),
    headless: true,
    env: { ...process.env, TMPDIR: undefined },
  })
  let release = () => {}
  try {
    const owner = await server.harness.createConversation(
      { ownership: { kind: 'ownerless' } },
      context,
    )
    const path = join(server.host.projectRoot, 'layout-race.html')
    await writeFile(
      path,
      '<!doctype html><style>body{margin:0}.wide{width:calc(100vw + 160px)}</style><h1>Old revision</h1><div class="wide">Overflow</div>',
    )
    // Exercise the reviewer's live-document polling, not Vite's full HTML page reload.
    server.vite.watcher.unwatch(path)
    const published = await post(server, '/api/extensions/artifacts/actions/publish', {
      conversationId: owner.id,
      args: { id: 'layout-race', title: 'Layout response race', path: 'layout-race.html' },
    })
    expect(published.status).toBe(200)
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    const held = new Promise<void>((done) => (release = done))
    let oldHash: string | undefined
    let savedOld: LayoutState | undefined
    let savedNew: LayoutState | undefined
    await page.route('**/api/extensions/native-artifacts/actions/layoutPass', async (route) => {
      const hash = route.request().postDataJSON().args.contentHash as string
      const response = await route.fetch()
      const state = (await response.json()).result as LayoutState
      if (!oldHash) {
        oldHash = hash
        savedOld = state
        // The real backend has already persisted this observation. Only its HTTP reply is held.
        await held
      } else if (hash !== oldHash) savedNew = state
      await route.fulfill({ response })
    })
    await page.goto(`${server.url}/?conversation=${owner.id}`)
    await page.locator('[data-surface="native-artifacts"]').click()
    const frame = page.frameLocator('[data-artifact-frame] iframe')
    await frame.getByRole('heading', { name: 'Old revision', exact: true }).waitFor()
    await until(() => !!savedOld)
    expect(savedOld!.issues.filter((issue) => issue.status === 'open')).toHaveLength(1)
    expect(savedOld!.pass?.complete).toBe(true)

    await writeFile(path, '<!doctype html><h1>Clean new revision</h1><p>No overflow.</p>')
    await frame.getByRole('heading', { name: 'Clean new revision', exact: true }).waitFor()
    await until(() => !!savedNew)
    expect(savedNew!.issues.filter((issue) => issue.status === 'open')).toHaveLength(0)
    expect(savedNew!.pass?.complete).toBe(true)
    const issues = page.getByRole('button', { name: 'Issues · 0', exact: true })
    await issues.waitFor()
    const oldResponse = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname ===
          '/api/extensions/native-artifacts/actions/layoutPass' &&
        response.request().postDataJSON().args.contentHash === oldHash,
    )
    release()
    await (await oldResponse).finished()
    // A real interaction renders the settled result after the delayed response, without a timed sleep.
    await page.getByRole('button', { name: /^Issues ·/ }).click()
    await page.locator('[data-artifact-issues]').waitFor()
    expect(await page.getByRole('button', { name: /^Issues ·/ }).getAttribute('aria-label')).toBe(
      'Issues · 0',
    )
    await page
      .locator('[data-artifact-issues]')
      .getByText('0 open measured issues', { exact: true })
      .waitFor()
    expect(errors).toEqual([])
  } finally {
    release()
    await browser.close()
    await server.close()
  }
})
