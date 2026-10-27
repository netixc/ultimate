import { CheckIcon, ImagePlusIcon, LoaderCircleIcon, SendIcon, Trash2Icon } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  Card,
  api,
  errorMessage,
  formatTime,
  useAction,
  useConversations,
  useUltimate,
} from '@/sdk'
import type {
  Artifact,
  ArtifactNote,
  FeedbackSummary,
  FeedbackInput,
  ReferenceImage,
} from '../artifacts/types.ts'
import type { TargetStatus } from './types.ts'
import { Feedback, FeedbackList, FeedbackRead } from './ui.tsx'
import type { ReviewDraft } from './ui.tsx'

const field =
  'w-full rounded-md border border-border/70 bg-background px-2.5 py-2 text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-ring/50'
const short = (hash: string) => hash.slice(0, 8)
const imageBytes = (image: ReferenceImage) =>
  (image.base64.length * 3) / 4 -
  (image.base64.endsWith('==') ? 2 : image.base64.endsWith('=') ? 1 : 0)

export function conversationName(
  id: number,
  conversations: readonly { id: number; title?: string }[],
) {
  const title = conversations.find((conversation) => conversation.id === id)?.title
  return title ? `${title} #${id}` : `#${id}`
}

function Receipt({ bundle, contentHash }: { bundle: FeedbackSummary; contentHash: string }) {
  const [open, setOpen] = useState(false)
  const conversations = useConversations()
  const { switchConversation, showSurface } = useUltimate()
  return (
    <Card className="overflow-hidden" data-feedback-state={bundle.state}>
      <header className="flex flex-wrap items-center gap-1.5 border-b border-border/60 px-3 py-2 font-mono text-[11px]">
        {bundle.state === 'delivered' ? (
          <CheckIcon className="size-3 text-success" />
        ) : (
          <span className="size-1.5 rounded-full bg-warning" />
        )}
        <span>{bundle.state === 'delivered' ? 'Queued to inbox' : 'Saved · delivery pending'}</span>
        <time className="ml-auto text-muted-foreground">{formatTime(bundle.createdAt, true)}</time>
      </header>
      <div className="space-y-2 px-3 py-2.5 text-[12px]">
        <button
          className="cursor-pointer text-left text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
          onClick={() => {
            switchConversation(bundle.routedTo)
            showSurface('agent')
          }}
          type="button"
        >
          {conversationName(bundle.routedTo, conversations)}
        </button>
        {bundle.routedTo !== bundle.recipientConversation && (
          <p className="text-muted-foreground">
            Routed through @ultimate for #{bundle.recipientConversation}.
          </p>
        )}
        <p className="font-mono text-[11px] text-muted-foreground">
          revision {short(bundle.contentHash)} · {bundle.notes.length} notes ·{' '}
          {bundle.images.length} images
        </p>
        {bundle.contentHash !== contentHash && (
          <p className="text-warning">Earlier revision · recheck targets</p>
        )}
        {bundle.submissionId !== undefined && (
          <p className="font-mono text-[11px] text-muted-foreground">
            Submission #{bundle.submissionId}
          </p>
        )}
        {bundle.deliveryError && <p className="text-warning">{bundle.deliveryError}</p>}
        <details open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
          <summary className="cursor-pointer text-muted-foreground">Feedback</summary>
          {open && <ReceiptDetails bundle={bundle} />}
        </details>
      </div>
    </Card>
  )
}

