import { writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { configure, ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import { fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux'
import type { FauxResponseFactory } from '@earendil-works/pi-ai/providers/faux'
import { chromium } from 'playwright-core'
import { expect, it } from 'vitest'
import { browserBinary } from '../../extensions/browser/server.ts'
import { context } from '../../server/harness.ts'
import { git } from '../../lib/git.ts'
import { Workspaces } from '../../extensions/workspaces/workspaces.ts'
import type { FeedbackBundle } from '../../.ultimate/extensions/artifacts/types.ts'
import { fauxServer, post, temp, until } from '../helpers.ts'

const pixel = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4AWJiYGD4DwAAAP//cGajQwAAAAZJREFUAwABDgEC81VxbAAAAABJRU5ErkJggg==',
  'base64',
)

it('queues element, text, images and real issue fixes without waking the maker until explicit Send to Agent', async () => {
  const home = await temp('ultimate-native-workflow-')
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
  try {
    await git(server.host.projectRoot, 'init')
    await git(
      server.host.projectRoot,
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.com',
      'commit',
      '--allow-empty',
      '-m',
      'Initial commit',
    )
    expect(
      (await post(server, '/api/extensions/workspaces/actions/isolation', { args: null })).status,
    ).toBe(200)
    const index = await server.harness.snapshot(Workspaces, ROOT_CONVERSATION_ID, context)
    const lander = Object.values(index!.landerConversations)[0]
    expect(lander).toBeTypeOf('number')
    const owner = await server.harness.createConversation(
      { ownership: { kind: 'ownerless' } },
      context,
    )
    const agent = await server.root.agent(context)
    await server.harness.commit(
      (tx) =>
        configure(tx, owner.id, { model: agent.model, tools: [], cwd: server.host.projectRoot }),
      context,
    )
    await writeFile(
      join(server.host.projectRoot, 'workflow.html'),
      '<!doctype html><html><head><style>body{margin:16px;font:16px sans-serif}h1{margin-top:0}.wide{width:calc(100vw + 160px);text-align:right}.clip{width:120px;overflow:hidden}.clip button{margin-left:100px;width:140px}</style></head><body><h1>Review this heading</h1><p id="quote">Hello <strong>native</strong> reader.</p><div class="wide"><button>Escaped control</button></div><div class="clip"><button>Clipped control</button></div><p style="margin-top:1200px"><button>Reachable below the fold</button></p></body></html>',
    )
    const published = await post(server, '/api/extensions/artifacts/actions/publish', {
      conversationId: owner.id,
      args: { id: 'workflow', title: 'Native workflow', path: 'workflow.html' },
    })
    expect(published.status).toBe(200)
    const respond: FauxResponseFactory = () => {
      server.host.faux!.appendResponses([respond])
      return fauxAssistantMessage('The maker received the complete review.')
    }
    server.host.faux!.setResponses([respond])

    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    let feedbackCalls = 0
    let directSubmissions = 0
    page.on('request', (request) => {
      const path = new URL(request.url()).pathname
      if (/^\/api\/extensions\/(?:native-artifacts|artifacts)\/actions\/feedback$/.test(path))
        feedbackCalls++
      if (/^\/api\/conversations\/\d+\/submit$/.test(path)) directSubmissions++
    })
    await page.goto(`${server.url}/?conversation=${owner.id}`)
    await page.locator('[data-surface="native-artifacts"]').click()
    const frame = page.frameLocator('[data-artifact-frame] iframe')
    await frame.locator('h1').waitFor()
    const annotate = page.getByRole('switch', { name: 'Annotate', exact: true })
    if ((await annotate.getAttribute('aria-checked')) === 'true') await annotate.click()
    await frame.locator('h1').click()
    expect(await page.locator('[data-artifact-note]').count()).toBe(0)
    await annotate.click()
    await frame.locator('h1').hover()
    expect(await page.locator('[data-artifact-note]').count()).toBe(0)
    await frame.locator('h1').click()
    const note = page.locator('[data-artifact-note]')
    await note.getByRole('textbox', { name: 'Note for selection' }).fill('Element change')
    await note.locator('input[type=file]').setInputFiles({
      name: 'element.png',
      mimeType: 'image/png',
      buffer: pixel,
    })
    await note.getByRole('button', { name: 'Queue', exact: true }).click()
    const queue = page.locator('[data-artifact-queue]')
    await queue.getByText('Element change', { exact: true }).waitFor()
    expect(feedbackCalls).toBe(0)
    expect(directSubmissions).toBe(0)

    // Real pointer selection crosses a text-node boundary; no host-side selection substitute.
    const points = await frame.locator('#quote').evaluate((paragraph) => {
      const point = (node: Node, offset: number) => {
        const range = document.createRange()
        range.setStart(node, offset)
        range.collapse(true)
        const rect = range.getBoundingClientRect()
        return { x: rect.x, y: rect.y + rect.height / 2 }
      }
      return {
        start: point(paragraph.firstChild!, 2),
        end: point(paragraph.querySelector('strong')!.firstChild!, 3),
      }
    })
    const box = (await page.locator('[data-artifact-frame] iframe').boundingBox())!
    await page.mouse.move(box.x + points.start.x, box.y + points.start.y)
    await page.mouse.down()
    await page.mouse.move(box.x + points.end.x, box.y + points.end.y, { steps: 8 })
    expect(await note.count()).toBe(0)
    await page.mouse.up()
    await note.getByRole('textbox', { name: 'Note for selection' }).fill('Text change')
    await note.getByRole('button', { name: 'Queue', exact: true }).click()
    await queue.getByText('Text change', { exact: true }).waitFor()
    expect(feedbackCalls).toBe(0)
    expect(directSubmissions).toBe(0)

    await page.getByRole('button', { name: /Issues/ }).click()
    const issues = page.locator('[data-artifact-issues]')
    await issues.getByText('Page extends horizontally', { exact: true }).waitFor()
    // Like the phone sheet below, paint the overlay above the iframe before its first pointer.
    await issues.screenshot()
    await issues.getByRole('checkbox', { name: /^Select all/ }).check()
    await issues.getByRole('button', { name: 'Queue selected fixes', exact: true }).click()
    expect(feedbackCalls).toBe(0)
    expect(directSubmissions).toBe(0)
    const conversation = page.locator('[data-artifact-conversation]')
    await conversation.getByRole('textbox', { name: 'General message' }).fill('General change')
    await conversation.getByLabel('Attach images', { exact: true }).setInputFiles({
      name: 'general.png',
      mimeType: 'image/png',
      buffer: pixel,
    })
    await conversation.getByAltText('general.png', { exact: true }).waitFor()
    const destination = conversation.getByRole('textbox', { name: 'Feedback destination' })
    await destination.fill(String(lander))
    await conversation.getByText('none configured', { exact: true }).waitFor()
    expect(await conversation.locator(`[data-lander-log="${lander}"]`).count()).toBe(1)
    expect(
      await conversation.getByRole('button', { name: 'Send to Agent', exact: true }).count(),
    ).toBe(0)
    expect(await destination.isEnabled()).toBe(true)
    expect(feedbackCalls).toBe(0)
    expect(directSubmissions).toBe(0)
    await destination.fill(String(owner.id))
    await conversation.getByRole('textbox', { name: 'General message' }).waitFor()
    expect(await conversation.getByRole('textbox', { name: 'General message' }).inputValue()).toBe(
      'General change',
    )
    expect(
      await queue.getByRole('textbox', { name: 'Queued note 1', exact: true }).inputValue(),
    ).toBe('Element change')
    await queue.getByAltText('element.png', { exact: true }).waitFor()
    await conversation.getByAltText('general.png', { exact: true }).waitFor()
    expect(await destination.isEnabled()).toBe(true)

    // A failed acknowledgement freezes the exact batch, but newer edits/images must remain usable drafts.
    const requests: unknown[] = []
    await page.route('**/api/extensions/native-artifacts/actions/feedback', async (route) => {
      requests.push(route.request().postDataJSON())
      if (requests.length === 1)
        await route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'Acknowledgement unavailable' }),
        })
      else await route.continue()
    })
    await conversation.getByRole('button', { name: 'Send to Agent', exact: true }).click()
    await conversation.getByText(/Delivery not confirmed:/).waitFor()
    await queue.getByRole('textbox', { name: 'Queued note 1', exact: true }).fill('')
    await queue.getByLabel('Attach image to note 1', { exact: true }).setInputFiles({
      name: 'newer.png',
      mimeType: 'image/png',
      buffer: pixel,
    })
    await until(async () =>
      conversation.getByRole('button', { name: 'Send to Agent', exact: true }).isEnabled(),
    )
    const accepted = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === '/api/extensions/native-artifacts/actions/feedback',
    )
    await conversation.getByRole('button', { name: 'Send to Agent', exact: true }).click()
    const response = await accepted
    expect(response.status()).toBe(200)
    const bundle = (await response.json()).result as FeedbackBundle
    expect(bundle.state).toBe('delivered')
    expect(bundle.submissionId).toBeTypeOf('number')
    expect(bundle.notes.find((entry) => entry.text === 'Element change')?.anchor?.kind).toBe(
      'element',
    )
    expect(bundle.notes.find((entry) => entry.text === 'Text change')?.anchor).toMatchObject({
      kind: 'text',
      text: 'llo nat',
    })
    expect(bundle.notes.some((entry) => entry.text === 'General change')).toBe(true)
    expect(bundle.notes.some((entry) => !!entry.layoutIssueIds?.length)).toBe(true)
    expect(bundle.layoutIssues?.length).toBeGreaterThan(0)
    expect(bundle.images).toHaveLength(2)
    expect(bundle.images.find((image) => image.name === 'element.png')?.noteId).toBe(
      bundle.notes.find((entry) => entry.text === 'Element change')!.id,
    )
    expect(bundle.images.find((image) => image.name === 'general.png')?.noteId).toBeUndefined()
    await conversation
      .getByText('The maker received the complete review.', { exact: true })
      .waitFor()
    expect(feedbackCalls).toBe(2)
    expect(requests[1]).toEqual(requests[0])
    expect(directSubmissions).toBe(0)
    expect(
      await queue.getByRole('textbox', { name: 'Queued note 1', exact: true }).inputValue(),
    ).toBe('')
    await queue.getByAltText('newer.png', { exact: true }).waitFor()
    expect(
      await conversation.getByRole('button', { name: 'Send to Agent', exact: true }).isEnabled(),
    ).toBe(true)

    // The same workflow is available on a phone, rather than a squeezed permanent right column.
    await page.setViewportSize({ width: 390, height: 844 })
    const hide = page.getByRole('button', { name: 'Hide sidebar', exact: true })
    if (await hide.isVisible()) await hide.click()
    await frame.locator('h1').click()
    await note.getByRole('textbox', { name: 'Note for selection' }).fill('Phone draft')
    await note.getByRole('button', { name: 'Queue', exact: true }).click()
    const show = page.getByRole('button', { name: /Show sidebar/ })
    if (await show.isVisible()) await show.click()
    // The sidebar can be DOM-visible before the compositor updates iframe hit testing.
    // Capture the painted overlay before sending the next pointer.
    await conversation.screenshot()
    const queuedNotes = conversation.getByRole('button', { name: 'Queued notes', exact: true })
    expect(await queuedNotes.getAttribute('aria-expanded')).toBe('false')
    await queuedNotes.click()
    await queue.getByText('Phone draft', { exact: true }).waitFor()
    await until(
      async () =>
        await conversation.getByRole('button', { name: 'Send to Agent', exact: true }).isVisible(),
    )
    expect(feedbackCalls).toBe(2)
    expect(directSubmissions).toBe(0)
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true)
    expect(errors).toEqual([])
  } finally {
    await browser.close()
    await server.close()
  }
})
