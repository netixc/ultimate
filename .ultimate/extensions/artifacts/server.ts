import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import type { Context } from '@earendil-works/chord'
import { Type } from '@earendil-works/pi-ai'
import {
  AgentDoc,
  defineDoc,
  defineExtension,
  defineTool,
  ROOT_CONVERSATION_ID,
  section,
} from '@earendil-works/pi-durable'
import type { ConversationId, Tx } from '@earendil-works/pi-durable'
import type { ExtensionHost } from '../../../server/extensions.ts'
import { implementAction } from '../../../lib/actions.ts'
import { ConversationsApi } from '../../../extensions/conversations/api.ts'
import { WorkspacesApi } from '../../../extensions/workspaces/api.ts'
import { SubagentsApi } from '../../../extensions/subagents/api.ts'
import { ArtifactsApi } from './api.ts'
import type { ArtifactsService } from './api.ts'
import { Publish, List, Read, Feedback, FeedbackList, FeedbackRead } from './refs.ts'
import type { Artifact, FeedbackBundle, FeedbackSummary } from './types.ts'
import { ArtifactStorage, artifactId, digest, feedbackInput, publishInput } from './storage.ts'

type FeedbackRecord = { bundle: FeedbackSummary; payloadHash: string; ownerConversation: number }
export const Registry = defineDoc<{
  artifacts: Record<string, Artifact>
  feedback: Record<string, FeedbackRecord>
}>({
  kind: 'artifacts.registry',
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  checkpointWhen: () => false,
  initial: () => ({ artifacts: {}, feedback: {} }),
})
export const docs = [Registry]
// Typed user-input admission is privileged: only the human review boundary can create feedback.
export const userActions = ['feedback']
export const sealedActions = ['feedback', 'feedbackRead']

async function source(tx: Tx, host: ExtensionHost, owner: number) {
  const id = owner as ConversationId
  if (!Number.isSafeInteger(owner) || !(await tx.conversation(id)))
    throw new Error('Artifact owner must be an existing conversation')
  if ((await host.need(ConversationsApi).concludedIn(tx)).has(id))
    throw new Error('Artifact owner is concluded')
  const workspace = (await tx.doc(host.need(WorkspacesApi).doc, ROOT_CONVERSATION_ID)).items[
    String(owner)
  ]
  if (workspace && workspace.state !== 'ready')
    throw new Error(`Artifact workspace is ${workspace.state}`)
  return workspace?.path ?? (await tx.doc(AgentDoc, id)).cwd ?? host.projectRoot
}

