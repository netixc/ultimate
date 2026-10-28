import { createServer } from 'node:http'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import { chromium } from 'playwright-core'
import type { Frame, Page } from 'playwright-core'
import { expect, it } from 'vitest'
import { browserBinary } from '../../extensions/browser/server.ts'
import { buildDocument } from '../../.ultimate/extensions/artifacts/sandbox.ts'
import { decodeFrameMessage } from '../../.ultimate/extensions/artifacts/bridge.ts'
import type { ArtifactSnapshot } from '../../.ultimate/extensions/artifacts/types.ts'
import type { FrameMessage } from '../../.ultimate/extensions/artifacts/bridge.ts'
import { until } from '../helpers.ts'

async function inFrame(
  html: string,
  run: (page: Page, frame: Frame, channel: string) => Promise<void>,
  assets: ArtifactSnapshot['assets'] = [],
) {
  const server = createServer((_request, response) => {
    response.setHeader('Content-Type', 'text/html')
    response.end(`<!doctype html><title>Frame protocol</title><body style="margin:0"><script>
      window.messages=[];addEventListener('message',e=>{const f=document.querySelector('iframe');
      if(e.source===f?.contentWindow&&e.origin==='null')window.messages.push(e.data)})
    </script>`)
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
    const page = await browser.newPage({ viewport: { width: 1000, height: 800 } })
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto(origin)
    const snapshot: ArtifactSnapshot = {
      artifact: {
        id: 'frame',
        title: 'Frame protocol',
        ownerConversation: 1,
        recipientConversation: 1,
        source: {
          workspace: '/workspace',
          path: 'index.html',
          assets: assets.map((asset) => asset.path),
        },
        contentHash: 'one',
        updatedAt: 1,
      },
      html,
      assets,
    }
    const built = buildDocument(snapshot, origin)
    await page.evaluate((srcdoc) => {
      const iframe = document.createElement('iframe')
      iframe.setAttribute('sandbox', 'allow-scripts')
      iframe.style.cssText = 'width:640px;height:420px;border:0'
      iframe.srcdoc = srcdoc
      document.body.append(iframe)
    }, built.srcdoc)
    await until(async () => (await messages(page, built.channel)).some((m) => m.type === 'ready'))
    const frame = page.frames().find((f) => f !== page.mainFrame())!
    await run(page, frame, built.channel)
    expect(errors).toEqual([])
  } finally {
    await browser.close()
    await new Promise<void>((done) => server.close(() => done()))
  }
}

async function messages(page: Page, channel: string) {
  const raw: unknown[] = await page.evaluate(() => (window as any).messages)
  return raw
    .map((message) => decodeFrameMessage(message, channel))
    .filter((m): m is FrameMessage => !!m)
}
async function configure(page: Page, channel: string, patch: object) {
  await page.evaluate(
    (message) => {
      // Opaque origins cannot be addressed by an origin string; only this exact sandbox window is targeted.
      document.querySelector('iframe')!.contentWindow!.postMessage(message, '*')
    },
    { type: 'configure', channel, mode: 'annotate', anchors: [], ...patch },
  )
}

it('locks selected element/text geometry, reanchors on scroll/resize, and reveals without capture', async () => {
  await inFrame(
    `<style>body{margin:0}#pick{margin:40px;width:50%}#text{margin:20px}#bottom{margin-top:900px}</style>
    <button id="pick">Choose this control</button><p id="text">Lock this exact text</p><button id="bottom">Below fold</button>`,
    async (page, frame, channel) => {
      await configure(page, channel, {})
      const bodyBefore = await frame.locator('body').evaluate((body) => body.innerHTML)
      await frame.locator('#pick').hover()
      expect(await frame.locator('#pick').evaluate((button) => button.style.outlineWidth)).toBe(
        '2px',
      )
      expect((await messages(page, channel)).filter((m) => m.type === 'target')).toHaveLength(0)
      expect(await frame.evaluate(() => document.activeElement === document.body)).toBe(true)
      await configure(page, channel, { mode: 'view' })
      await until(
        async () => (await frame.locator('body').evaluate((body) => body.innerHTML)) === bodyBefore,
      )
      await frame.locator('#pick').click()
      expect((await messages(page, channel)).filter((m) => m.type === 'target')).toHaveLength(0)
      await configure(page, channel, {})
      await frame.locator('#pick').click()
      await until(async () => (await messages(page, channel)).some((m) => m.type === 'target'))
      const target = (await messages(page, channel)).find((m) => m.type === 'target')!
      if (target.type !== 'target') throw new Error('Missing target')
      expect(target.anchor).toMatchObject({ kind: 'element', text: 'Choose this control' })
      expect(target.rect).toMatchObject({ x: 40, y: 40, width: 320 })
      await configure(page, channel, { mode: 'view', selected: target.anchor })
      await frame.locator('#text').hover()
      expect(await frame.locator('#pick').evaluate((button) => button.style.outlineWidth)).toBe(
        '2px',
      )
      await frame.evaluate(() => scrollTo(0, 20))
      await until(async () =>
        (await messages(page, channel)).some((m) => m.type === 'rect' && m.rect?.y === 20),
      )
      await page.locator('iframe').evaluate((iframe) => (iframe.style.width = '500px'))
      await until(async () =>
        (await messages(page, channel)).some((m) => m.type === 'rect' && m.rect?.width === 250),
      )
      await frame.evaluate(() => scrollTo(0, 500))
      await until(
        async () =>
          (await messages(page, channel)).filter((m) => m.type === 'rect').at(-1)?.rect === null,
      )
      const count = (await messages(page, channel)).filter((m) => m.type === 'target').length
      await configure(page, channel, { mode: 'view', reveal: { selector: '#bottom', request: 1 } })
      await until(
        async () =>
          await frame
            .locator('#bottom')
            .evaluate(
              (button) =>
                button.getBoundingClientRect().top < innerHeight &&
                button.style.outlineWidth === '2px',
            ),
      )
      expect((await messages(page, channel)).filter((m) => m.type === 'target')).toHaveLength(count)
      await configure(page, channel, {})
      await frame.locator('#text').scrollIntoViewIfNeeded()
      await frame.locator('#text').evaluate((p) => {
        const range = document.createRange()
        range.setStart(p.firstChild!, 0)
        range.setEnd(p.firstChild!, 4)
        getSelection()!.removeAllRanges()
        getSelection()!.addRange(range)
        document.dispatchEvent(new PointerEvent('pointerup'))
      })
      await until(async () =>
        (await messages(page, channel)).some(
          (m) => m.type === 'target' && m.anchor.kind === 'text',
        ),
      )
      const text = (await messages(page, channel)).find(
        (m) => m.type === 'target' && m.anchor.kind === 'text',
      )!
      if (text.type !== 'target') throw new Error('Missing text target')
      await configure(page, channel, { mode: 'view', selected: text.anchor })
      await frame.evaluate(() => getSelection()!.removeAllRanges())
      expect(
        await frame.evaluate(() =>
          [...CSS.highlights.get('ultimate-native-target')!].map((range) =>
            range instanceof Range ? range.toString() : null,
          ),
        ),
      ).toEqual(['Lock'])
      await configure(page, channel, { mode: 'view' })
      await until(async () => (await frame.evaluate(() => CSS.highlights.size)) === 0)
      expect(await frame.locator('body').evaluate((body) => body.innerHTML)).toBe(bodyBefore)
    },
  )
})

it('keeps hover and locked image boundaries visible inside a clipping ancestor without changing anchors or authored styles', async () => {
  await inFrame(
    `<style>body{margin:0}.clip{position:relative;overflow:hidden;width:calc(100vw - 60px);height:600px;margin:30px;border-radius:12px}img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}.caption{position:absolute;bottom:0;left:0;right:0;height:40px;background:#0008}</style>
    <main class="clip"><img id="picture" src="fill.png" alt="Selected image"><span class="caption">Caption</span></main>`,
    async (page, frame, channel) => {
      const iframe = page.locator('iframe')
      const image = frame.locator('#picture')
      await image.evaluate((img) => (img as HTMLImageElement).decode())
      const original = await frame.locator('body').evaluate((body) => body.innerHTML)
      const changedBoundary = async (before: Buffer, after: Buffer, edge: 'right' | 'bottom') => {
        const rect = await image.evaluate((img) => {
          const box = img.getBoundingClientRect()
          return { left: box.left, top: box.top, right: box.right, bottom: box.bottom }
        })
        return page.evaluate(
          async ({ before: baselinePng, after: selectedPng, rect: bounds, edge: side }) => {
            const pixels = async (base64: string) => {
              const bytes = Uint8Array.from(atob(base64), (value) => value.charCodeAt(0))
              const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }))
              const canvas = document.createElement('canvas')
              canvas.width = bitmap.width
              canvas.height = bitmap.height
              const context = canvas.getContext('2d')!
              context.drawImage(bitmap, 0, 0)
              bitmap.close()
              return context.getImageData(0, 0, canvas.width, canvas.height)
            }
            const a = await pixels(baselinePng)
            const b = await pixels(selectedPng)
            let changed = 0
            let total = 0
            const start =
              side === 'right'
                ? Math.max(16, Math.ceil(bounds.top) + 16)
                : Math.ceil(bounds.left) + 16
            const end =
              side === 'right' ? Math.min(a.height - 16, bounds.bottom - 16) : bounds.right - 16
            for (let offset = start; offset < end; offset++) {
              const x = side === 'right' ? Math.floor(bounds.right) - 2 : offset
              const y = side === 'right' ? offset : Math.floor(bounds.bottom) - 2
              const at = (y * a.width + x) * 4
              if ([0, 1, 2].some((component) => a.data[at + component] !== b.data[at + component]))
                changed++
              total++
            }
            return changed / total
          },
          { before: before.toString('base64'), after: after.toString('base64'), rect, edge },
        )
      }
      for (const width of [640, 390]) {
        await page.setViewportSize({ width: width === 390 ? 390 : 1000, height: 844 })
        await iframe.evaluate(
          (element, frameWidth) => (element.style.width = `${frameWidth}px`),
          width,
        )
        await configure(page, channel, { mode: 'view' })
        await frame.evaluate(() => scrollTo(0, 0))
        await page.mouse.move(10, 700)
        const baseline = await iframe.screenshot()
        await configure(page, channel, {})
        const rect = await image.boundingBox()
        const count = (await messages(page, channel)).filter(
          (message) => message.type === 'target',
        ).length
        await page.mouse.move(rect!.x + rect!.width / 2, 200)
        expect(await changedBoundary(baseline, await iframe.screenshot(), 'right')).toBeGreaterThan(
          0.8,
        )
        expect(
          (await messages(page, channel)).filter((message) => message.type === 'target'),
        ).toHaveLength(count)
        await page.mouse.click(rect!.x + rect!.width / 2, 200)
        await until(
          async () =>
            (await messages(page, channel)).filter((message) => message.type === 'target').length >
            count,
        )
        const target = (await messages(page, channel))
          .filter((message) => message.type === 'target')
          .at(-1)!
        if (target.type !== 'target') throw new Error('Missing image target')
        expect(target.anchor).toMatchObject({
          kind: 'element',
          text: '',
          selector: expect.stringContaining('img:nth-of-type(1)'),
        })
        await configure(page, channel, { mode: 'view', selected: target.anchor })
        await page.mouse.move(10, 700)
        expect(await changedBoundary(baseline, await iframe.screenshot(), 'right')).toBeGreaterThan(
          0.8,
        )
        await frame.evaluate(() => scrollTo(0, document.documentElement.scrollHeight))
        await until(async () =>
          (await messages(page, channel)).some(
            (message) => message.type === 'rect' && message.rect !== null && message.rect.y < 0,
          ),
        )
        const selectedBottom = await iframe.screenshot()
        await configure(page, channel, { mode: 'view' })
        const baselineBottom = await iframe.screenshot()
        expect(await changedBoundary(baselineBottom, selectedBottom, 'bottom')).toBeGreaterThan(0.8)
        expect(await frame.locator('body').evaluate((body) => body.innerHTML)).toBe(original)
      }
    },
    [
      {
        path: 'fill.png',
        mime: 'image/png',
        base64:
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4AWJiYGD4DwAAAP//cGajQwAAAAZJREFUAwABDgEC81VxbAAAAABJRU5ErkJggg==',
      },
    ],
  )
})

