// First: helpers removes faux token pacing before server modules load.
import { apis, idleNeed, temp, until } from './helpers.ts'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { awaitWithContext } from '@earendil-works/chord/context'
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
} from '@earendil-works/pi-ai/providers/faux'
import type { FauxResponseFactory } from '@earendil-works/pi-ai/providers/faux'
import { AssistantEntry } from '@earendil-works/pi-durable'
import type { EntryId, Task } from '@earendil-works/pi-durable'
import type { JsonValue } from '@earendil-works/chord'
import { afterEach, expect, it, vi } from 'vitest'
import { context, prepareHarness } from '../server/harness.ts'
import type { OpenHost } from '../server/harness.ts'
import type { ExtensionHost } from '../server/extensions.ts'
import type { ActionContext } from '../server/actions.ts'
import { emit } from '../server/events.ts'
import { Metadata } from '../server/metadata.ts'
import subagents from '../extensions/subagents/server.ts'
import { Subagents } from '../extensions/subagents/api.ts'
import reviewRun, { actions, ReviewRuns } from '../.ultimate/extensions/review-run/server.ts'
import type { ReviewStatus } from '../.ultimate/extensions/review-run/refs.ts'
import { exec } from '../lib/exec.ts'

vi.mock('../lib/exec.ts', () => ({
  exec: vi.fn<ActionContext['exec']>(async () => ({ stdout: '', stderr: '' })),
}))
let opened: OpenHost | undefined
afterEach(async () => {
  await opened?.close()
  opened = undefined
})