export function artifacts(
  host: ExtensionHost,
): ArtifactsService & { recover(ctx: Context): Promise<void> } {
  const storage = new ArtifactStorage(host.home)
  const queue = host.resource('artifacts.operations', () => {
    const state = { tail: Promise.resolve(), stopped: false }
    host.onRelease(async () => {
      state.stopped = true
      await state.tail
    })
    host.onOpen(async () => {
      state.stopped = false
    })
    return state
  })
  function locked<T>(work: () => Promise<T>): Promise<T> {
    if (queue.stopped)
      return Promise.reject(new Error('Artifacts are paused while the host restarts'))
    const operation = queue.tail.then(work)
    queue.tail = operation.then(
      () => {},
      () => {
        /* The caller receives the error; later operations must remain usable. */
      },
    )
    return operation
  }
  const commit = <T>(ctx: Context, work: (tx: Tx) => Promise<T>) => host.harness().commit(work, ctx)
  const registry = async (ctx: Context) =>
    (await host.harness().snapshot(Registry, ROOT_CONVERSATION_ID, ctx)) ?? {
      artifacts: {},
      feedback: {},
    }
  async function hydrate(record: FeedbackRecord): Promise<FeedbackBundle> {
    const saved = await storage.readFeedback(record.bundle.artifactId, record.bundle.id)
    return { ...saved, ...record.bundle, images: saved.images }
  }
  async function recover(ctx: Context) {
    for (const record of Object.values((await registry(ctx)).feedback)) {
      if (record.bundle.state === 'delivered') continue
      try {
        const requestId = `artifacts:${record.bundle.id}`
        let routedTo = record.bundle.routedTo
        const admission = await commit(ctx, async (tx) => {
          const receipt = await tx.submissionByRequest(routedTo as ConversationId, requestId)
          if (receipt) return { submissionId: receipt.id, active: true }
          return {
            submissionId: undefined,
            active:
              !!(await tx.conversation(routedTo as ConversationId)) &&
              !(await host.need(ConversationsApi).concludedIn(tx)).has(routedTo as ConversationId),
          }
        })
        let submissionId: number | undefined = admission.submissionId
        if (submissionId === undefined) {
          if (!admission.active) {
            routedTo = await host.need(SubagentsApi).standing('ultimate', ctx)
            await commit(ctx, async (tx) => {
              ;(await tx.doc(Registry, ROOT_CONVERSATION_ID)).feedback[
                record.bundle.id
              ].bundle.routedTo = routedTo
            })
          }
          const bundle = await hydrate({ ...record, bundle: { ...record.bundle, routedTo } })
          const bundlePath = join(storage.feedbackPath(bundle.artifactId, bundle.id), 'bundle.json')
          const text = [
            'Saved human HTML artifact review feedback (not an agent-authored request).',
            `Artifact ${bundle.artifactId}; owner #${record.ownerConversation}; original recipient #${bundle.recipientConversation}; routed to #${bundle.routedTo}.`,
            `Original content hash: ${bundle.contentHash}. Request id: ${bundle.requestId}. Feedback id: ${bundle.id}.`,
            `Read saved bundle: ${bundlePath}`,
            `Saved bundle and current delivery state: artifacts.feedbackRead({artifactId: ${JSON.stringify(bundle.artifactId)}, id: ${JSON.stringify(bundle.id)}}). Retained artifact: artifacts.read({id: ${JSON.stringify(bundle.artifactId)}}).`,
            ...bundle.notes.map(
              (note) =>
                `Note ${note.id}: ${note.text}${note.anchor ? `\nTarget: ${JSON.stringify(note.anchor)}` : ''}`,
            ),
            ...storage
              .imagePaths(bundle)
              .map(
                (path, index) =>
                  `Reference image ${index + 1} (${bundle.images[index].name}): ${path}`,
              ),
          ].join('\n\n')
          submissionId = (
            await host.submit(
              bundle.routedTo,
              { text, requestId, whenBusy: 'followUp' },
              { context: ctx },
            )
          ).submissionId
        }
        await commit(ctx, async (tx) => {
          const saved = (await tx.doc(Registry, ROOT_CONVERSATION_ID)).feedback[record.bundle.id]
            .bundle
          saved.submissionId = submissionId
          saved.state = 'delivered'
          delete saved.deliveryError
        })
      } catch (error) {
        // Look up the admission receipt before retrying: an admitted route must never move or reopen on recovery.
        await commit(ctx, async (tx) => {
          const saved = (await tx.doc(Registry, ROOT_CONVERSATION_ID)).feedback[record.bundle.id]
            .bundle
          saved.deliveryError = error instanceof Error ? error.message : 'Feedback delivery failed'
        })
      }
    }
  }
  async function find(id: string, ctx: Context) {
    artifactId(id)
    const artifact = (await registry(ctx)).artifacts[id]
    if (!artifact) throw new Error('Unknown artifact')
    return artifact
  }
  async function prune(previous: Artifact, current: Artifact) {
    if (previous.contentHash === current.contentHash) return
    await storage.prune(previous).catch(() => {
      // The committed current snapshot remains authoritative; an old unreferenced folder is harmless.
      host.notice(`Could not prune the previous retained snapshot of artifact ${previous.id}`)
    })
  }
  return {
    recover: (ctx) => locked(() => recover(ctx)),
    publish: (raw, owner, ctx) =>
      locked(async () => {
        const input = publishInput(raw)
        await recover(ctx)
        const id = input.id ?? randomUUID()
        const existing = (await registry(ctx)).artifacts[id]
        if (existing && existing.ownerConversation !== owner)
          throw new Error('Only the artifact owner can publish this id')
        const workspace = await commit(ctx, (tx) => source(tx, host, owner))
        const capture = await storage.capture(workspace, input)
        const artifact: Artifact = {
          id,
          title: input.title,
          ownerConversation: owner,
          recipientConversation: existing?.recipientConversation ?? owner,
          source: { workspace, path: input.path, assets: input.assets ?? [] },
          contentHash: capture.contentHash,
          updatedAt: Date.now(),
        }
        await storage.saveSnapshot({ artifact, html: capture.html, assets: capture.assets })
        await commit(ctx, async (tx) => {
          if ((await source(tx, host, owner)) !== workspace)
            throw new Error('Artifact workspace changed during publish')
          const index = await tx.doc(Registry, ROOT_CONVERSATION_ID)
          if (index.artifacts[id] && index.artifacts[id].ownerConversation !== owner)
            throw new Error('Only the artifact owner can publish this id')
          index.artifacts[id] = artifact
        })
        if (existing) await prune(existing, artifact)
        return artifact
      }),
    list: (ctx) =>
      locked(async () => {
        await recover(ctx)
        return Object.values((await registry(ctx)).artifacts)
      }),
    read: (id, ctx) =>
      locked(async () => {
        await recover(ctx)
        const previous = await find(id, ctx)
        let artifact = previous
        let sourceError: string | undefined
        try {
          const workspace = await commit(ctx, (tx) => source(tx, host, previous.ownerConversation))
          if (workspace !== previous.source.workspace)
            throw new Error('Artifact workspace no longer matches its published source')
          const input = publishInput({
            title: previous.title,
            path: previous.source.path,
            assets: previous.source.assets,
          })
          const capture = await storage.capture(workspace, input)
          artifact = {
            ...previous,
            contentHash: capture.contentHash,
            updatedAt:
              capture.contentHash === previous.contentHash ? previous.updatedAt : Date.now(),
          }
          await storage.saveSnapshot({ artifact, html: capture.html, assets: capture.assets })
          await commit(ctx, async (tx) => {
            if ((await source(tx, host, previous.ownerConversation)) !== workspace)
              throw new Error('Artifact workspace changed during refresh')
            ;(await tx.doc(Registry, ROOT_CONVERSATION_ID)).artifacts[id] = artifact
          })
        } catch (error) {
          artifact = previous
          sourceError = error instanceof Error ? error.message : 'Source is unavailable'
        }
        if (!sourceError) await prune(previous, artifact)
        return {
          ...(await storage.readSnapshot(artifact)),
          ...(sourceError ? { sourceError } : {}),
        }
      }),
    feedback: (raw, ctx) =>
      locked(async () => {
        const input = feedbackInput(raw)
        const artifact = await find(input.artifactId, ctx)
        const id = digest(JSON.stringify([input.artifactId, input.requestId]))
        const payloadHash = digest(JSON.stringify(input))
        const existing = (await registry(ctx)).feedback[id]
        if (existing) {
          if (existing.payloadHash !== payloadHash)
            throw new Error('Feedback requestId conflicts with a different payload')
        } else {
          const target = input.recipientConversation as ConversationId
          const active = await commit(
            ctx,
            async (tx) =>
              !!(await tx.conversation(target)) &&
              !(await host.need(ConversationsApi).concludedIn(tx)).has(target),
          )
          const routedTo = active ? target : await host.need(SubagentsApi).standing('ultimate', ctx)
          const bundle = await storage.saveFeedback({
            ...input,
            id,
            createdAt: Date.now(),
            routedTo,
            state: 'saved',
          })
          const metadata: FeedbackSummary = {
            ...bundle,
            images: bundle.images.map(({ name, mime }) => ({ name, mime })),
          }
          await commit(ctx, async (tx) => {
            ;(await tx.doc(Registry, ROOT_CONVERSATION_ID)).feedback[id] = {
              bundle: metadata,
              payloadHash,
              ownerConversation: artifact.ownerConversation,
            }
          })
        }
        await recover(ctx)
        return hydrate((await registry(ctx)).feedback[id])
      }),
    feedbackList: (id, ctx) =>
      locked(async () => {
        await find(id, ctx)
        await recover(ctx)
        return Object.values((await registry(ctx)).feedback)
          .filter((record) => record.bundle.artifactId === id)
          .toSorted((a, b) => b.bundle.createdAt - a.bundle.createdAt)
          .slice(0, 50)
          .map((record) => record.bundle)
      }),
    feedbackRead: (artifact, id, ctx) =>
      locked(async () => {
        await find(artifact, ctx)
        artifactId(id)
        const record = (await registry(ctx)).feedback[id]
        if (!record || record.bundle.artifactId !== artifact)
          throw new Error('Unknown feedback for this artifact')
        await recover(ctx)
        return hydrate((await registry(ctx)).feedback[id])
      }),
  }
}

