import { createContext, useContext } from 'react'
import type { ReactNode } from 'react'

export type ComposerImage = { data: string; mimeType: string }
/** Small draft metadata only; file bytes belong to the extension's upload transport. */
export type ComposerAttachment = {
  id: string
  name: string
  size: number
  status: 'uploading' | 'ready' | 'error'
  error?: string
}
export type ComposerAttachmentState = {
  images: ComposerImage[]
  attachments: ComposerAttachment[]
}
export type ComposerSubmission = ComposerAttachmentState & {
  text: string
  conversationId: number
  requestId: string
  whenBusy?: 'steer' | 'followUp'
}
export type ComposerAttachmentController = ComposerAttachmentState & {
  conversationId: number | undefined
  disabled: boolean
  /** Reads and changes this draft synchronously, even after switching to another conversation. */
  update(change: (current: ComposerAttachmentState) => ComposerAttachmentState): void
  setImages(change: (images: ComposerImage[]) => ComposerImage[]): void
  setAttachments(change: (attachments: ComposerAttachment[]) => ComposerAttachment[]): void
  setError(message: string | undefined): void
}
export const ComposerAttachmentContext = createContext<ComposerAttachmentController | undefined>(
  undefined,
)
export const ComposerAttachmentSubmitContext = createContext<
  ((input: ComposerSubmission, fallback: () => Promise<unknown>) => Promise<unknown>) | undefined
>(undefined)

/** Extend the existing composer submission without replacing its draft, queue or failure handling. */
export function ComposerAttachmentAdapter({
  submit,
  children,
}: {
  submit: (input: ComposerSubmission, fallback: () => Promise<unknown>) => Promise<unknown>
  children: ReactNode
}) {
  return (
    <ComposerAttachmentSubmitContext value={submit}>{children}</ComposerAttachmentSubmitContext>
  )
}

/** Only available inside composer slots; all setters stay bound to that draft. */
export function useComposerAttachments() {
  const value = useContext(ComposerAttachmentContext)
  if (!value) throw new Error('Composer attachments require a composer slot')
  return value
}
