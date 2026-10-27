import type { ComposerAttachment, ComposerAttachmentState } from '../sdk/composer-attachments.tsx'

export const maxAttachmentBytes = 10 * 1024 * 1024

export function validateAttachments({ images, attachments }: ComposerAttachmentState) {
  if (images.length + attachments.length > 4)
    throw new Error('Attach up to 4 images and files per message.')
  const size =
    images.reduce(
      (sum, image) =>
        sum +
        (image.data.length * 3) / 4 -
        (image.data.endsWith('==') ? 2 : image.data.endsWith('=') ? 1 : 0),
      0,
    ) + attachments.reduce((sum, file) => sum + file.size, 0)
  if (size > maxAttachmentBytes) throw new Error('Attachments exceed 10 MiB combined.')
}

export function storedAttachments(key: string): ComposerAttachment[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(`${key}.attachments`) ?? '[]')
    if (!Array.isArray(value) || value.length > 4) return []
    return value.flatMap((file: unknown) => {
      if (!file || typeof file !== 'object') return []
      const item = file as Partial<ComposerAttachment>
      if (
        typeof item.id !== 'string' ||
        typeof item.name !== 'string' ||
        typeof item.size !== 'number' ||
        !Number.isSafeInteger(item.size) ||
        item.size < 0 ||
        item.size > 5 * 1024 * 1024
      )
        return []
      return [
        {
          id: item.id,
          name: item.name,
          size: item.size,
          status: item.status === 'ready' ? ('ready' as const) : ('error' as const),
          ...(item.status === 'ready' ? {} : { error: 'Choose this file again to upload it.' }),
        },
      ]
    })
  } catch {
    // A corrupt or unavailable browser draft cannot restore file references; the mounted draft still works.
    return []
  }
}

export function storeAttachments(key: string, attachments: ComposerAttachment[]) {
  try {
    if (attachments.length) localStorage.setItem(`${key}.attachments`, JSON.stringify(attachments))
    else localStorage.removeItem(`${key}.attachments`)
  } catch {
    // Like image drafts, unavailable browser storage leaves the current draft in memory.
  }
}
