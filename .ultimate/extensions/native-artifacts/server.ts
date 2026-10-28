import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import type { JsonValue } from '@earendil-works/chord'
import { defineExtension } from '@earendil-works/pi-durable'
import type { ActionContext } from '../../../server/actions.ts'
import type { ExtensionHost } from '../../../server/extensions.ts'
import { ArtifactsApi, FeedbackTooLargeError, FeedbackDestinationError } from '../artifacts/api.ts'
import type { FeedbackInput, LayoutPassInput } from '../artifacts/api.ts'
import { buildDocument } from './sandbox.ts'

export default function nativeArtifacts(host: ExtensionHost) {
  host.need(ArtifactsApi)
  return defineExtension({ name: 'native-artifacts' })
}

function object(args: JsonValue): Record<string, JsonValue> {
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    throw new Error('Expected an object')
  }
  return args
}

function id(args: JsonValue, field: string): string {
  const value = object(args)[field]
  if (typeof value !== 'string' || value.length > 128 || !value) {
    throw new Error(`Expected ${field}`)
  }
  return value
}

/** Native UI adapters: all storage, validation and delivery stay in the shared artifact service. */
export const actions = {
  async list(_args: JsonValue, ctx: ActionContext) {
    return ctx.host.need(ArtifactsApi).list(BACKGROUND_CONTEXT)
  },
  async read(args: JsonValue, ctx: ActionContext) {
    const values = object(args)
    const parentOrigin = values.parentOrigin
    if (typeof parentOrigin !== 'string' || parentOrigin.length > 512) {
      throw new Error('Expected the viewer origin')
    }
    const origin = new URL(parentOrigin)
    if (!['http:', 'https:'].includes(origin.protocol) || origin.origin !== parentOrigin) {
      throw new Error('Expected an HTTP(S) viewer origin without a path')
    }
    if (
      values.knownHash !== undefined &&
      (typeof values.knownHash !== 'string' || !/^[a-f0-9]{64}$/.test(values.knownHash))
    ) {
      throw new Error('Expected a content hash')
    }
    const snapshot = await ctx.host.need(ArtifactsApi).read(id(args, 'id'), BACKGROUND_CONTEXT)
    if (values.knownHash === snapshot.artifact.contentHash) {
      return { unchanged: true, artifact: snapshot.artifact, sourceError: snapshot.sourceError }
    }
    return {
      artifact: snapshot.artifact,
      sourceError: snapshot.sourceError,
      ...buildDocument(snapshot, parentOrigin),
    }
  },
  async feedback(args: JsonValue, ctx: ActionContext) {
    // The shared service validates every field, including limits and idempotency conflicts.
    object(args)
    try {
      return await ctx.host
        .need(ArtifactsApi)
        .feedback(args as unknown as FeedbackInput, BACKGROUND_CONTEXT)
    } catch (error) {
      // This rejection is proven to precede persistence; every uncertain failure still throws for exact retry.
      if (error instanceof FeedbackTooLargeError)
        return { rejected: 'too-large', message: error.message }
      if (error instanceof FeedbackDestinationError)
        return { rejected: 'destination', message: error.message }
      throw error
    }
  },
  async feedbackList(args: JsonValue, ctx: ActionContext) {
    return ctx.host.need(ArtifactsApi).feedbackList(id(args, 'artifactId'), BACKGROUND_CONTEXT)
  },
  async feedbackRead(args: JsonValue, ctx: ActionContext) {
    return ctx.host
      .need(ArtifactsApi)
      .feedbackRead(id(args, 'artifactId'), id(args, 'id'), BACKGROUND_CONTEXT)
  },
  async layoutRead(args: JsonValue, ctx: ActionContext) {
    return ctx.host.need(ArtifactsApi).layoutRead(id(args, 'artifactId'), BACKGROUND_CONTEXT)
  },
  async layoutPass(args: JsonValue, ctx: ActionContext) {
    // Only the trusted browser bridge reports geometry; the shared service bounds and validates it.
    object(args)
    return ctx.host
      .need(ArtifactsApi)
      .layoutPass(args as unknown as LayoutPassInput, BACKGROUND_CONTEXT)
  },
  async layoutDismiss(args: JsonValue, ctx: ActionContext) {
    return ctx.host.need(ArtifactsApi).layoutDismiss(
      {
        artifactId: id(args, 'artifactId'),
        issueId: id(args, 'issueId'),
        contentHash: id(args, 'contentHash'),
      },
      BACKGROUND_CONTEXT,
    )
  },
}

export const pollActions = ['list', 'read', 'feedbackList', 'layoutRead']
// Only the human review boundary may send feedback or record and dismiss measured issues.
export const userActions = ['feedback', 'layoutPass', 'layoutDismiss']
export const sealedActions = ['feedback', 'feedbackRead', 'layoutPass', 'layoutDismiss']
