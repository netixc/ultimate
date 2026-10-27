import { api, errorMessage } from '@/sdk'
import type { ComposerAttachment, ComposerImage } from '@/sdk'
import { UploadAction } from './refs.ts'

type Selection = { images: ComposerImage[]; attachments: ComposerAttachment[] }
export type UploadDraft = {
  conversationId: number | undefined
  update: (change: (current: Selection) => Selection) => void
  setError: (message: string | undefined) => void
}

const MiB = 1024 * 1024
const imageTypes = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']
// File bytes never enter persisted draft state. Retain failed files only so Retry uses the same upload token.
const files = new Map<string, File>()
const uploading = new Set<string>()
const key = (conversationId: number, id: string) => `${conversationId}:${id}`

export function selectionError(current: Selection, selected: readonly File[]): string | undefined {
  if (current.images.length + current.attachments.length + selected.length > 4)
    return 'Attach up to 4 images and files in total.'
  for (const file of selected) {
    if (file.type.startsWith('image/')) {
      if (!imageTypes.includes(file.type)) return 'Choose PNG, JPEG, WebP or GIF images.'
      if (file.size > 2 * MiB) return 'Each image must be 2 MiB or smaller.'
    } else if (file.size > 5 * MiB) return 'Each file must be 5 MiB or smaller.'
  }
  const total =
    current.images.reduce(
      (size, image) =>
        size +
        image.data.length * 0.75 -
        (image.data.endsWith('==') ? 2 : image.data.endsWith('=') ? 1 : 0),
      0,
    ) +
    current.attachments.reduce((size, file) => size + file.size, 0) +
    selected.reduce((size, file) => size + file.size, 0)
  return total > 10 * MiB ? 'Attachments must be 10 MiB or smaller in total.' : undefined
}

async function base64(file: File) {
  const bytes = new Uint8Array(await file.arrayBuffer())
  let binary = ''
  for (let at = 0; at < bytes.length; at += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000))
  return btoa(binary)
}

export function canRetry(conversationId: number, id: string) {
  return files.has(key(conversationId, id))
}

export function forgetFile(conversationId: number, id: string) {
  files.delete(key(conversationId, id))
}

/** Reserve the whole selection before reading a byte, so clipboard paste and another picker see its limits. */
export async function chooseFiles(draft: UploadDraft, selected: readonly File[], replace?: string) {
  if (draft.conversationId === undefined || selected.length === 0) return
  const conversationId = draft.conversationId
  const added = selected.map((file) => ({
    id: crypto.randomUUID(),
    name: file.name,
    size: file.size,
    status: 'uploading' as const,
  }))
  try {
    draft.update((current) => {
      const next = {
        ...current,
        attachments: current.attachments.filter((file) => file.id !== replace),
      }
      const error = selectionError(next, selected)
      if (error) throw new Error(error)
      return { ...next, attachments: [...next.attachments, ...added] }
    })
  } catch (failure) {
    draft.setError(errorMessage(failure))
    return
  }
  if (replace) forgetFile(conversationId, replace)
  draft.setError(undefined)
  await Promise.all(
    added.map((attachment, index) => {
      files.set(key(conversationId, attachment.id), selected[index])
      return uploadFile(draft, attachment.id)
    }),
  )
}

export async function uploadFile(draft: UploadDraft, id: string) {
  if (draft.conversationId === undefined) return
  const conversationId = draft.conversationId
  const fileKey = key(conversationId, id)
  const file = files.get(fileKey)
  if (!file || uploading.has(fileKey)) return
  uploading.add(fileKey)
  try {
    draft.update((current) => ({
      ...current,
      attachments: current.attachments.map((item) =>
        item.id === id ? { ...item, status: 'uploading', error: undefined } : item,
      ),
    }))
    const data = await base64(file)
    // Removing an in-flight chip discards its result, even when reading or the server finishes later.
    if (!files.has(fileKey)) return
    if (file.type.startsWith('image/')) {
      draft.update((current) => {
        if (!current.attachments.some((item) => item.id === id)) return current
        return {
          images: [...current.images, { data, mimeType: file.type }],
          attachments: current.attachments.filter((item) => item.id !== id),
        }
      })
    } else {
      const result = await api.action(
        UploadAction,
        { token: id, name: file.name, data },
        { conversationId },
      )
      if (!files.has(fileKey)) return
      draft.update((current) => ({
        ...current,
        attachments: current.attachments.map((item) =>
          item.id === id ? { ...result, status: 'ready' } : item,
        ),
      }))
    }
    files.delete(fileKey)
  } catch (failure) {
    if (!files.has(fileKey)) return
    draft.update((current) => ({
      ...current,
      attachments: current.attachments.map((item) =>
        item.id === id ? { ...item, status: 'error', error: errorMessage(failure) } : item,
      ),
    }))
  } finally {
    uploading.delete(fileKey)
  }
}
