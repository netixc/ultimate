/** Browser-safe actions for the shared local HTML artifact registry and review feedback. */
import { actionRef } from '../../../shared/extension-api.ts'
import type {
  Artifact,
  ArtifactSnapshot,
  FeedbackBundle,
  FeedbackInput,
  FeedbackSummary,
  PublishArtifact,
} from './types.ts'

/** PublishArtifact → Artifact. Owner is always the calling conversation, never an input field. */
export const Publish = actionRef<PublishArtifact, Artifact>('artifacts', 'publish')
/** null → Artifact[]. List retained artifacts without accessing source workspaces. */
export const List = actionRef<null, Artifact[]>('artifacts', 'list')
/** { id } → ArtifactSnapshot. Refresh when possible; retain the last snapshot on source errors. */
export const Read = actionRef<{ id: string }, ArtifactSnapshot>('artifacts', 'read')
/** FeedbackInput → FeedbackBundle. Save before waking; identical request retries reuse the receipt. */
export const Feedback = actionRef<FeedbackInput, FeedbackBundle>('artifacts', 'feedback')
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