it.each([
  {
    kind: 'a scaled wrapper above clipping',
    html: '<div style="width:100px;transform:scale(2);transform-origin:0 0"><div style="overflow:hidden;width:100px"><button style="display:block;width:80px;height:20px;padding:0;border:0">Fits</button></div></div>',
  },
  {
    kind: 'an expanded overflow clip margin',
    html: '<div style="width:100px;height:40px;overflow:clip;overflow-clip-margin:40px"><button style="display:block;width:120px;height:20px;padding:0;border:0">Fits</button></div>',
  },
  {
    kind: 'viewport-propagated body overflow',
    html: '<style>html{overflow:visible}body{width:100px;overflow:hidden}</style><button style="display:block;width:120px;height:30px;padding:0;border:0">Fits</button>',
  },
  {
    kind: 'viewport overflow on the root',
    html: '<style>html{overflow:hidden;margin-left:100px;width:100px}</style><button style="display:block;position:relative;left:-60px;width:120px;height:30px;padding:0;border:0">Fits</button>',
  },
  {
    kind: 'a display:contents ancestor',
    html: '<div style="display:contents;overflow:hidden;width:100px;height:30px"><button style="display:block;width:80px;height:20px;padding:0;border:0">Fits</button></div>',
  },
  {
    kind: 'an ordinary inline ancestor',
    html: '<span style="overflow:hidden;width:100px;height:30px"><button style="display:block;width:80px;height:20px;padding:0;border:0">Fits</button></span>',
  },
])('omits unsupported clipping findings through $kind', async ({ html }) => {
  await inFrame(`<style>body{margin:0}</style>${html}`, async (page, frame, channel) => {
    const button = frame.getByRole('button', { name: 'Fits', exact: true })
    expect(
      await button.evaluate((element) => {
        const r = element.getBoundingClientRect()
        return [
          [r.left + 0.5, r.top + 0.5],
          [r.right - 0.5, r.top + 0.5],
          [r.left + 0.5, r.bottom - 0.5],
          [r.right - 0.5, r.bottom - 0.5],
        ].every(([x, y]) => document.elementFromPoint(x, y) === element)
      }),
    ).toBe(true)
    await button.click()
    await until(async () =>
      (await messages(page, channel)).some((message) => message.type === 'diagnostics'),
    )
    const observed = (await messages(page, channel))
      .filter((message) => message.type === 'diagnostics')
      .at(-1)!
    if (observed.type !== 'diagnostics') throw new Error('Missing measured diagnostics')
    expect(observed.pass.findings).toEqual([])
    expect(observed.pass.complete).toBe(false)
    expect(observed.pass.error).toBeTruthy()
  })
})

