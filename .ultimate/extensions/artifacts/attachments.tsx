import { ImagePlusIcon, Trash2Icon } from 'lucide-react'
import { useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { errorMessage } from '@/sdk'
import { FEEDBACK_IMAGE_MAX_BYTES } from './types.ts'
import type { ReferenceImage } from './types.ts'
import type { ReviewDraft } from './ui.tsx'

const imageBytes = (image: ReferenceImage) =>
  (image.base64.length * 3) / 4 -
  (image.base64.endsWith('==') ? 2 : image.base64.endsWith('=') ? 1 : 0)

/** Every attachment picker shares the batch limits; noteId binds a reference to its particular queued note. */
export function ReferenceImages({
  draft,
  update,
  noteId,
  label = 'Attach images',
}: {
  draft: ReviewDraft
  update: (change: (current: ReviewDraft) => ReviewDraft) => void
  noteId?: string
  label?: string
}) {
  const picker = useRef<HTMLInputElement>(null)
  const lock = useRef(false)
  const [error, setError] = useState<string>()
  const visible = draft.images.filter((image) => image.noteId === noteId)
  const choose = async (files: File[]) => {
    if (!files.length || lock.current || draft.readingImages) return
    setError(undefined)
    if (draft.images.length + files.length > 4) {
      setError('Attach up to 4 images across all notes and general feedback.')
      return
    }
    if (files.some((file) => !['image/png', 'image/jpeg', 'image/webp'].includes(file.type))) {
      setError('Choose PNG, JPEG or WebP images.')
      return
    }
    if (
      draft.images.reduce((size, image) => size + imageBytes(image), 0) +
        files.reduce((size, file) => size + file.size, 0) >
      FEEDBACK_IMAGE_MAX_BYTES
    ) {
      setError('Reference images must total 8 MiB or less.')
      return
    }
    if (files.some((file) => !file.name.trim() || file.name.length > 200)) {
      setError('Image filenames must be between 1 and 200 characters.')
      return
    }
    lock.current = true
    update((current) => ({ ...current, readingImages: true, readingNoteId: noteId }))
    try {
      const images = await Promise.all(
        files.map(async (file): Promise<ReferenceImage> => {
          const bitmap = await createImageBitmap(file)
          bitmap.close()
          const bytes = new Uint8Array(await file.arrayBuffer())
          let binary = ''
          for (let at = 0; at < bytes.length; at += 0x8000)
            binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000))
          return {
            name: file.name,
            mime: file.type as ReferenceImage['mime'],
            base64: btoa(binary),
            ...(noteId ? { noteId } : {}),
          }
        }),
      )
      update((current) => ({ ...current, images: [...current.images, ...images] }))
    } catch (failure) {
      setError(
        `Couldn’t decode reference images: ${errorMessage(failure)} Choose valid images again.`,
      )
    } finally {
      lock.current = false
      update((current) => ({ ...current, readingImages: false, readingNoteId: undefined }))
    }
  }
  return (
    <div className="space-y-2" data-reference-images={noteId ?? 'general'}>
      <input
        ref={picker}
        className="hidden"
        type="file"
        multiple
        accept="image/png,image/jpeg,image/webp"
        aria-label={label}
        onChange={(event) => {
          // The picker reports decoding and validation failures locally, without losing the draft.
          // oxlint-disable-next-line typescript/no-floating-promises
          void choose([...(event.target.files ?? [])])
          event.target.value = ''
        }}
      />
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          variant="ghost"
          disabled={!!draft.readingImages || draft.images.length >= 4}
          onClick={() => picker.current?.click()}
        >
          <ImagePlusIcon />
          {draft.readingImages ? 'Reading images…' : label}
        </Button>
        {!noteId && (
          <span className="text-[10px] text-muted-foreground">
            {draft.images.length}/4 · 8 MiB total
          </span>
        )}
      </div>
      {visible.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {visible.map((image, index) => (
            <div
              className="relative w-24 rounded border border-border/70 p-1.5"
              // oxlint-disable-next-line react/no-array-index-key -- Stateless image tiles permit duplicate filenames.
              key={`${index}:${image.name}`}
            >
              <img
                className="h-14 w-full object-contain"
                alt={image.name}
                src={`data:${image.mime};base64,${image.base64}`}
              />
              <p className="truncate pr-4 text-[10px] text-muted-foreground" title={image.name}>
                {image.name}
              </p>
              <Button
                size="icon-xs"
                variant="ghost"
                className="absolute right-0 bottom-0"
                aria-label={`Remove ${image.name}`}
                disabled={!!draft.request}
                onClick={() =>
                  update((current) => ({
                    ...current,
                    images: current.images.filter((item) => item !== image),
                  }))
                }
              >
                <Trash2Icon />
              </Button>
            </div>
          ))}
        </div>
      )}
      {error && (
        <p className="text-[12px] text-error" role="alert">
          {error}
        </p>
      )}
    </div>
  )
}
