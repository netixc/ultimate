/** Browser-safe actions for the shared local HTML artifact registry and review feedback. */
import { actionRef } from '../../../shared/extension-api.ts'
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
import type { NativeDocument } from './viewer-types.ts'

export type NativeReadResult =
  | NativeDocument
  | { unchanged: true; artifact: Artifact; sourceError?: string }

/** PublishArtifact → Artifact. Owner is always the calling conversation, never an input field. */
export const Publish = actionRef<PublishArtifact, Artifact>('artifacts', 'publish')
/** null → Artifact[]. List retained artifacts without accessing source workspaces. */
export const List = actionRef<null, Artifact[]>('artifacts', 'list')
/** { id } → ArtifactSnapshot. Refresh when possible; retain the last snapshot on source errors. */
export const Read = actionRef<{ id: string }, ArtifactSnapshot>('artifacts', 'read')
/** FeedbackInput → FeedbackBundle. Save before waking; identical request retries reuse the receipt. */
export const Feedback = actionRef<FeedbackInput, FeedbackBundle>('artifacts', 'feedback')
/** Native viewer read: validate its origin, sanitize retained HTML, and omit unchanged content. */
export const ReviewRead = actionRef<
  { id: string; parentOrigin: string; knownHash?: string },
  NativeReadResult
>('artifacts', 'reviewRead')
/** Human review admission; definitive pre-persistence rejections let the composer retain editable drafts. */
export const ReviewFeedback = actionRef<
  FeedbackInput,
  FeedbackBundle | { rejected: 'too-large' | 'destination'; message: string }
>('artifacts', 'reviewFeedback')
/** { artifactId } → newest 50 FeedbackSummary[]. No image bytes; retries saved delivery failures. */
export const FeedbackList = actionRef<{ artifactId: string }, FeedbackSummary[]>(
  'artifacts',
  'feedbackList',
)
/** { artifactId, id } → one FeedbackBundle with retained image bytes; refuses another artifact's bundle. */
export const FeedbackRead = actionRef<{ artifactId: string; id: string }, FeedbackBundle>(
  'artifacts',
  'feedbackRead',
)
/** { artifactId } → bounded LayoutState, read-only and pollable. */
export const LayoutRead = actionRef<{ artifactId: string }, LayoutState>('artifacts', 'layoutRead')
/** LayoutPassInput → LayoutState. User-only real frame observations; stale hashes cannot change triage. */
export const LayoutPass = actionRef<LayoutPassInput, LayoutState>('artifacts', 'layoutPass')
/** LayoutDismissInput → LayoutState. User-only dismissal scoped to the current content hash. */
export const LayoutDismiss = actionRef<LayoutDismissInput, LayoutState>(
  'artifacts',
  'layoutDismiss',
)