function ReceiptDetails({ bundle }: { bundle: FeedbackSummary }) {
  const images = useAction(
    FeedbackRead,
    { artifactId: bundle.artifactId, id: bundle.id },
    {
      enabled: bundle.images.length > 0,
      onError: () => {},
    },
  )
  return (
    <div className="mt-2 space-y-3">
      {bundle.notes.map((note) => (
        <div className="space-y-1" key={note.id}>
          {note.anchor && (
            <blockquote className="border-l border-border pl-2 text-muted-foreground">
              {note.anchor.text || note.anchor.selector}
            </blockquote>
          )}
          <p className="whitespace-pre-wrap break-words">{note.text}</p>
        </div>
      ))}
      {bundle.images.length > 0 && (
        <>
          {images.loading && <p className="text-muted-foreground">Loading reference images…</p>}
          {images.error && (
            <p className="text-error" role="alert">
              Couldn’t load reference images.{' '}
              <button
                className="cursor-pointer underline"
                onClick={() => images.refetch()}
                type="button"
              >
                Retry
              </button>
            </p>
          )}
          {images.data && (
            <div className="flex flex-wrap gap-2">
              {images.data.images.map((image, index) => (
                <img
                  alt={image.name}
                  className="size-16 rounded border border-border/70 object-contain"
                  // oxlint-disable-next-line react/no-array-index-key -- Immutable receipts fix image order; names can repeat.
                  key={`${index}:${image.name}`}
                  src={`data:${image.mime};base64,${image.base64}`}
                  title={image.name}
                />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  )
}

export function FeedbackPanel({
  artifact,
  draft,
  update,
  statuses,
  onDraftAdded,
}: {
  artifact: Artifact
  draft: ReviewDraft
  update: (change: (current: ReviewDraft) => ReviewDraft) => void
  statuses: TargetStatus[]
  onDraftAdded: () => void
}) {
  const conversations = useConversations()
  const history = useAction(FeedbackList, { artifactId: artifact.id }, { onError: () => {} })
  const [sending, setSending] = useState(false)
  const readingImages = !!draft.readingImages
  const [error, setError] = useState<string>()
  const [imageError, setImageError] = useState<string>()
  const [receipt, setReceipt] = useState<FeedbackSummary>()
  const picker = useRef<HTMLInputElement>(null)
  const editor = useRef<HTMLTextAreaElement>(null)
  const imageLock = useRef(false)
  const active = useRef(true)
  useEffect(() => {
    active.current = true
    return () => {
      active.current = false
    }
  }, [])
  useEffect(() => {
    if (draft.anchor) editor.current?.focus()
  }, [draft.anchor])
  const { refetch } = history
  useEffect(() => {
    const timer = window.setInterval(() => {
      // useAction renders action errors and resolves undefined, including aborted polls.
      // oxlint-disable-next-line typescript/no-floating-promises
      if (!document.hidden) void refetch()
    }, 2000)
    return () => window.clearInterval(timer)
  }, [refetch])

  const addImages = async (files: File[]) => {
    if (!files.length || imageLock.current || draft.readingImages) return
    setImageError(undefined)
    if (draft.images.length + files.length > 4) {
      setImageError('Attach up to 4 reference images.')
      return
    }
    if (files.some((file) => !['image/png', 'image/jpeg', 'image/webp'].includes(file.type))) {
      setImageError('Choose PNG, JPEG or WebP images.')
      return
    }
    if (
      draft.images.reduce((sum, image) => sum + imageBytes(image), 0) +
        files.reduce((sum, file) => sum + file.size, 0) >
      10 * 1024 * 1024
    ) {
      setImageError('Reference images must total 10 MiB or less.')
      return
    }
    if (files.some((file) => !file.name.trim() || file.name.length > 200)) {
      setImageError('Image filenames must be between 1 and 200 characters.')
      return
    }
    imageLock.current = true
    update((current) => ({ ...current, readingImages: true }))
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
          }
        }),
      )
      update((current) => ({ ...current, images: [...current.images, ...images] }))
    } catch (failure) {
      if (active.current)
        setImageError(
          `Couldn’t decode reference images: ${errorMessage(failure)}. Choose valid images again.`,
        )
    } finally {
      imageLock.current = false
      update((current) => ({ ...current, readingImages: false }))
    }
  }

  const send = async () => {
    if (sending || imageLock.current) return
    const recipient = Number(draft.recipient)
    if (!draft.request && (!Number.isSafeInteger(recipient) || recipient <= 0)) {
      setError('Enter a positive conversation number for the destination.')
      return
    }
    const notes: ArtifactNote[] = [...draft.notes]
    if (draft.general.trim()) notes.push({ id: crypto.randomUUID(), text: draft.general.trim() })
    if (!draft.request && notes.length > 50) {
      setError('Send up to 50 notes per batch, including general feedback. Remove a note first.')
      return
    }
    const request: FeedbackInput = draft.request ?? {
      artifactId: artifact.id,
      requestId: crypto.randomUUID(),
      contentHash: draft.contentHash,
      recipientConversation: recipient,
      notes,
      images: [...draft.images],
    }
    const sentGeneral = draft.request ? draft.requestGeneral : draft.general
    update((current) => ({ ...current, request, requestGeneral: sentGeneral }))
    setSending(true)
    setError(undefined)
    try {
      const result = await api.action(Feedback, request)
      if (result.state === 'delivered') {
        update((current) =>
          current.request?.requestId !== request.requestId
            ? current
            : {
                ...current,
                notes: current.notes.filter(
                  (note) =>
                    !request.notes.some((sent) => sent.id === note.id && sent.text === note.text),
                ),
                images: current.images.filter((image) => !request.images.includes(image)),
                general: current.general === sentGeneral ? '' : current.general,
                request: undefined,
                requestGeneral: undefined,
              },
        )
      }
      if (active.current) {
        setReceipt({ ...result, images: result.images.map(({ name, mime }) => ({ name, mime })) })
        if (result.state !== 'delivered')
          setError(
            result.deliveryError ?? 'Feedback saved; delivery is pending. Retry the same batch.',
          )
        await history.refetch()
      }
    } catch (failure) {
      if (active.current)
        setError(`Delivery not confirmed: ${errorMessage(failure)}. Retry uses the same batch.`)
    } finally {
      if (active.current) setSending(false)
    }
  }

  const anchored = draft.notes.filter((note) => note.anchor)
  const ready =
    !!draft.request || !!draft.general.trim() || draft.notes.length > 0 || draft.images.length > 0
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-artifact-feedback>
      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-3">
        <section className="space-y-3">
          <div className="flex items-baseline justify-between gap-2">
            <h2 className="text-[13px] font-medium">
              Drafts{draft.notes.length > 0 ? ` · ${draft.notes.length}` : ''}
            </h2>
            <span className="font-mono text-[10px] text-muted-foreground">
              rev {short(draft.contentHash)}
            </span>
          </div>
          <p className="text-[12px] leading-relaxed text-muted-foreground">
            Not sent or saved to disk. Drafts stay in this tab when you switch surfaces; send before
            reloading.
          </p>
          {draft.notes.map((note, index) => {
            const status = note.anchor ? statuses[anchored.indexOf(note)] : undefined
            return (
              <div className="space-y-2 border-b border-border/60 pb-3" key={note.id}>
                <div className="flex items-start gap-2">
                  <span className="pt-0.5 font-mono text-[11px] text-muted-foreground">
                    {index + 1}
                  </span>
                  <div className="min-w-0 flex-1 space-y-1">
                    {note.anchor && (
                      <blockquote className="line-clamp-3 border-l border-border pl-2 text-[12px] text-muted-foreground">
                        {note.anchor.text || note.anchor.selector}
                      </blockquote>
                    )}
                    <p className="whitespace-pre-wrap break-words text-[13px] leading-relaxed">
                      {note.text}
                    </p>
                    {status && status !== 'same' && (
                      <p className="text-[11px] text-warning">
                        {status === 'changed' ? 'Target changed' : 'Target unavailable'} · original
                        revision {short(draft.contentHash)}
                      </p>
                    )}
                  </div>
                  <Button
                    aria-label={`Remove note ${index + 1}`}
                    disabled={sending || !!draft.request}
                    onClick={() =>
                      update((current) => ({
                        ...current,
                        notes: current.notes.filter((item) => item.id !== note.id),
                      }))
                    }
                    size="icon-xs"
                    variant="ghost"
                  >
                    <Trash2Icon />
                  </Button>
                </div>
              </div>
            )
          })}
          {draft.anchor && (
            <div className="space-y-2 rounded-md border border-border/70 p-2.5">
              <p className="font-mono text-[11px] text-muted-foreground">
                {draft.anchor.kind === 'text' ? 'Selected text' : 'Selected element'}
              </p>
              <blockquote className="max-h-24 overflow-y-auto border-l border-brand/50 pl-2 text-[12px] text-muted-foreground">
                {draft.anchor.text || draft.anchor.selector}
              </blockquote>
              <textarea
                aria-label="Note for selection"
                className={field}
                onChange={(event) =>
                  update((current) => ({ ...current, editor: event.target.value }))
                }
                placeholder="What should change here?"
                maxLength={4000}
                ref={editor}
                rows={3}
                value={draft.editor}
              />
              <div className="flex gap-2">
                <Button
                  disabled={!draft.editor.trim() || draft.notes.length >= 50}
                  onClick={() => {
                    update((current) => ({
                      ...current,
                      notes: [
                        ...current.notes,
                        {
                          id: crypto.randomUUID(),
                          text: current.editor.trim(),
                          anchor: current.anchor,
                        },
                      ],
                      editor: '',
                      anchor: undefined,
                    }))
                    onDraftAdded()
                  }}
                  size="sm"
                  variant="outline"
                >
                  Add note
                </Button>
                <Button
                  onClick={() =>
                    update((current) => ({ ...current, anchor: undefined, editor: '' }))
                  }
                  size="sm"
                  variant="ghost"
                >
                  Cancel
                </Button>
              </div>
            </div>
          )}
          <label className="block space-y-2 text-[12px]">
            <span className="text-muted-foreground">General feedback</span>
            <textarea
              className={field}
              onChange={(event) =>
                update((current) => ({ ...current, general: event.target.value }))
              }
              placeholder="Feedback about the whole artifact…"
              maxLength={4000}
              rows={4}
              value={draft.general}
            />
          </label>
          <div className="space-y-2">
            <input
              accept="image/png,image/jpeg,image/webp"
              aria-label="Choose reference images"
              className="hidden"
              multiple
              onChange={(event) => {
                // addImages handles file-read and validation errors in the image editor.
                // oxlint-disable-next-line typescript/no-floating-promises
                void addImages([...(event.target.files ?? [])])
                event.target.value = ''
              }}
              ref={picker}
              type="file"
            />
            <Button
              disabled={readingImages || draft.images.length >= 4}
              onClick={() => picker.current?.click()}
              size="sm"
              variant="ghost"
            >
              <ImagePlusIcon />
              {readingImages ? 'Reading images…' : 'Reference images'}
            </Button>
            <p className="text-[11px] text-muted-foreground">
              PNG, JPEG, WebP · up to 4 · 10 MiB total
            </p>
            {draft.images.length > 0 && (
              <div className="grid grid-cols-2 gap-2">
                {draft.images.map((image, index) => (
                  <div
                    className="relative min-w-0 rounded-md border border-border/70 p-2"
                    // oxlint-disable-next-line react/no-array-index-key -- Image tiles have no local state; duplicate names are permitted.
                    key={`${index}:${image.name}`}
                  >
                    <img
                      alt={image.name}
                      className="h-20 w-full object-contain"
                      src={`data:${image.mime};base64,${image.base64}`}
                    />
                    <p
                      className="mt-1 truncate pr-5 text-[11px] text-muted-foreground"
                      title={image.name}
                    >
                      {image.name}
                    </p>
                    <Button
                      aria-label={`Remove image ${index + 1}`}
                      className="absolute right-1 bottom-1"
                      disabled={sending || !!draft.request}
                      onClick={() =>
                        update((current) => ({
                          ...current,
                          images: current.images.filter((_, at) => at !== index),
                        }))
                      }
                      size="icon-xs"
                      variant="ghost"
                    >
                      <Trash2Icon />
                    </Button>
                  </div>
                ))}
              </div>
            )}
            {imageError && (
              <p className="text-[12px] text-error" role="alert">
                {imageError}
              </p>
            )}
          </div>
          <label className="block space-y-1.5 text-[12px] text-muted-foreground">
            <span>Send to conversation</span>
            <input
              className={field}
              disabled={sending || !!draft.request}
              inputMode="numeric"
              onChange={(event) =>
                update((current) => ({ ...current, recipient: event.target.value }))
              }
              type="text"
              value={draft.recipient}
            />
          </label>
          <p className="break-words text-[11px] leading-relaxed text-muted-foreground">
            {conversationName(Number(draft.recipient), conversations)}. Concluded or unavailable
            destinations route through @ultimate.
          </p>
        </section>
        <section className="space-y-2 border-t border-border/70 pt-4">
          <h2 className="text-[13px] font-medium">Feedback history</h2>
          {history.data?.length === 50 && (
            <p className="text-[11px] text-muted-foreground">
              Showing the latest 50 batches. Earlier feedback is retained.
            </p>
          )}
          {history.loading && !history.data && (
            <p className="text-[12px] text-muted-foreground">Loading feedback…</p>
          )}
          {history.error && (
            <p className="text-[12px] text-error" role="alert">
              Couldn’t load feedback.{' '}
              <button
                className="cursor-pointer underline"
                onClick={() => void history.refetch()}
                type="button"
              >
                Retry
              </button>
            </p>
          )}
          {receipt && !history.data?.some((item) => item.id === receipt.id) && (
            <Receipt bundle={receipt} contentHash={artifact.contentHash} />
          )}
          {history.data?.map((bundle) => (
            <Receipt bundle={bundle} contentHash={artifact.contentHash} key={bundle.id} />
          ))}
          {history.data?.length === 0 && !receipt && (
            <p className="text-[12px] text-muted-foreground">No feedback sent yet.</p>
          )}
        </section>
      </div>
      <div className="space-y-2 border-t border-border/70 bg-background p-3">
        {draft.request && (
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            An earlier batch is awaiting confirmation. Retry that exact batch first; newer edits
            stay as drafts.
          </p>
        )}
        {draft.anchor && (
          <p className="text-[11px] text-muted-foreground">
            Add or cancel the selected note before sending.
          </p>
        )}
        {error && (
          <p className="text-[12px] text-error" role="alert">
            {error}
          </p>
        )}
        <Button
          className="w-full"
          disabled={!ready || sending || readingImages || !!draft.anchor}
          onClick={() => void send()}
          size="sm"
        >
          {sending ? <LoaderCircleIcon className="animate-spin" /> : <SendIcon />}
          {sending ? 'Sending…' : draft.request ? 'Retry feedback' : 'Send feedback'}
        </Button>
      </div>
    </div>
  )
}
