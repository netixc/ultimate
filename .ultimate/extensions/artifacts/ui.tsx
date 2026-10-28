/** Native artifact review actions and tab-local drafts; nothing here claims durable draft storage. */
import { createContext, useSyncExternalStore } from 'react'
import type {
  Artifact,
  ArtifactAnchor,
  ArtifactNote,
  FeedbackInput,
  ReferenceImage,
} from './types.ts'
import type { TargetStatus } from './viewer-types.ts'
export {
  List,
  ReviewRead as Read,
  ReviewFeedback as Feedback,
  FeedbackList,
  FeedbackRead,
  LayoutRead,
  LayoutPass,
  LayoutDismiss,
} from './refs.ts'
export type { NativeReadResult } from './refs.ts'

export type ReviewDraft = {
  contentHash: string
  recipient: string
  notes: ArtifactNote[]
  images: ReferenceImage[]
  readingImages?: boolean
  readingNoteId?: string
  general: string
  editor: string
  anchor?: ArtifactAnchor
  editorId?: string
  selectedIssues?: string[]
  /** Retain the exact request across uncertain delivery and retries, even if the user keeps editing. */
  request?: FeedbackInput
  requestGeneral?: string
}

export type ReviewComposerValue = {
  artifact: Artifact
  draft: ReviewDraft
  update: (change: (current: ReviewDraft) => ReviewDraft) => void
  statuses: TargetStatus[]
  onContinueNote: () => void
}
export const ReviewComposerContext = createContext<ReviewComposerValue | null>(null)

// Surface switches unmount React. Keep unsent work in this tab, not shared shell state or a durable-sounding store.
const drafts = new Map<string, ReviewDraft>()
const listeners = new Set<() => void>()
const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export const hasDraft = (draft: ReviewDraft | undefined) =>
  !!draft &&
  (!!draft.general.trim() ||
    !!draft.editor.trim() ||
    !!draft.anchor ||
    !!draft.editorId ||
    !!draft.selectedIssues?.length ||
    draft.notes.length > 0 ||
    draft.images.length > 0 ||
    !!draft.readingImages ||
    !!draft.request)

export function useReviewDraft(artifact: Artifact) {
  const initial = () =>
    ({
      contentHash: artifact.contentHash,
      recipient: String(artifact.recipientConversation),
      notes: [],
      images: [],
      general: '',
      editor: '',
    }) satisfies ReviewDraft
  if (!drafts.has(artifact.id)) drafts.set(artifact.id, initial())
  const draft = useSyncExternalStore(subscribe, () => drafts.get(artifact.id)!)
  const update = (change: (current: ReviewDraft) => ReviewDraft) => {
    drafts.set(artifact.id, change(drafts.get(artifact.id)!))
    for (const listener of listeners) listener()
  }
  return [draft, update] as const
}

export function anyDrafts() {
  return [...drafts.values()].some(hasDraft)
}
