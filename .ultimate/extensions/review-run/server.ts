import { Type } from '@earendil-works/pi-ai'
import { AgentDoc, defineDoc, defineExtension, defineTool } from '@earendil-works/pi-durable'
import type { ConversationId, Tx } from '@earendil-works/pi-durable'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import type { ExtensionHost } from '../../../server/extensions.ts'
import { discoverAgents, hasLogin } from '../../../lib/agents.ts'
import type { AgentDefinition } from '../../../lib/agents.ts'
import { implementAction } from '../../../lib/actions.ts'
import { exec } from '../../../lib/exec.ts'
import { SubagentsApi } from '../../../extensions/subagents/api.ts'
import { Runs, Status } from './refs.ts'
import type { ReviewStatus } from './refs.ts'

type FrozenDefinition = { [Key in keyof AgentDefinition]: AgentDefinition[Key] }
type Run = {
  base: string
  head: string
  assignment: string
  members: {
    definition: FrozenDefinition
    conversationId: ConversationId
    model?: { provider: string; modelId: string }
  }[]
}
export const ReviewRuns = defineDoc<{ runs: Record<string, Run> }>({
  kind: Runs.kind,
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  checkpointWhen: () => false,
  initial: () => ({ runs: {} }),
})
export const docs = [ReviewRuns]

async function collect(tx: Tx, host: ExtensionHost, parent: ConversationId, id: string) {
  const runs = (await tx.doc(ReviewRuns, parent)).runs
  const run = Object.hasOwn(runs, id) ? runs[id] : undefined
  if (!run) throw new Error(`Unknown review run: ${id}`)
  const replies = await host.need(SubagentsApi).replies(
    tx,
    parent,
    run.members.map((member) => member.conversationId),
  )
  return {
    id,
    base: run.base,
    head: run.head,
    assignment: run.assignment,
    members: run.members.map((member, index) => ({
      name: member.definition.name,
      ...replies[index],
    })),
  } satisfies ReviewStatus
}
export const actions = {
  status: implementAction(Status, async (args, { host, conversationId }) => {
    const id = args && typeof args === 'object' && !Array.isArray(args) ? args.id : undefined
    if (!conversationId || typeof id !== 'string')
      throw new Error('Expected run id and conversation')
    return host
      .harness()
      .commit((tx) => collect(tx, host, conversationId as ConversationId, id), BACKGROUND_CONTEXT)
  }),
}

export default function reviewRun(host: ExtensionHost) {
  return defineExtension({
    name: 'review-run',
    tools: [
      defineTool({
        name: 'review_run',
        description:
          'Explicit review-team execution, never approval or a submission gate. start {id,base,head,team,assignment} freezes full commit SHAs, the explicitly selected reviewer-* definitions and one shared assignment; starts all transactionally through subagents. Repeating the same id resumes that run, never changed definitions or duplicate children. status {id} collects actual replies with answer IDs, returned provider/model, prior failures and pending/failed/missing states. Existing subagent reports arrive normally; received is not approved. Continue failed/missing children with subagent message, then collect again. No automatic retry or acceptance. A new range or team needs a new id.',
        // The run snapshot and every subagent receipt commit atomically; replay only reads the same run.
        replay: 'safe',
        parameters: Type.Object({
          action: Type.Union([Type.Literal('start'), Type.Literal('status')]),
          id: Type.String({ minLength: 1, pattern: '^[a-zA-Z0-9_-]+$' }),
          base: Type.Optional(Type.String()),
          head: Type.Optional(Type.String()),
          team: Type.Optional(Type.Array(Type.String(), { minItems: 1, uniqueItems: true })),
          assignment: Type.Optional(Type.String()),
        }),
        execute: async (args, api, context) => {
          if (args.id === '__proto__') throw new Error('Invalid review run id')
          const parent = api.conversationId
          const snapshot = (await api.snapshot(ReviewRuns, parent, context))?.runs ?? {}
          const existing = Object.hasOwn(snapshot, args.id) ? snapshot[args.id] : undefined
          if (args.action === 'start') {
            if (!args.base || !args.head || !args.team?.length || !args.assignment?.trim())
              throw new Error('start requires base, head, team and assignment')
            const { base, head, team, assignment } = args as {
              base: string
              head: string
              team: string[]
              assignment: string
            }
            if (existing) {
              if (
                existing.base !== base ||
                existing.head !== head ||
                existing.assignment !== assignment ||
                JSON.stringify(existing.members.map((member) => member.definition.name)) !==
                  JSON.stringify(team)
              )
                throw new Error('Run inputs are immutable; use a new id for a different review')
            } else {
              if (![base, head].every((sha) => /^[0-9a-f]{40}$/.test(sha)))
                throw new Error('base and head must be immutable full 40-character commit SHAs')
              if (new Set(team).size !== team.length)
                throw new Error('team must contain unique reviewers')
              const agent = await api.agent(context)
              for (const sha of [base, head])
                await exec('git', ['cat-file', '-e', `${sha}^{commit}`], {
                  cwd: agent.cwd ?? host.projectRoot,
                })
              const discovered = await discoverAgents(
                host.ultimateRoot,
                host.projectRoot,
                host.userHome,
                host.modelRuntime,
              )
              const definitions = team.map((name) => {
                const definition = discovered.definitions.find(
                  (candidate) => candidate.name === name,
                )
                if (!name.startsWith('reviewer-') || !definition)
                  throw new Error(`Unknown reviewer: ${name}`)
                if (
                  definition.model &&
                  !hasLogin(host.modelRuntime.getAvailableSnapshot(), definition.model)
                )
                  throw new Error(`Selected reviewer model is unavailable: ${name}`)
                return definition
              })
              const text = `Review only this immutable range: ${base}..${head}\n\n${assignment}`
              await api.commit(async (tx) => {
                const runs = (await tx.doc(ReviewRuns, parent)).runs
                if (Object.hasOwn(runs, args.id)) {
                  const run = runs[args.id]
                  if (
                    run.base !== base ||
                    run.head !== head ||
                    run.assignment !== assignment ||
                    JSON.stringify(run.members.map((member) => member.definition.name)) !==
                      JSON.stringify(team)
                  )
                    throw new Error('Run inputs are immutable; use a new id for a different review')
                  return
                }
                const members: Run['members'] = []
                for (const definition of definitions) {
                  const child = await host.need(SubagentsApi).start(tx, {
                    parent,
                    parentAgent: agent,
                    definition,
                    text,
                    requestId: `review-run:${args.id}:${definition.name}`,
                    background: true,
                  })
                  // Record the model actually configured (including an inherited or preview model), not a new fallback.
                  const configured = await tx.doc(AgentDoc, child.conversationId)
                  members.push({
                    definition,
                    ...(configured.model ? { model: configured.model } : {}),
                    conversationId: child.conversationId,
                  })
                }
                runs[args.id] = { base, head, assignment, members }
              }, context)
            }
          }
          const result = await api.commit((tx) => collect(tx, host, parent, args.id), context)
          return {
            output: [{ type: 'text', text: JSON.stringify(result) }],
            details: result,
          }
        },
      }),
    ],
  })
}