it('does not label a reachable viewport-fixed control unreachable through an ordinary clipping ancestor', async () => {
  await inFrame(
    `<style>body{margin:0}</style><div style="overflow:hidden;width:100px;height:30px"><button style="position:fixed;left:200px;top:100px;width:100px;height:30px">Reachable</button></div>`,
    async (page, frame, channel) => {
      const button = frame.getByRole('button', { name: 'Reachable', exact: true })
      expect(
        await button.evaluate((element) => {
          const rect = element.getBoundingClientRect()
          return (
            document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2) === element
          )
        }),
      ).toBe(true)
      await button.click()
      await until(async () =>
        (await messages(page, channel)).some((message) => message.type === 'diagnostics'),
      )
      const observed = (await messages(page, channel))
        .filter((message) => message.type === 'diagnostics')
        .at(-1)!
      if (observed.type !== 'diagnostics') throw new Error('Missing measured diagnostics')
      expect(observed.pass.findings).toEqual([])
      expect(observed.pass.complete).toBe(false)
      expect(observed.pass.error).toContain('clipping')
    },
  )
})

it('measures actual iframe geometry without flagging below-fold controls or intentional scrollers, then rechecks details', async () => {
  await inFrame(
    `<style>body{margin:0}.clip{overflow:hidden;width:100px;height:30px}.cut{display:block;width:150px;margin-left:80px}.scroll{overflow:auto;width:100px;height:40px}.inside{width:600px;height:30px}#reachable{margin-left:400px}#below{margin-top:800px}#wide{width:900px;height:10px}#change{width:20px;height:20px}#change:checked{width:200px}</style>
    <div class="clip"><button id="cut-button" class="cut">Button</button></div>
    <div class="clip"><input id="cut-input" class="cut" value="Input"></div>
    <div class="clip"><a id="cut-link" class="cut">Link</a></div>
    <div class="clip"><details open><summary id="cut-summary" class="cut">Summary</summary></details></div>
    <div style="overflow:clip;height:20px"><button id="unreachable" style="margin-top:50px">Unreachable</button></div>
    <div class="scroll"><div class="inside"><button id="reachable">Scroll to reach</button></div></div>
    <button id="below">Below fold</button><div id="wide"></div><div class="clip"><input id="change" type="checkbox"></div>
    <details id="details"><summary>Toggle details</summary><div class="clip"><button id="details-cut" class="cut">New measured control</button></div></details>`,
    async (page, frame, channel) => {
      await until(async () => (await messages(page, channel)).some((m) => m.type === 'diagnostics'))
      const passes = () =>
        messages(page, channel).then((all) => all.filter((m) => m.type === 'diagnostics'))
      const first = (await passes())[0]
      if (first.type !== 'diagnostics') throw new Error('Missing diagnostics')
      expect(first.pass.viewport).toEqual({ width: 640, height: 420 })
      expect(first.pass.complete).toBe(true)
      const ids = await frame.evaluate(
        (findings) =>
          findings.map((finding) => ({
            id: document.querySelector(finding.selector)?.id,
            rule: finding.rule,
          })),
        first.pass.findings,
      )
      expect(ids).toEqual(
        expect.arrayContaining([
          { id: 'wide', rule: 'page-horizontal-overflow' },
          { id: 'cut-button', rule: 'clipped-control' },
          { id: 'cut-input', rule: 'clipped-control' },
          { id: 'cut-link', rule: 'clipped-control' },
          { id: 'cut-summary', rule: 'clipped-control' },
          { id: 'unreachable', rule: 'unreachable-control' },
        ]),
      )
      expect(
        ids.some((finding) =>
          ['reachable', 'below', 'details-cut', 'change'].includes(finding.id ?? ''),
        ),
      ).toBe(false)
      await frame.locator('#details > summary').click()
      await until(async () => (await passes()).length >= 2)
      const last = (await passes()).at(-1)!
      if (last.type !== 'diagnostics') throw new Error('Missing later diagnostics')
      expect(
        await frame.evaluate(
          (findings) =>
            findings.some(
              (finding) => document.querySelector(finding.selector)?.id === 'details-cut',
            ),
          last.pass.findings,
        ),
      ).toBe(true)
      await frame.locator('#change').check()
      await until(async () => (await passes()).length >= 3)
      const changed = (await passes()).at(-1)!
      expect(
        await frame.evaluate(
          (findings) =>
            findings.some((finding) => document.querySelector(finding.selector)?.id === 'change'),
          changed.pass.findings,
        ),
      ).toBe(true)
    },
  )
})