function field(args: unknown, name: string): unknown {
  return args && typeof args === 'object' && !Array.isArray(args)
    ? (args as Record<string, unknown>)[name]
    : undefined
}
export const actions = {
  publish: implementAction(Publish, (args, { host, conversationId }) => {
    if (conversationId === undefined) throw new Error('Publish requires the owner conversation')
    return host.need(ArtifactsApi).publish(publishInput(args), conversationId, BACKGROUND_CONTEXT)
  }),
  list: implementAction(List, (_args, { host }) =>
    host.need(ArtifactsApi).list(BACKGROUND_CONTEXT),
  ),
  read: implementAction(Read, (args, { host }) =>
    host.need(ArtifactsApi).read(artifactId(field(args, 'id')), BACKGROUND_CONTEXT),
  ),
  feedback: implementAction(Feedback, (args, { host }) =>
    host.need(ArtifactsApi).feedback(feedbackInput(args), BACKGROUND_CONTEXT),
  ),
  feedbackList: implementAction(FeedbackList, (args, { host }) =>
    host.need(ArtifactsApi).feedbackList(artifactId(field(args, 'artifactId')), BACKGROUND_CONTEXT),
  ),
  feedbackRead: implementAction(FeedbackRead, (args, { host }) =>
    host
      .need(ArtifactsApi)
      .feedbackRead(
        artifactId(field(args, 'artifactId')),
        artifactId(field(args, 'id')),
        BACKGROUND_CONTEXT,
      ),
  ),
}