it('freezes a review team atomically and resumes its existing reporters after reopen', async () => {
  const root = await temp('ultimate-review-run-')
  const userHome = await temp('ultimate-review-user-')
  await mkdir(join(root, 'agents'))
  const team = ['reviewer-one', 'reviewer-two']
  const definition = (name: string, body: string) =>
    `---\nname: ${name}\ndescription: Review\ntools: []\nisolate: none\n---\n${body}\n`
  for (const name of team)
    await writeFile(join(root, 'agents', `${name}.md`), definition(name, `Frozen ${name}`))
  const prepared = await prepareHarness({
    ultimateRoot: root,
    userHome,
    home: join(root, 'home'),
    faux: fauxProvider(),
  })
  const services = apis()
  const onOpen: (() => Promise<void>)[] = []
  const onClose: (() => Promise<void>)[] = []
  const host = {
    ...prepared,
    harness: () => opened!.harness,
    metadata: Metadata,
    implement: services.implement,
    need: ((api) =>
      services.provided.has(api.name)
        ? services.need(api)
        : idleNeed(api)) as ExtensionHost['need'],
    resource: (_key: string, create: () => unknown) => create(),
    extensions: () => [],
    notice: () => {},
    onOpen: (callback: () => Promise<void>) => onOpen.push(callback),
    onClose: (callback: () => Promise<void>) => onClose.push(callback),
    emit,
  } as unknown as ExtensionHost
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let entered = 0
  const backend = subagents(host)
  prepared.registry.install({
    ...backend,
    tasks: backend.tasks!.map((task) => {
      if (task.definition.name !== 'ultimate.subagent-reporter') return task
      const reporter = task as unknown as Task<JsonValue, { phase: string }, JsonValue, object>
      return {
        definition: {
          ...reporter.definition,
          phases: {
            ...reporter.definition.phases,
            deliver: async (...args: Parameters<typeof reporter.definition.phases.deliver>) => {
              entered++
              await awaitWithContext(gate, args[2])
              await reporter.definition.phases.deliver(...args)
            },
          },
        },
      }
    }),
  })
  prepared.registry.install(reviewRun(host))
  const route: FauxResponseFactory = (transcript) => {
    prepared.faux!.appendResponses([route])
    const last = transcript.messages.findLast((message) => message.role !== 'system')!
    if (
      last.role === 'user' &&
      typeof last.content === 'string' &&
      last.content.startsWith('CALL ')
    )
      return fauxAssistantMessage([fauxToolCall('review_run', JSON.parse(last.content.slice(5)))], {
        stopReason: 'toolUse',
      })
    return fauxAssistantMessage([fauxText('Review complete; no blocking findings.')])
  }
  prepared.faux!.setResponses([route])
  const open = async () => {
    opened = await prepared.open()
    const close = opened.close.bind(opened)
    opened.close = async () => {
      for (const callback of onClose) await callback()
      await close()
    }
    for (const callback of onOpen) await callback()
  }
  await open()
  const call = async (args: object) => {
    await (
      await opened!.root.submit({ type: 'input', content: `CALL ${JSON.stringify(args)}` }, context)
    ).wait(context)
    const view = await opened!.root.viewState(context)
    try {
      const result = view.value.entries.findLast((entry) => entry.kind === 'pi.tool-result')
        ?.model?.[0]
      expect(result?.role).toBe('toolResult')
      if (result?.role !== 'toolResult') throw new Error('Expected review_run result')
      if (result.isError) throw new Error(JSON.stringify(result.content))
      return result.details as ReviewStatus
    } finally {
      view.dispose()
    }
  }
  const request = {
    action: 'start',
    id: 'core-review',
    base: 'a'.repeat(40),
    head: 'b'.repeat(40),
    team,
    assignment: 'Review the selected range for correctness.',
  }
  const initial = await call(request)
  await until(() => entered === 2)
  expect(initial.members.map((member) => member.status)).toEqual(['pending', 'pending'])
  const frozen = (await opened!.harness.snapshot(ReviewRuns, opened!.root.id, context))!.runs[
    request.id
  ]
  expect(frozen).toMatchObject({
    base: request.base,
    head: request.head,
    assignment: request.assignment,
    members: team.map((name) => ({ definition: { name, instructions: `Frozen ${name}` } })),
  })
  await opened!.close()
  opened = undefined
  await writeFile(join(root, 'agents', `${team[0]}.md`), definition(team[0], 'Changed after start'))
  await open()
  const repeated = await call(request)
  expect(repeated.members.map((member) => member.conversationId)).toEqual(
    initial.members.map((member) => member.conversationId),
  )
  expect(
    (await opened!.harness.snapshot(ReviewRuns, opened!.root.id, context))!.runs[request.id],
  ).toEqual(frozen)
  expect(
    Object.keys((await opened!.harness.snapshot(Subagents, opened!.root.id, context))!.agents),
  ).toHaveLength(2)
  release()
  await until(async () => {
    const status = await actions.status({ id: request.id }, {
      host,
      conversationId: opened!.root.id,
    } as unknown as ActionContext)
    return status.members.every((member) => member.status === 'received')
  })
  const collected = await call({ action: 'status', id: request.id })
  for (const member of collected.members) {
    expect(member).toMatchObject({
      status: 'received',
      text: 'Review complete; no blocking findings.',
      failures: [],
    })
    expect(member.provider).toBeTruthy()
    expect(member.model).toBeTruthy()
    const answer = await opened!.harness.commit(
      (tx) => tx.entry(AssistantEntry, member.answerId as EntryId),
      context,
    )
    expect(answer?.model?.[0]).toMatchObject({ provider: member.provider, model: member.model })
  }
  await until(async () => {
    const view = await opened!.root.viewState(context)
    try {
      return view.value.entries.filter((entry) => entry.kind === 'subagents.report').length === 2
    } finally {
      view.dispose()
    }
  })
  await opened!.root.waitForIdle(context)
  const view = await opened!.root.viewState(context)
  try {
    for (const member of collected.members)
      expect(
        view.value.entries.filter(
          (entry) =>
            entry.kind === 'subagents.report' &&
            (entry.data as { sender?: number }).sender === member.conversationId,
        ),
      ).toHaveLength(1)
  } finally {
    view.dispose()
  }
  expect(exec).toHaveBeenCalledTimes(2)
})