it('keeps root-only non-rectangular clipping incomplete without inventing control findings', async () => {
  await inFrame(
    '<html style="clip-path:inset(0 0 90% 0)"><body style="margin:0;height:200px;padding-top:100px"><button>Save</button></body></html>',
    async (page, frame, channel) => {
      const geometry = await frame
        .getByRole('button', { name: 'Save', exact: true })
        .evaluate((button) => {
          const rect = button.getBoundingClientRect()
          return {
            clipPath: getComputedStyle(document.documentElement).clipPath,
            rootHeight: document.documentElement.getBoundingClientRect().height,
            top: rect.top,
            bottom: rect.bottom,
            hitControl:
              document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2) ===
              button,
          }
        })
      expect(geometry.clipPath).toContain('inset(')
      expect(geometry.top).toBeGreaterThan(geometry.rootHeight * 0.1)
      expect(geometry.bottom).toBeLessThan(420)
      expect(geometry.hitControl).toBe(false)
      await until(async () =>
        (await messages(page, channel)).some((message) => message.type === 'diagnostics'),
      )
      const observed = (await messages(page, channel)).find(
        (message) => message.type === 'diagnostics',
      )!
      if (observed.type !== 'diagnostics') throw new Error('Missing measured diagnostics')
      expect(observed.pass.findings).toEqual([])
      expect(observed.pass.complete).toBe(false)
      expect(observed.pass.error).toContain('non-rectangular')
    },
  )
})

it('reports a bounded incomplete pass rather than an all-clear for an oversized DOM', async () => {
  await inFrame('<span>content</span>'.repeat(2001), async (page, _frame, channel) => {
    await until(async () => (await messages(page, channel)).some((m) => m.type === 'diagnostics'))
    const pass = (await messages(page, channel)).find((m) => m.type === 'diagnostics')!
    if (pass.type !== 'diagnostics') throw new Error('Missing diagnostics')
    expect(pass.pass).toMatchObject({
      complete: false,
      viewport: { width: 640, height: 420 },
      error: expect.stringContaining('2,000-element limit'),
    })
  })
})
