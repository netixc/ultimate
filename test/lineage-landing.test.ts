import { awaitWithContext } from '@earendil-works/chord/context'
import type { JsonValue } from '@earendil-works/chord'
import { Type } from '@earendil-works/pi-ai'
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import type { FauxResponseFactory } from '@earendil-works/pi-ai/providers/faux'
import {
  defineExtension,
  defineTool,
  InboxDoc,
  LiveDoc,
  ROOT_CONVERSATION_ID,
} from '@earendil-works/pi-durable'
import type { ConversationId, Task, TaskId, Tx } from '@earendil-works/pi-durable'
import { AsyncLocalStorage } from 'node:async_hooks'
import { writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { abstract } from '../extensions/lineage/server.ts'
import { Messages } from '../extensions/messages/api.ts'
import { Subagents } from '../extensions/subagents/api.ts'
import { SubmissionLanded } from '../extensions/workspaces/api.ts'
import { Workspaces } from '../extensions/workspaces/workspaces.ts'
import type { createLander } from '../extensions/workspaces/lander.ts'
import type { LandedData } from '../extensions/workspaces/api.ts'
import { emit, EventLog } from '../server/events.ts'
import { context } from '../server/harness.ts'
import { UiState } from '../server/ui-state.ts'
import { prepareFauxServer, until } from './helpers.ts'
import { branchFrom, fixture, servers, settled, textOf } from './lineage-fixture.ts'
import type { Server } from './lineage-fixture.ts'

const landing = (submission: string, conversationId: number): LandedData => ({
  submission,
  conversationId,
  at: 3,
  sha: `${submission}abcdef0`,
  base: '0000000',
  target: 'main',
  lander: 2,
  divergence: 'None',
  title: 'Land me',
  feature: 'Landing',
  commits: [{ sha: 'abc1234', subject: `feat: ${submission}` }],
  commitCount: 12,
  paths: ['landed.txt'],
})
const land = async (server: Server, data: LandedData) =>
  (await server.harness.commit((tx) => emit(tx, SubmissionLanded, data), context)).id
const notes = async (server: Server) =>
  (await server.root.context(context)).entries.filter((entry) => entry.kind === 'lineage.note')
const concluded = async (server: Server) =>
  ((await server.harness.snapshot(UiState, ROOT_CONVERSATION_ID, context))?.[
    'ext.conversations.concluded'
  ] ?? []) as number[]
/** Seed the finished Git receipt; run the real registered lander from next through report/deliver/release. */
async function reportLanding(server: Server, id: ConversationId) {
  const lander = await server.harness.createConversation(
    { ownership: { kind: 'ownerless' } },
    context,
  )
  const task = server.host.registry
    .snapshot()
    .extension('workspaces')!
    .tasks!.find((item) => item.definition.name === 'workspaces.lander')! as ReturnType<
    typeof createLander
  >
  return server.harness.commit(async (tx) => {
    const index = await tx.doc(Workspaces, ROOT_CONVERSATION_ID)
    index.pendingReports.callback = {
      source: 'callback-test',
      conversationId: id,
      text: 'Landed.',
      outcome: {
        outcome: 'landed',
        sha: 'abcdef0',
        base: '0000000',
        target: 'main',
        tip: 'abcdef0',
        at: 3,
        divergence: 'None',
        lander: lander.id,
        steps: [],
      },
    }
    return tx.createTask(
      task,
      { source: 'callback-test' },
      {
        conversationId: lander.id,
        ownership: { kind: 'conversation' },
      },
    )
  }, context)
}
const landerTask = (server: Server, id: TaskId) =>
  server.harness.commit((tx) => tx.task(id), context)
const landerEnded = async (server: Server, id: TaskId) =>
  (await landerTask(server, id))?.state.status === 'terminal'
/** How far lineage's landing reactor has read the event log. */
const cursor = async (server: Server) =>
  (await server.harness.snapshot(EventLog, ROOT_CONVERSATION_ID, context))?.cursors[
    'lineage/landing-notes'
  ] ?? 0

it.concurrent('keeps a branch open when its run active at landing is stopped before the decision', async () => {
  const ordinaryGate = Promise.withResolvers<void>()
  const ordinaryHeld = Promise.withResolvers<void>()
  const reportGate = Promise.withResolvers<void>()
  const reportHeld = Promise.withResolvers<void>()
  const setup = (prepared: Awaited<ReturnType<typeof prepareFauxServer>>) => {
    const extension = prepared.host.registry.snapshot().extension('workspaces')!
    prepared.host.registry.install(
      defineExtension({
        ...extension,
        tasks: extension.tasks!.map((registration) => {
          if (registration.definition.name !== 'workspaces.lander') return registration
          const task = registration as ReturnType<typeof createLander>
          const report = task.definition.phases.report
          return {
            definition: {
              ...task.definition,
              phases: {
                ...task.definition.phases,
                report: async (...args: Parameters<typeof report>) => {
                  if (args[0].state.checkpoint.frontier) {
                    reportHeld.resolve()
                    await awaitWithContext(reportGate.promise, args[2])
                  }
                  await report(...args)
                },
              },
            },
          }
        }),
      }),
    )
    const route: FauxResponseFactory = async (transcript, options) => {
      prepared.host.faux!.appendResponses([route])
      const last = transcript.messages.findLast((message) => message.role === 'user')!
      if (textOf(last.content) === 'Ordinary work') {
        ordinaryHeld.resolve()
        await Promise.race([
          ordinaryGate.promise,
          new Promise((_, reject) =>
            options?.signal?.addEventListener('abort', () => reject(new Error('aborted'))),
          ),
        ])
      }
      return fauxAssistantMessage('Answered.')
    }
    return route
  }
  const { server } = await fixture(undefined, setup)
  const id = await branchFrom(server, { from: 1, prompt: 'Land me' })
  const branch = await settled(server, id)
  try {
    // No requestId: track the Pi input receipt itself, not a message-specific address.
    const input = await branch.submit({ type: 'input', content: 'Ordinary work' }, context)
    await ordinaryHeld.promise
    const run = (await server.harness.snapshot(LiveDoc, id, context))!.run!.taskId
    const task = await reportLanding(server, id)
    await reportHeld.promise
    const frontier = (await server.harness.snapshot(Workspaces, ROOT_CONVERSATION_ID, context))!
      .pendingReports.callback.frontier!
    expect(frontier.runs).toContainEqual({ conversationId: id, inputs: [input.id] })
    await server.harness.abortTask(run, context)
    await server.harness.waitForTask(run, context)
    expect(await input.wait(context)).toMatchObject({ status: 'unanswered', reason: 'aborted' })
    await branch.waitForIdle(context)
    expect((await server.harness.snapshot(LiveDoc, id, context))!.run).toBeUndefined()
    reportGate.resolve()
    await until(() => landerEnded(server, task))
    expect((await landerTask(server, task))!.state).toMatchObject({
      status: 'terminal',
      outcome: { status: 'completed' },
    })
    expect(await concluded(server)).not.toContain(id)
    expect(
      (await server.harness.snapshot(Workspaces, ROOT_CONVERSATION_ID, context))!.pendingReports,
    ).toEqual({})
  } finally {
    ordinaryGate.resolve()
    reportGate.resolve()
  }
})

it.concurrent.each([
  { explicit: false, late: 'none' },
  { explicit: true, late: 'none' },
  { explicit: false, late: 'answered' },
  { explicit: false, late: 'error' },
  { explicit: false, late: 'aborted' },
  { explicit: false, late: 'question' },
])('drains landed replies (explicit=$explicit, late=$late)', async ({ explicit, late }) => {
  let parent: ConversationId
  let child: ConversationId
  let decisions = 0
  let callbackDecisions = 0
  const parentGate = Promise.withResolvers<void>()
  const replyGate = Promise.withResolvers<void>()
  const callbackGate = Promise.withResolvers<void>()
  const recoveryGate = Promise.withResolvers<void>()
  const newWorkGate = Promise.withResolvers<void>()
  let newWorkHeld = false
  const recoveryContext = new AsyncLocalStorage<boolean>()
  let parentHeld = false
  let replyHeld = 0
  let callbackHeld = false
  let recoveryHeld = false
  let explicitlyAnswered = false
  const setup = (prepared: Awaited<ReturnType<typeof prepareFauxServer>>) => {
    const open = prepared.host.open.bind(prepared.host)
    vi.spyOn(prepared.host, 'open').mockImplementation(async (...args) => {
      const opened = await open(...args)
      const subscribe = opened.harness.subscribeCommits.bind(opened.harness)
      vi.spyOn(opened.harness, 'subscribeCommits').mockImplementation((listener) =>
        subscribe((publication, ctx) =>
          recoveryContext.run(
            publication.changes.some(
              (change) =>
                change.type === 'submission' &&
                change.value.conversationId === child &&
                change.value.status === 'done' &&
                change.value.requestId?.startsWith('board-reply:'),
            ),
            () => listener(publication, ctx),
          ),
        ),
      )
      const commit = opened.harness.commit.bind(opened.harness)
      vi.spyOn(opened.harness, 'commit').mockImplementation(async (change, ctx) => {
        // Async recovery inherits the subscriber's context. Wait BEFORE entering its transaction;
        // reads and the lineage settlement's synchronous recoverIn remain free to run.
        if (recoveryContext.getStore()) {
          recoveryHeld = true
          await awaitWithContext(recoveryGate.promise, ctx)
        }
        return commit(change, ctx)
      })
      return opened
    })
    prepared.host.registry.install(
      defineExtension({
        name: 'landing-hold',
        tools: [
          defineTool({
            name: 'landing_hold',
            description: 'Hold the parent while the child asks its question',
            parameters: Type.Object({}),
            replay: 'safe',
            execute: async (_args, _api, ctx) => {
              parentHeld = true
              await awaitWithContext(parentGate.promise, ctx)
              return { output: [{ type: 'text', text: 'parent released' }] }
            },
          }),
        ],
      }),
    )
    // Keep the real task phases: only suspend their entry, as messages/subagents tests do.
    const holdPhase = (
      extension: string,
      name: string,
      phase: string,
      held: () => void,
      gate: Promise<void>,
      matches: (input: JsonValue) => boolean = () => true,
    ) => {
      const existing = prepared.host.registry.snapshot().extension(extension)!
      prepared.host.registry.install(
        defineExtension({
          ...existing,
          tasks: existing.tasks!.map((registration) => {
            if (registration.definition.name !== name) return registration
            const task = registration as unknown as Task<
              JsonValue,
              { phase: string },
              JsonValue,
              object
            >
            return {
              definition: {
                ...task.definition,
                phases: {
                  ...task.definition.phases,
                  [phase]: async (...args: Parameters<typeof task.definition.phases.reply>) => {
                    if (matches(args[0].input)) {
                      held()
                      await awaitWithContext(gate, args[2])
                    }
                    await task.definition.phases[phase](...args)
                  },
                },
              },
            }
          }),
        }),
      )
    }
    holdPhase(
      'messages',
      'board.delivery',
      'reply',
      () => {
        replyHeld++
      },
      replyGate.promise,
    )
    holdPhase(
      'subagents',
      'ultimate.subagent-reporter',
      'report',
      () => {
        callbackHeld = true
      },
      callbackGate.promise,
      (input) => (input as { answer?: number }).answer !== undefined,
    )
    const lineage = prepared.host.registry.snapshot().extension('workspaces')!
    prepared.host.registry.install(
      defineExtension({
        ...lineage,
        tasks: lineage.tasks!.map((registration) => {
          if (registration.definition.name !== 'workspaces.lander') return registration
          const task = registration as unknown as Task<
            JsonValue,
            { phase: string },
            JsonValue,
            object
          >
          return {
            definition: {
              ...task.definition,
              phases: Object.fromEntries(
                Object.entries(task.definition.phases).map(([phase, run]) => [
                  phase,
                  async (...args: Parameters<typeof run>) => {
                    const runtime = new Proxy(args[1], {
                      get(target, key) {
                        if (key === 'commit')
                          return async (...commitArgs: Parameters<typeof target.commit>) => {
                            await target.commit(...commitArgs)
                            // Observe a completed settlement decision, including one that stays pending.
                            if (phase === 'report') {
                              decisions++
                              if (recoveryHeld) callbackDecisions++
                            }
                          }
                        const value = Reflect.get(target, key) as unknown
                        return typeof value === 'function' ? value.bind(target) : value
                      },
                    })
                    await run(args[0], runtime, args[2])
                  },
                ]),
              ),
            },
          }
        }),
      }),
    )
    const route: FauxResponseFactory = async (transcript, options) => {
      prepared.host.faux!.appendResponses([route])
      const last = transcript.messages.findLast((message) => message.role !== 'system')!
      const text = textOf(last.content)
      if (text === 'New work') {
        if (late === 'aborted') {
          newWorkHeld = true
          await Promise.race([
            newWorkGate.promise,
            new Promise((_, reject) =>
              options?.signal?.addEventListener('abort', () => reject(new Error('aborted'))),
            ),
          ])
        }
        return fauxAssistantMessage(
          'New work answered.',
          late === 'error' ? { stopReason: 'error', errorMessage: 'Provider failed' } : {},
        )
      }
      if (
        explicit &&
        !explicitlyAnswered &&
        transcript.messages.some(
          (message) => message.role === 'user' && textOf(message.content).includes('May I finish?'),
        )
      ) {
        // The provider may see placement before delivery has marked the question read.
        await until(async () =>
          (await server.harness.snapshot(Messages, ROOT_CONVERSATION_ID, context))!.messages.some(
            (message) =>
              message.from === child && message.to === parent && message.state === 'delivered',
          ),
        )
        explicitlyAnswered = true
        return fauxAssistantMessage(
          [
            fauxToolCall(
              'message',
              { to: `#${child}`, text: 'Parent answered.', reply: true },
              { id: 'explicit-parent-answer' },
            ),
          ],
          { stopReason: 'toolUse' },
        )
      }
      if (last.role === 'toolResult') {
        if (last.toolName === 'subagent')
          return fauxAssistantMessage([fauxToolCall('landing_hold', {})], { stopReason: 'toolUse' })
        return fauxAssistantMessage(
          last.toolName === 'message' && last.toolCallId !== 'explicit-parent-answer'
            ? 'Child asked.'
            : 'Parent answered.',
        )
      }
      if (text === 'Start child')
        return fauxAssistantMessage(
          [
            fauxToolCall('subagent', {
              action: 'start',
              agent: 'landing-child',
              task: `Ask #${parent}`,
              background: true,
              isolate: 'none',
            }),
          ],
          { stopReason: 'toolUse' },
        )
      if (text === `Ask #${parent}`)
        return fauxAssistantMessage(
          [
            fauxToolCall('message', {
              to: `#${parent}`,
              text: 'May I finish?',
              reply: true,
              steer: false,
            }),
          ],
          { stopReason: 'toolUse' },
        )
      return fauxAssistantMessage(
        text.startsWith('Reply from ') ? 'Child finished callback.' : 'Parent answered.',
      )
    }
    return route
  }
  let { server, home } = await fixture(undefined, setup)
  await mkdir(join(home, '.ultimate/agents'), { recursive: true })
  await writeFile(
    join(home, '.ultimate/agents/landing-child.md'),
    '---\nname: landing-child\ndescription: Ask the parent a question\nmodel: faux/faux-1\nisolate: none\n---\nAsk and report.\n',
  )
  parent = await branchFrom(server, { from: 1, prompt: 'Land me' })
  let branch = await settled(server, parent)
  try {
    await branch.submit({ type: 'input', content: 'Start child' }, context)
    await until(() => parentHeld)
    await until(async () =>
      (await server.harness.snapshot(InboxDoc, parent, context))!.items.some(
        (item) => item.entry?.kind === 'board.message',
      ),
    )
    child = Object.values((await server.harness.snapshot(Subagents, parent, context))!.agents)[0]
      .conversationId
    await settled(server, child)
    const landingTask = await reportLanding(server, parent)
    await until(async () => {
      return !!(await server.harness.snapshot(Workspaces, ROOT_CONVERSATION_ID, context))
        ?.pendingReports.callback?.frontier
    })
    parentGate.resolve()
    await until(() => replyHeld > 0)
    await branch.waitForIdle(context)
    await settled(server, child)

    await until(() => decisions > 0)
    expect(
      await concluded(server),
      'an admitted reply still owes the idle child its callback',
    ).not.toContain(parent)

    let newWorkStatus: string | undefined
    let stopped = false
    if (late === 'question') {
      await server.harness.commit(async (tx) => {
        const log = await tx.doc(Messages, ROOT_CONVERSATION_ID)
        log.messages.push({
          id: log.next++,
          from: parent,
          to: 'user',
          text: 'Which?',
          at: 1,
          reply: true,
          state: 'delivered',
        })
      }, context)
    } else if (late !== 'none') {
      const submission = await branch.submit(
        { type: 'input', content: 'New work', requestId: 'new-work' },
        context,
      )
      if (late === 'aborted') {
        await until(() => newWorkHeld)
        const run = (await server.harness.snapshot(LiveDoc, parent, context))!.run!.taskId
        await server.harness.abortTask(run, context)
        await server.harness.waitForTask(run, context)
      }
      const result = await submission.wait(context)
      stopped = result.status === 'unanswered' && result.reason === 'aborted'
      newWorkStatus = result.status
    }
    expect(newWorkStatus).toBe(
      late === 'none' || late === 'question'
        ? undefined
        : late === 'answered'
          ? 'done'
          : 'unanswered',
    )

    expect(stopped).toBe(late === 'aborted')

    // Reopen the durable home with the callback still held. Setup runs before tasks resume,
    // so neither the reply nor the settlement can slip through the test gates on startup.
    const replyAttempts = replyHeld
    await server.close()
    servers.splice(servers.indexOf(server), 1)
    ;({ server } = await fixture(home, setup))
    branch = (await server.harness.conversation(parent, context))!
    await until(() => replyHeld > replyAttempts)
    replyGate.resolve()
    await until(() => recoveryHeld)
    await settled(server, child)
    await until(async () => callbackDecisions > 0 || (await landerEnded(server, landingTask)))
    expect((await landerTask(server, landingTask))?.state).toMatchObject({
      status: 'running',
    })
    expect(
      await concluded(server),
      'the callback answer still owes the parent its recovered report',
    ).not.toContain(parent)
    await until(() => callbackHeld)
    recoveryGate.resolve()
    callbackGate.resolve()
    await until(() => landerEnded(server, landingTask))
    expect((await landerTask(server, landingTask))?.state).toMatchObject({
      status: 'terminal',
      outcome: { status: 'completed' },
    })
    await branch.waitForIdle(context)
    const entries = (await branch.context(context)).entries
    const reports = entries.filter((entry) => entry.kind === 'subagents.report')
    expect(reports.map((entry) => (entry.data as { body: string }).body)).toEqual([
      'Returned model: faux/faux-1\nChild asked.',
      'Returned model: faux/faux-1\nChild finished callback.',
    ])
    const childEntries = (
      await (await server.harness.conversation(child, context))!.context(context)
    ).entries
    expect(childEntries.filter((entry) => entry.kind === 'board.reply')).toHaveLength(1)
    expect((await concluded(server)).includes(parent)).toBe(late === 'none')
  } finally {
    parentGate.resolve()
    replyGate.resolve()
    recoveryGate.resolve()
    callbackGate.resolve()
    newWorkGate.resolve()
  }
})

it.concurrent('notes a landing in its tree root once, across a failed attempt and a restart', async () => {
  const { server, home } = await fixture()
  const first = await branchFrom(server, { from: 1, prompt: 'Land me' })
  await settled(server, first)
  await server.harness.commit((tx) => abstract(tx, first, { text: 'State: done.', at: 3 }), context)

  // The reactor's first attempt fails after it placed the note, as a crash before its commit would.
  let failed = false
  const commit = server.harness.commit.bind(server.harness)
  const spy = vi.spyOn(server.harness, 'commit').mockImplementation((change, ctx) =>
    commit(async (tx) => {
      let noted = false
      const watched = new Proxy(tx, {
        get(target, key) {
          const value = Reflect.get(target, key) as unknown
          if (key === 'appendEntry')
            return (...args: Parameters<Tx['appendEntry']>) => {
              if ((args[1] as { kind?: string }).kind === 'lineage.note') noted = true
              return target.appendEntry(...args)
            }
          return typeof value === 'function' ? value.bind(target) : value
        },
      })
      const result = await change(watched)
      if (noted && !failed) {
        failed = true
        throw new Error('crashed before commit')
      }
      return result
    }, ctx),
  )
  const before = await cursor(server)
  await land(server, landing('s1', first))
  await until(() => failed)
  // The failed attempt rolled back its note and its cursor: the event stays pending.
  expect(await notes(server)).toHaveLength(0)
  expect(await cursor(server)).toBe(before)

  // The next landing retries it: each note is written once, the first freezing the open abstract.
  const second = await land(server, landing('s2', first))
  await until(async () => (await notes(server)).length === 2)
  const [one, two] = await notes(server)
  expect(one.data).toEqual({
    at: 3,
    divergence: 'None',
    sha: 's1abcdef0',
    base: '0000000',
    target: 'main',
    commits: [{ sha: 'abc1234', subject: 'feat: s1' }],
    paths: ['landed.txt'],
    title: 'Land me',
    more: 11,
    lander: 2,
    feature: 'Landing',
    text: `Landed s1abcde on main from #${first}/3 Land me (Landing):\nDiverged: None\nfeat: s1\nand 11 more\nChanged: landed.txt`,
    from: first,
    source: 'lander',
    abstract: { at: 3, text: 'State: done.' },
  })
  expect((two.data as { sha: string }).sha).toBe('s2abcdef0')
  await until(async () => (await cursor(server)) >= second)

  // A restart on the same home catches up from the cursor and writes nothing again.
  spy.mockRestore()
  await server.close()
  servers.splice(servers.indexOf(server), 1)
  const reopened = (await fixture(home)).server
  const third = await land(reopened, landing('s3', first))
  await until(async () => (await cursor(reopened)) >= third)
  expect((await notes(reopened)).map((note) => (note.data as { sha: string }).sha)).toEqual([
    's1abcdef0',
    's2abcdef0',
    's3abcdef0',
  ])
})
