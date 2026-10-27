/** Native artifact review actions and tab-local drafts; nothing here claims durable draft storage. */
import { useSyncExternalStore } from 'react'
import { actionRef } from '@/sdk'
import type {
  Artifact,
  ArtifactAnchor,
  ArtifactNote,
  FeedbackBundle,
  FeedbackSummary,
  FeedbackInput,
  ReferenceImage,
} from '../artifacts/types.ts'
import type { NativeDocument } from './types.ts'

export const List = actionRef<null, Artifact[]>('native-artifacts', 'list')
export type NativeReadResult =
  | NativeDocument
  | { unchanged: true; artifact: Artifact; sourceError?: string }
export const Read = actionRef<
  { id: string; parentOrigin: string; knownHash?: string },
  NativeReadResult
>('native-artifacts', 'read')
export const Feedback = actionRef<FeedbackInput, FeedbackBundle>('native-artifacts', 'feedback')
export const FeedbackList = actionRef<{ artifactId: string }, FeedbackSummary[]>(
  'native-artifacts',
  'feedbackList',
)
export const FeedbackRead = actionRef<{ artifactId: string; id: string }, FeedbackBundle>(
  'native-artifacts',
  'feedbackRead',
)

export type ReviewDraft = {
  contentHash: string
  recipient: string
  notes: ArtifactNote[]
  images: ReferenceImage[]
  readingImages?: boolean
  general: string
  editor: string
  anchor?: ArtifactAnchor
  /** Retain the exact request across uncertain delivery and retries, even if the user keeps editing. */
  request?: FeedbackInput
  requestGeneral?: string
}

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
