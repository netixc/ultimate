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
import type { ConversationId, Task, Tx } from '@earendil-works/pi-durable'
import { AsyncLocalStorage } from 'node:async_hooks'
import { writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { abstract } from '../extensions/lineage/server.ts'
import { Messages } from '../extensions/messages/api.ts'
import { Subagents } from '../extensions/subagents/api.ts'
import { SubmissionLanded } from '../extensions/workspaces/api.ts'
import type { LandedData } from '../extensions/workspaces/api.ts'
import { emit, EventLog } from '../server/events.ts'
import { context } from '../server/harness.ts'
import { UiState } from '../server/ui-state.ts'
import { prepareFauxServer, until } from './helpers.ts'
import { branchFrom, fixture, notifyFixture, servers, settled, textOf } from './lineage-fixture.ts'
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
/** The conclude task of `submission`'s landing in `id`. */
const concludeTask = async (server: Server, id: ConversationId, submission: string) =>
  (
    await server.harness.commit(
      (tx) => tx.scanTasks({ conversationId: id, kind: 'lineage.conclude-landed' }, 10),
      context,
    )
  ).items.find((task) => (task.input as { submission: string }).submission === submission)
const concludeEnded = async (server: Server, id: ConversationId, submission: string) =>
  (await concludeTask(server, id, submission))?.state.status === 'terminal'
/** How far lineage's landing reactor has read the event log. */
const cursor = async (server: Server) =>
  (await server.harness.snapshot(EventLog, ROOT_CONVERSATION_ID, context))?.cursors[
    'lineage/landing-notes'
  ] ?? 0

it.concurrent('concludes a landed branch only when its report run answered, never after a Stop', async () => {
  const { server } = await notifyFixture()
  const id = await branchFrom(server, { from: 1, prompt: 'Land me' })
  const branch = await settled(server, id)
  // The lander's report starts a run that the person stops before it answers.
  await branch.submit({ type: 'input', content: 'HOLD', requestId: 'lander:s1' }, context)
  await until(async () => !!(await server.harness.snapshot(LiveDoc, id, context))?.run)
  await land(server, landing('s1', id))
  const run = (await server.harness.snapshot(LiveDoc, id, context))!.run!.taskId
  await server.harness.abortTask(run, context)
  await server.harness.waitForTask(run, context)
  expect(
    await server.harness.commit((tx) => tx.submissionByRequest(id, 'lander:s1'), context),
  ).toMatchObject({ status: 'unanswered', reason: 'aborted' })
  await until(() => concludeEnded(server, id, 's1'))
  expect(await concluded(server)).not.toContain(id)

  // A report that is answered concludes it.
  await branch.submit({ type: 'input', content: 'Landed.', requestId: 'lander:s2' }, context)
  await land(server, landing('s2', id))
  await until(async () => (await concluded(server)).includes(id))
})
it.concurrent.each([false, true])('drains landed replies (explicit=%s)', async (explicit) => {
  let parent: ConversationId
  let child: ConversationId
  let decisions = 0
  let callbackDecisions = 0
  const parentGate = Promise.withResolvers<void>()
  const replyGate = Promise.withResolvers<void>()
  const callbackGate = Promise.withResolvers<void>()
  const recoveryGate = Promise.withResolvers<void>()
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
    const lineage = prepared.host.registry.snapshot().extension('lineage')!
    prepared.host.registry.install(
      defineExtension({
        ...lineage,
        tasks: lineage.tasks!.map((registration) => {
          if (registration.definition.name !== 'lineage.conclude-landed') return registration
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
                            // The original code has no replies phase: its final conclude commit is the red boundary.
                            if (phase === 'replies' || phase === 'conclude') {
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
    const route: FauxResponseFactory = async (transcript) => {
      prepared.host.faux!.appendResponses([route])
      const last = transcript.messages.findLast((message) => message.role !== 'system')!
      const text = textOf(last.content)
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
    await branch.submit(
      { type: 'input', content: 'Landed.', requestId: 'lander:callback' },
      context,
    )
    await land(server, landing('callback', parent))
    await until(async () => {
      const task = await concludeTask(server, parent, 'callback')
      return (
        task?.state.status === 'running' &&
        (task.state.checkpoint as { phase: string }).phase === 'wait-report'
      )
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
    await until(
      async () => callbackDecisions > 0 || (await concludeEnded(server, parent, 'callback')),
    )
    expect((await concludeTask(server, parent, 'callback'))?.state).toMatchObject({
      status: 'running',
    })
    expect(
      await concluded(server),
      'the callback answer still owes the parent its recovered report',
    ).not.toContain(parent)
    await until(() => callbackHeld)
    recoveryGate.resolve()
    callbackGate.resolve()
    await until(() => concludeEnded(server, parent, 'callback'))
    expect((await concludeTask(server, parent, 'callback'))?.state).toMatchObject({
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
    expect(await concluded(server)).toContain(parent)
  } finally {
    parentGate.resolve()
    replyGate.resolve()
    recoveryGate.resolve()
    callbackGate.resolve()
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
