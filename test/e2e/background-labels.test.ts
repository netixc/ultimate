// Regression: two long feature badges in a compact background row painted over each other on a phone.
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import type { FauxResponseFactory } from '@earendil-works/pi-ai/providers/faux'
import type { ConversationId } from '@earendil-works/pi-durable'
import { chromium } from 'playwright-core'
import { afterEach, expect, it } from 'vitest'
import { browserBinary } from '../../extensions/browser/server.ts'
import { Overview } from '../../extensions/conversations/overview.ts'
import { startSession, fileJournal, decide } from '../../extensions/dream/server.ts'
import { ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import { context } from '../../server/harness.ts'
import { fauxServer, post, removeTemp, sourceCopy, temp, until } from '../helpers.ts'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).toReversed()) await close()
})

it('fits long background labels and crowded phone status controls without collisions', async () => {
  const home = await temp('ultimate-background-labels-')
  cleanup.push(() => removeTemp(home))
  const root = await sourceCopy(home)
  const projectRoot = join(home, 'project')
  await mkdir(join(projectRoot, '.ultimate'), { recursive: true })
  await writeFile(join(projectRoot, '.ultimate/settings.json'), '{}')
  await writeFile(
    join(home, '.ultimate/settings.json'),
    JSON.stringify({ summaryModel: 'faux/faux-1', extensions: { disable: ['update'] } }),
  )
  const server = await fauxServer({
    ultimateRoot: root,
    projectRoot,
    localSetup: false,
    userHome: home,
    home: join(home, 'state'),
    port: 0,
  })
  cleanup.push(() => server.close())
  // sourceCopy links dependencies outside its root; serve the real font as well as the optimized JS.
  server.vite.config.server.fs.allow.push(resolve('node_modules'))
  const features = ['Mobile Server Switching', 'Android Notifications']
  const recipients: number[] = []
  const route: FauxResponseFactory = (transcript) => {
    server.host.faux!.appendResponses([route])
    const last = transcript.messages.findLast((message) => message.role !== 'system')!
    const text = typeof last.content === 'string' ? last.content : JSON.stringify(last.content)
    if (transcript.messages[0]?.role === 'system') {
      const system = JSON.stringify(transcript.messages[0].content)
      if (system.includes('Return only JSON')) {
        const feature = features.find((name) => text.includes(name)) ?? 'Background Updates'
        return fauxAssistantMessage(
          JSON.stringify({
            title: feature,
            feature,
            summary: 'Check the layout.',
            activity: 'Checked the layout.',
            abstract: 'Layout checked.',
          }),
        )
      }
    }
    if (last.role === 'user' && text === 'Send layout checks')
      return fauxAssistantMessage(
        recipients.map((id) =>
          fauxToolCall('message', { to: `#${id}`, text: 'Check the layout.', reply: false }),
        ),
        { stopReason: 'toolUse' },
      )
    return fauxAssistantMessage('Layout checked.')
  }
  server.host.faux!.setResponses([route])
  for (const feature of features) {
    const { data } = await post(server, '/api/conversations', { title: feature })
    const id = data.id as ConversationId
    recipients.push(id)
    const recipient = (await server.harness.conversation(id, context))!
    await (await recipient.submit({ type: 'input', content: feature }, context)).wait(context)
  }
  await until(async () => {
    const overview = await server.harness.snapshot(Overview, ROOT_CONVERSATION_ID, context)
    return recipients.every((id, index) => overview?.conversations[id]?.feature === features[index])
  })
  const { data } = await post(server, '/api/extensions/subagents/actions/standing', {
    args: { name: 'ultimate' },
  })
  const ultimate = data.result as ConversationId
  const conversation = (await server.harness.conversation(ultimate, context))!
  await (
    await conversation.submit({ type: 'input', content: 'Send layout checks' }, context)
  ).wait(context)

  // Real dream transitions, confined to this fixture: one proposal still waits on a decision.
  await server.harness.commit(async (tx) => {
    const session = await startSession(tx, Date.now())
    await fileJournal(
      tx,
      {
        session,
        learned: ['Check labels.', 'Keep controls reachable.', 'Verify on a phone.'],
        text: 'Layout fixture.',
        proposals: [
          { id: 'first', pass: 'project', title: 'First layout check' },
          { id: 'second', pass: 'project', title: 'Second layout check' },
        ],
      },
      Date.now(),
    )
    await decide(tx, { session, proposal: 'first', status: 'rejected' }, Date.now())
  }, context)

  const browser = await chromium.launch({
    executablePath: await browserBinary(),
    headless: true,
    env: { ...process.env, TMPDIR: undefined },
  })
  cleanup.push(() => browser.close())
  const page = await browser.newPage({ viewport: { width: 360, height: 800 } })
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto(`${server.url}/?conversation=${ultimate}`)
  const row = page
    .locator('[data-compact-background]')
    .filter({ has: page.locator('[data-feature="Mobile Server Switching"]') })
    .filter({ has: page.locator('[data-feature="Android Notifications"]') })
    .first()
  await row.waitFor()
  const status = page.locator('.status-line:visible').first()
  await status.locator('[data-dream-status]').waitFor()
  await status.getByRole('button', { name: 'project setup' }).waitFor()
  await page.evaluate(() => document.fonts.ready)
  for (const width of [320, 360, 412, 1280]) {
    await page.setViewportSize({ width, height: 800 })
    const layout = await row.evaluate((node) => {
      const box = node.getBoundingClientRect()
      const refs = [...node.querySelectorAll('[data-conversation-ref]')].map((ref) => {
        const rect = ref.getBoundingClientRect()
        const badge = ref.querySelector<HTMLElement>('[data-feature]')!
        const tag = badge.getBoundingClientRect()
        const id = ref.lastElementChild!
        const number = id.getBoundingClientRect()
        return {
          left: rect.left,
          right: rect.right,
          tagRight: tag.right,
          idLeft: number.left,
          idRight: number.right,
          title: badge.title,
          text: ref.textContent,
          truncated: badge.scrollWidth > badge.clientWidth,
        }
      })
      const footer = [...document.querySelectorAll('.status-line')].find(
        (element) => element.getBoundingClientRect().height > 0,
      )!
      const strip = footer.firstElementChild!
      const controls = [...strip.children].map((child) => child.getBoundingClientRect())
      const more = footer.querySelector('[aria-label="More status"]')?.getBoundingClientRect()
      return {
        statusOverlap: controls.some(
          (control, index) => index > 0 && controls[index - 1].right > control.left,
        ),
        statusOverflow: [...strip.children].some(
          (child) => child.scrollWidth > child.clientWidth + 1,
        ),
        statusScrolls: strip.scrollWidth > strip.clientWidth,
        moreRight: more?.right ?? 0,
        left: box.left,
        right: box.right,
        refs,
        triggerRight: node.parentElement!.getBoundingClientRect().right,
        scrollWidth: document.documentElement.scrollWidth,
        viewport: innerWidth,
      }
    })
    expect(layout.refs).toHaveLength(2)
    expect(layout.refs.map((ref) => ref.title)).toEqual(features)
    for (const ref of layout.refs) {
      expect(ref.text).toMatch(/#\d+$/)
      expect(ref.tagRight).toBeLessThanOrEqual(ref.idLeft)
      expect(ref.idRight).toBeLessThanOrEqual(ref.right + 1)
    }
    expect(layout.refs[0].right).toBeLessThanOrEqual(layout.refs[1].left)
    expect(layout.refs[1].right).toBeLessThanOrEqual(layout.right + 1)
    expect(layout.right).toBeLessThanOrEqual(layout.triggerRight - 12)
    expect(layout.scrollWidth).toBeLessThanOrEqual(layout.viewport)
    expect(layout.statusOverlap).toBe(false)
    expect(layout.statusOverflow).toBe(false)
    expect(layout.statusScrolls).toBe(width <= 412)
    expect(layout.moreRight).toBeLessThanOrEqual(layout.viewport)
    expect(layout.refs.some((ref) => ref.truncated)).toBe(width <= 412)
  }
  expect(errors).toEqual([])
})