export default function artifactExtension(host: ExtensionHost) {
  host.need(WorkspacesApi)
  host.need(ConversationsApi)
  host.need(SubagentsApi)
  const service = artifacts(host)
  host.implement(ArtifactsApi, service)
  host.onOpen(() => service.recover(BACKGROUND_CONTEXT))
  return defineExtension({
    name: 'artifacts',
    tools: [
      defineTool({
        name: 'artifact_publish',
        description:
          'Publish finished local HTML for human review. Paths are relative to your admitted workspace; enumerate assets explicitly. Reuse id to update an artifact you own. No live server is needed.',
        // A stable caller/task/call-derived id republishes the same owner's artifact rather than duplicating it.
        replay: 'safe',
        parameters: Type.Object({
          id: Type.Optional(Type.String()),
          title: Type.String(),
          path: Type.String(),
          assets: Type.Optional(Type.Array(Type.String())),
        }),
        execute: async (input, api, ctx) => {
          const artifact = await service.publish(
            {
              ...input,
              id:
                input.id ??
                digest(JSON.stringify([api.conversationId, api.taskId, api.callId])).slice(0, 40),
            },
            api.conversationId,
            ctx,
          )
          return { output: [{ type: 'text', text: JSON.stringify(artifact) }], details: artifact }
        },
      }),
    ],
    sections: [
      section(
        'artifact_reviews',
        () =>
          'Use artifact_publish for finished local HTML that the user should review. Publish explicit asset paths only, reuse the same id for revisions, and do not start a live server. Saved human feedback arrives with its original content hash, target excerpts and retained reference-image paths.',
      ),
    ],
  })
}
