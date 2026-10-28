/** Shared local HTML artifact and human feedback contract. */
export const MAX_ARTIFACT_BYTES = 10 * 1024 * 1024
export const MAX_ARTIFACT_HTML_BYTES = 2 * 1024 * 1024
/** Leave room for base64 and bounded notes inside the action endpoint's 12 MiB JSON limit. */
export const FEEDBACK_IMAGE_MAX_BYTES = 8 * 1024 * 1024
/** The remaining 1 KiB covers the action envelope and conversation id. */
export const FEEDBACK_MAX_JSON_BYTES = 12 * 1024 * 1024 - 1024

/** A definitive size rejection before new feedback bytes, registry state or admission were saved. */
export class FeedbackTooLargeError extends Error {
  readonly code = 'feedback-too-large'
}

export type Artifact = {
  id: string
  title: string
  ownerConversation: number
  recipientConversation: number
  source: { workspace: string; path: string; assets: string[] }
  contentHash: string
  updatedAt: number
}

export type ArtifactAsset = { path: string; mime: string; base64: string }
export type ArtifactSnapshot = {
  artifact: Artifact
  html: string
  assets: ArtifactAsset[]
  /** A missing source keeps the last retained snapshot available, with this explanation. */
  sourceError?: string
}

export type TextBoundary = { path: number[]; offset: number }
export type ArtifactAnchor =
  | { kind: 'element'; selector: string; text: string }
  | {
      kind: 'text'
      selector: string
      text: string
      start: TextBoundary
      end: TextBoundary
    }
export type ArtifactNote = {
  id: string
  text: string
  anchor?: ArtifactAnchor
  layoutIssueIds?: string[]
}
export type ReferenceImage = {
  name: string
  mime: 'image/png' | 'image/jpeg' | 'image/webp'
  base64: string
  /** Omitted for a general reference; otherwise names a note in this batch. */
  noteId?: string
}
export type FeedbackInput = {
  artifactId: string
  requestId: string
  contentHash: string
  recipientConversation: number
  notes: ArtifactNote[]
  images: ReferenceImage[]
}
export type FeedbackBundle = FeedbackInput & {
  id: string
  createdAt: number
  /** Actual route, fixed after admission; unadmitted concluded/missing destinations go through @ultimate. */
  routedTo: number
  state: 'saved' | 'delivered'
  submissionId?: number
  deliveryError?: string
  /** Server-observed immutable context for the notes' layoutIssueIds, never supplied by callers. */
  layoutIssues?: LayoutIssue[]
}

/** Pollable feedback metadata; image bytes are read only on demand with feedbackRead. */
export type FeedbackSummary = Omit<FeedbackBundle, 'images'> & {
  images: Pick<ReferenceImage, 'name' | 'mime' | 'noteId'>[]
}

export type PublishArtifact = { id?: string; title: string; path: string; assets?: string[] }

/** Exact measured content-frame dimensions, not the host window or a width bucket. */
export type LayoutViewport = { width: number; height: number }
export type LayoutFinding = {
  rule: 'page-horizontal-overflow' | 'clipped-control' | 'unreachable-control'
  selector: string
  axis: 'horizontal' | 'vertical'
  overflowPx: number
}
export type LayoutPassInput = {
  artifactId: string
  contentHash: string
  viewport: LayoutViewport
  complete: boolean
  findings: LayoutFinding[]
  error?: string
}
export type LayoutIssue = LayoutFinding & {
  id: string
  viewport: LayoutViewport
  contentHash: string
  lastSeenAt: number
  status: 'open' | 'dismissed' | 'resolved'
  dismissedFor?: string
}
export type LayoutState = {
  issues: LayoutIssue[]
  pass?: {
    contentHash: string
    viewport: LayoutViewport
    complete: boolean
    at: number
    error?: string
  }
  stale?: boolean
}
export type LayoutDismissInput = { artifactId: string; issueId: string; contentHash: string }
