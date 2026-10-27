/** Shared local HTML artifact and feedback contract for the native and separate-tab reviewers. */
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
export type ArtifactNote = { id: string; text: string; anchor?: ArtifactAnchor }
export type ReferenceImage = {
  name: string
  mime: 'image/png' | 'image/jpeg' | 'image/webp'
  base64: string
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
}

/** Pollable feedback metadata; image bytes are read only on demand with feedbackRead. */
export type FeedbackSummary = Omit<FeedbackBundle, 'images'> & {
  images: Pick<ReferenceImage, 'name' | 'mime'>[]
}

export type PublishArtifact = { id?: string; title: string; path: string; assets?: string[] }
