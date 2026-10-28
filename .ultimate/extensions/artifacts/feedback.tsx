import { CheckIcon, ChevronDownIcon, LoaderCircleIcon, SendIcon, Trash2Icon } from 'lucide-react'
import { useContext, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import {
  ActionError,
  Card,
  api,
  errorMessage,
  formatTime,
  useAction,
  useConversations,
  useConversation,
  useDocOf,
  useUltimate,
  useViewport,
} from '@/sdk'
import { WorkspacesDoc } from '../../../extensions/workspaces/refs.ts'
import { FEEDBACK_MAX_JSON_BYTES } from './types.ts'
import type { Artifact, ArtifactNote, FeedbackInput, FeedbackSummary } from './types.ts'
import { ReferenceImages } from './attachments.tsx'
import { Feedback, FeedbackList, FeedbackRead, ReviewComposerContext } from './ui.tsx'
import type { ReviewComposerValue } from './ui.tsx'

const short = (hash: string) => hash.slice(0, 8)
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
          className="cursor-pointer text-left text-muted-foreground hover:underline"
          type="button"
          onClick={() => {
            switchConversation(bundle.routedTo)
            showSurface('agent')
          }}
        >
          {conversationName(bundle.routedTo, conversations)}
        </button>
        {bundle.routedTo !== bundle.recipientConversation && (
          <p className="text-warning">
            Actually routed through @ultimate #{bundle.routedTo} for #{bundle.recipientConversation}
            .
          </p>
        )}
        <p className="font-mono text-[10px] text-muted-foreground">
          revision {short(bundle.contentHash)} · {bundle.notes.length} notes ·{' '}
          {bundle.images.length} images
        </p>
        {bundle.contentHash !== contentHash && (
          <p className="text-warning">Earlier revision · recheck targets</p>
        )}
        {bundle.submissionId !== undefined && (
          <p className="font-mono text-[10px] text-muted-foreground">
            Submission #{bundle.submissionId} · not a read or fix confirmation
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
    { enabled: bundle.images.length > 0, onError: () => {} },
  )
  return (
    <div className="mt-2 space-y-3">
      {bundle.notes.map((note, index) => (
        <div className="space-y-1" key={note.id}>
          <p className="font-mono text-[10px] text-muted-foreground">Note {index + 1}</p>
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
              Couldn’t load images.{' '}
              <button
                className="cursor-pointer underline"
                type="button"
                onClick={() => images.refetch()}
              >
                Retry
              </button>
            </p>
          )}
          {images.data && (
            <div className="flex flex-wrap gap-2">
              {images.data.images.map((image, index) => (
                <figure
                  // oxlint-disable-next-line react/no-array-index-key -- Immutable receipts fix image order, including duplicate names.
                  key={`${index}:${image.name}`}
                >
                  <img
                    className="size-16 rounded border border-border/70 object-contain"
                    alt={image.name}
                    src={`data:${image.mime};base64,${image.base64}`}
                  />
                  <figcaption className="text-[10px] text-muted-foreground">
                    {image.noteId
                      ? `Note ${bundle.notes.findIndex((note) => note.id === image.noteId) + 1}`
                      : 'General reference'}
                  </figcaption>
                </figure>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  )
}

/** Replace only a loaded input destination in this review scope; keep the landing log's read-only core. */
export function ArtifactComposer({ core }: { core: ReactNode; dock?: boolean }) {
  const review = useContext(ReviewComposerContext)
  const id = useConversation((conversation) => conversation.id)
  const workspaces = useDocOf(1, WorkspacesDoc)
  return review &&
    workspaces &&
    id !== undefined &&
    !Object.values(workspaces.landerConversations).includes(id) ? (
    <BatchComposer {...review} />
  ) : (
    core
  )
}

function BatchComposer({ artifact, draft, update, statuses, onContinueNote }: ReviewComposerValue) {
  const [sending, setSending] = useState(false)
  const [queueExpanded, setQueueExpanded] = useState<boolean>()
  const viewport = useViewport()
  const queueOpen = queueExpanded ?? viewport === 'desktop'
  const [error, setError] = useState<string>()
  const [receipt, setReceipt] = useState<FeedbackSummary>()
  const active = useRef(true)
  useEffect(() => {
    active.current = true
    return () => {
      active.current = false
    }
  }, [])
  const send = async () => {
    if (sending || draft.readingImages || (draft.editorId && !draft.request)) return
    const recipient = Number(draft.recipient)
    if (!draft.request && (!Number.isSafeInteger(recipient) || recipient <= 0)) {
      setError('Enter a positive conversation number for the destination.')
      return
    }
    const notes: ArtifactNote[] = [...draft.notes]
    if (draft.general.trim()) notes.push({ id: crypto.randomUUID(), text: draft.general.trim() })
    if (!draft.request && notes.length > 50) {
      setError('Send up to 50 notes, including the general message, per batch.')
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
    if (!draft.request && new Blob([JSON.stringify(request)]).size > FEEDBACK_MAX_JSON_BYTES) {
      setError(
        'Feedback payload is too large; remove an image or shorten notes. Your drafts are unchanged.',
      )
      return
    }
    const sentGeneral = draft.request ? draft.requestGeneral : draft.general
    update((current) => ({ ...current, request, requestGeneral: sentGeneral }))
    setSending(true)
    setError(undefined)
    try {
      const result = await api.action(Feedback, request)
      if ('rejected' in result) {
        // The native adapter confirms rejection before persistence or admission.
        update((current) =>
          current.request?.requestId === request.requestId
            ? { ...current, request: undefined, requestGeneral: undefined }
            : current,
        )
        if (active.current) setError(result.message)
        return
      }
      if (result.state === 'delivered')
        update((current) =>
          current.request?.requestId !== request.requestId
            ? current
            : {
                ...current,
                notes: current.notes.filter(
                  (note) =>
                    !request.notes.some((sent) => sent.id === note.id && sent.text === note.text) ||
                    (current.readingImages && current.readingNoteId === note.id) ||
                    current.images.some(
                      (image) => image.noteId === note.id && !request.images.includes(image),
                    ),
                ),
                images: current.images.filter((image) => !request.images.includes(image)),
                general: current.general === sentGeneral ? '' : current.general,
                request: undefined,
                requestGeneral: undefined,
              },
        )
      if (active.current) {
        setReceipt({
          ...result,
          images: result.images.map(({ name, mime, noteId }) => ({
            name,
            mime,
            ...(noteId ? { noteId } : {}),
          })),
        })
        if (result.state !== 'delivered')
          setError(
            result.deliveryError ?? 'Feedback saved; delivery is pending. Retry the same batch.',
          )
      }
    } catch (failure) {
      if (failure instanceof ActionError && failure.status === 413) {
        // HTTP admission rejected the entire request before persistence; editing a fresh batch is safe.
        update((current) =>
          current.request?.requestId === request.requestId
            ? { ...current, request: undefined, requestGeneral: undefined }
            : current,
        )
        if (active.current)
          setError(
            'Feedback is too large. Remove an image or shorten notes, then send again. Your drafts are unchanged.',
          )
      } else if (active.current)
        setError(`Delivery not confirmed: ${errorMessage(failure)}. Retry uses the same batch.`)
    } finally {
      if (active.current) setSending(false)
    }
  }
  const anchored = draft.notes.filter((note) => note.anchor)
  const ready =
    !!draft.request || !!draft.general.trim() || draft.notes.length > 0 || draft.images.length > 0
  return (
    <div
      className="shrink-0 space-y-2 border-t border-border/70 bg-background p-3"
      data-artifact-feedback
    >
      {(draft.notes.length > 0 || draft.editorId) && (
        <section className="space-y-2" aria-label="Unsent note queue" data-artifact-queue>
          <Button
            size="xs"
            variant="ghost"
            className="h-auto px-0 font-mono text-[11px] text-muted-foreground"
            aria-label="Queued notes"
            aria-expanded={queueOpen}
            onClick={() => setQueueExpanded(!queueOpen)}
          >
            Queued · {draft.notes.length} · not sent{' '}
            <ChevronDownIcon className={queueOpen ? 'rotate-180' : ''} />
          </Button>
          <div className={queueOpen ? 'max-h-[25vh] space-y-2 overflow-y-auto' : 'hidden'}>
            {draft.notes.map((note, index) => (
              <div className="space-y-1 border-b border-border/60 pb-2" key={note.id}>
                <div className="flex min-w-0 items-start gap-2">
                  <span className="pt-1 font-mono text-[10px] text-muted-foreground">
                    {index + 1}
                  </span>
                  <div className="min-w-0 flex-1">
                    {note.anchor && (
                      <blockquote className="line-clamp-2 border-l border-border pl-2 text-[11px] text-muted-foreground">
                        {note.anchor.text || note.anchor.selector}
                      </blockquote>
                    )}
                    <textarea
                      aria-label={`Queued note ${index + 1}`}
                      className="mt-1 w-full resize-y rounded border border-border/50 bg-background p-1.5 text-base outline-none focus-visible:ring-2 focus-visible:ring-brand/40 sm:text-[12px]"
                      rows={2}
                      maxLength={4000}
                      value={note.text}
                      onChange={(event) =>
                        update((current) => ({
                          ...current,
                          notes: current.notes.map((item) =>
                            item.id === note.id ? { ...item, text: event.target.value } : item,
                          ),
                        }))
                      }
                    />
                    {note.anchor &&
                      statuses[anchored.indexOf(note)] &&
                      statuses[anchored.indexOf(note)] !== 'same' && (
                        <p className="text-[10px] text-warning">
                          Target {statuses[anchored.indexOf(note)]} · original revision retained
                        </p>
                      )}
                    {note.layoutIssueIds && (
                      <p className="text-[10px] text-muted-foreground">
                        {note.layoutIssueIds.length} measured layout observations
                      </p>
                    )}
                    <ReferenceImages
                      draft={draft}
                      update={update}
                      noteId={note.id}
                      label={`Attach image to note ${index + 1}`}
                    />
                  </div>
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    aria-label={`Remove note ${index + 1}`}
                    disabled={sending || !!draft.request || !!draft.readingImages}
                    onClick={() =>
                      update((current) => ({
                        ...current,
                        notes: current.notes.filter((item) => item.id !== note.id),
                        images: current.images.filter((image) => image.noteId !== note.id),
                      }))
                    }
                  >
                    <Trash2Icon />
                  </Button>
                </div>
              </div>
            ))}
            {draft.editorId && (
              <Button size="sm" variant="outline" onClick={onContinueNote}>
                Continue selected note
              </Button>
            )}
          </div>
        </section>
      )}
      <textarea
        aria-label="General message"
        placeholder="Write a message for the agent…"
        className="w-full resize-y rounded-md border border-border/70 bg-background p-2 text-base outline-none focus-visible:ring-2 focus-visible:ring-brand/40 sm:text-[13px]"
        maxLength={4000}
        rows={2}
        value={draft.general}
        onChange={(event) => update((current) => ({ ...current, general: event.target.value }))}
      />
      <ReferenceImages draft={draft} update={update} />
      <div className="flex items-center justify-between gap-2">
        <span className="font-mono text-[10px] text-muted-foreground">
          Tab drafts · rev {short(draft.contentHash)}
        </span>
        <Button
          size="sm"
          disabled={
            !ready ||
            sending ||
            !!draft.readingImages ||
            (!draft.request &&
              (!!draft.editorId ||
                draft.notes.some(
                  (note) =>
                    !note.text.trim() && !draft.images.some((image) => image.noteId === note.id),
                )))
          }
          onClick={() => void send()}
        >
          {sending ? <LoaderCircleIcon className="animate-spin" /> : <SendIcon />}
          {sending ? 'Sending…' : 'Send to Agent'}
        </Button>
      </div>
      {draft.request && (
        <p className="text-[11px] text-muted-foreground">
          An earlier batch awaits confirmation. Send to Agent retries that exact batch; newer edits
          stay as drafts.
        </p>
      )}
      {draft.editorId && !draft.request && (
        <p className="text-[11px] text-muted-foreground">
          Queue or cancel the open note before sending.
        </p>
      )}
      {error && (
        <p className="text-[12px] text-error" role="alert">
          {error}
        </p>
      )}
      {receipt && <Receipt bundle={receipt} contentHash={artifact.contentHash} />}
    </div>
  )
}

export function FeedbackHistory({ artifact }: { artifact: Artifact }) {
  const history = useAction(FeedbackList, { artifactId: artifact.id }, { onError: () => {} })
  const { refetch } = history
  useEffect(() => {
    const timer = window.setInterval(() => {
      // useAction reports errors in state and resolves undefined, including aborted polls.
      // oxlint-disable-next-line typescript/no-floating-promises
      if (!document.hidden) void refetch()
    }, 2000)
    return () => window.clearInterval(timer)
  }, [refetch])
  return (
    <div className="space-y-3 p-3" data-artifact-history>
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
            onClick={() => history.refetch()}
            type="button"
          >
            Retry
          </button>
        </p>
      )}
      {history.data?.map((bundle) => (
        <Receipt bundle={bundle} contentHash={artifact.contentHash} key={bundle.id} />
      ))}
      {history.data?.length === 0 && (
        <p className="text-[12px] text-muted-foreground">No feedback sent yet.</p>
      )}
    </div>
  )
}
