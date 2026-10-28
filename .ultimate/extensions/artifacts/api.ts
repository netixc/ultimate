/** Local HTML artifacts: publish and read the current retained snapshot, and save and deliver review feedback. */
import type { Context } from '@earendil-works/chord'
import { defineApi } from '../../../shared/extension-api.ts'
import type {
  Artifact,
  ArtifactSnapshot,
  FeedbackBundle,
  FeedbackInput,
  FeedbackSummary,
  PublishArtifact,
  LayoutPassInput,
  LayoutDismissInput,
  LayoutState,
} from './types.ts'

export type ArtifactsService = {
  /** Publish explicit source files on behalf of the authenticated owner conversation. */
  publish(input: PublishArtifact, ownerConversation: number, ctx: Context): Promise<Artifact>
  /** List registered artifacts, without reading their source workspaces. */
  list(ctx: Context): Promise<Artifact[]>
  /** Refresh from an admitted source when available, otherwise return the last retained snapshot. */
  read(id: string, ctx: Context): Promise<ArtifactSnapshot>
  /** Save original feedback before idempotent typed-input admission; trusted human-review adapters only. */
  feedback(input: FeedbackInput, ctx: Context): Promise<FeedbackBundle>
  /** List the newest 50 saved feedback summaries without image bytes; retry outstanding admission. */
  feedbackList(artifactId: string, ctx: Context): Promise<FeedbackSummary[]>
  /** Read one saved feedback bundle, including retained image bytes, for this artifact only. */
  feedbackRead(artifactId: string, id: string, ctx: Context): Promise<FeedbackBundle>
  /** Read bounded retained observations; never scans or changes triage. */
  layoutRead(artifactId: string, ctx: Context): Promise<LayoutState>
  /** Save a real frame measurement for the current hash; trusted browser adapters only. */
  layoutPass(input: LayoutPassInput, ctx: Context): Promise<LayoutState>
  /** Dismiss a retained observation for this current revision only; trusted browser adapters only. */
  layoutDismiss(input: LayoutDismissInput, ctx: Context): Promise<LayoutState>
}
/** Shared backend for local HTML artifact reviewers. */
export const ArtifactsApi = defineApi<ArtifactsService>()('artifacts')
/** Definitive pre-save rejections; adapters may safely let the human edit the rejected batch. */
export { FeedbackTooLargeError, FeedbackDestinationError } from './types.ts'
export type {
  Artifact,
  ArtifactSnapshot,
  ArtifactNote,
  ReferenceImage,
  FeedbackBundle,
  FeedbackInput,
  FeedbackSummary,
  PublishArtifact,
  LayoutViewport,
  LayoutFinding,
  LayoutPassInput,
  LayoutIssue,
  LayoutState,
  LayoutDismissInput,
} from './types.ts'
