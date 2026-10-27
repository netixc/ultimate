import { FileIcon, LoaderCircleIcon, PaperclipIcon, RotateCcwIcon, XIcon } from 'lucide-react'
import { useRef } from 'react'
import type { ReactNode } from 'react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import {
  api,
  cn,
  ComposerAttachmentAdapter,
  defineWebExtension,
  errorMessage,
  formatBytes,
  useComposerAttachments,
  UserView,
} from '@/sdk'
import type { ComposerAttachment, ComposerSubmission, EntryRecord, UserMessage } from '@/sdk'
import { canRetry, chooseFiles, forgetFile, uploadFile } from './client.tsx'
import { fileReferenceIds, parseFileReference } from './format.ts'
import { RemoveAction, SendAction } from './refs.ts'

const focus = 'outline-none focus-visible:ring-2 focus-visible:ring-ring/50'

/** The browser owns the picker, so this works for files on the device showing Ultimate, not just the host. */
function FilePicker({ replace, children }: { replace?: string; children?: ReactNode }) {
  const draft = useComposerAttachments()
  const input = useRef<HTMLInputElement>(null)
  const compact = children !== undefined
  const button = (
    <button
      aria-label={compact ? undefined : 'Attach images or files'}
      className={cn(
        focus,
        compact
          ? 'shrink-0 rounded px-1.5 py-1 text-xs text-foreground/80 hover:bg-accent hover:text-foreground'
          : 'flex size-7 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground pointer-coarse:size-9',
        'disabled:pointer-events-none disabled:opacity-50',
      )}
      disabled={draft.disabled || draft.conversationId === undefined}
      onClick={() => input.current?.click()}
      onPointerDown={(event) => event.preventDefault()}
      type="button"
    >
      {children ?? <PaperclipIcon aria-hidden className="size-4" />}
    </button>
  )
  return (
    <>
      <input
        aria-label="Choose images or files"
        className="hidden"
        multiple
        onChange={async (event) => {
          const selected = Array.from(event.currentTarget.files ?? [])
          event.currentTarget.value = ''
          if (!draft.disabled) await chooseFiles(draft, selected, replace)
        }}
        ref={input}
        tabIndex={-1}
        type="file"
      />
      {compact ? (
        button
      ) : (
        <Tooltip>
          <TooltipTrigger asChild>{button}</TooltipTrigger>
          <TooltipContent>Attach images or files · up to 4, 10 MiB total</TooltipContent>
        </Tooltip>
      )}
    </>
  )
}

function AttachmentChip({ attachment }: { attachment: ComposerAttachment }) {
  const draft = useComposerAttachments()
  const { id, name, size, status, error } = attachment
  const retry = draft.conversationId !== undefined && canRetry(draft.conversationId, id)
  const failed = status === 'error'
  async function remove() {
    try {
      draft.setAttachments((current) => current.filter((file) => file.id !== id))
      if (draft.conversationId === undefined) return
      forgetFile(draft.conversationId, id)
      if (status === 'ready')
        await api.action(RemoveAction, { id }, { conversationId: draft.conversationId })
    } catch (failure) {
      draft.setError(errorMessage(failure))
    }
  }
  return (
    <div
      className={cn(
        'min-w-0 max-w-full rounded-lg border bg-background/60 px-2 py-1.5',
        failed ? 'border-error/40' : 'border-border/70',
      )}
      data-upload={status}
    >
      <div className="flex min-w-0 items-center gap-2">
        {status === 'uploading' ? (
          <LoaderCircleIcon
            aria-hidden
            className="size-3.5 shrink-0 text-muted-foreground motion-safe:animate-spin"
          />
        ) : (
          <FileIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
        )}
        <span className="min-w-0 truncate text-xs" title={name}>
          {name}
        </span>
        <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
          {formatBytes(size)}
        </span>
        <button
          aria-label={`Remove ${name}`}
          className={cn(
            focus,
            '-my-0.5 -mr-0.5 flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50',
          )}
          disabled={draft.disabled}
          onClick={() => void remove()}
          onPointerDown={(event) => event.preventDefault()}
          type="button"
        >
          <XIcon aria-hidden className="size-3" />
        </button>
      </div>
      {status === 'uploading' && (
        <p className="mt-0.5 pl-5.5 font-mono text-[10px] text-muted-foreground" role="status">
          Uploading…
        </p>
      )}
      {failed && (
        <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 pl-5.5">
          <p className="min-w-0 flex-1 basis-32 text-[11px] break-words text-error" role="alert">
            {retry ? (error ?? 'Upload failed.') : 'Choose this file again to attach it.'}
          </p>
          {retry ? (
            <button
              className={cn(
                focus,
                'flex shrink-0 items-center gap-1 rounded px-1.5 py-1 text-xs text-foreground/80 hover:bg-accent hover:text-foreground disabled:opacity-50',
              )}
              disabled={draft.disabled}
              onClick={() => void uploadFile(draft, id)}
              type="button"
            >
              <RotateCcwIcon aria-hidden className="size-3" /> Retry
            </button>
          ) : (
            <FilePicker replace={id}>Choose again</FilePicker>
          )}
        </div>
      )}
    </div>
  )
}

function Attachments() {
  const { attachments } = useComposerAttachments()
  if (!attachments.length) return null
  return (
    <div aria-label="Attached files" className="flex min-w-0 flex-wrap gap-2 px-3 pt-3">
      {attachments.map((attachment) => (
        <AttachmentChip attachment={attachment} key={attachment.id} />
      ))}
    </div>
  )
}

async function submit(input: ComposerSubmission, fallback: () => Promise<unknown>) {
  if (!input.attachments.length && !fileReferenceIds(input.text).length) return fallback()
  if (input.attachments.some((file) => file.status !== 'ready'))
    throw new Error('Wait for uploads to finish, or remove files that could not upload.')
  return api.action(
    SendAction,
    {
      text: input.text,
      images: input.images,
      files: input.attachments.map((file) => file.id),
      whenBusy: input.whenBusy,
      requestId: input.requestId,
    },
    { conversationId: input.conversationId },
  )
}

function UploadComposer({ core }: { core: ReactNode }) {
  return <ComposerAttachmentAdapter submit={submit}>{core}</ComposerAttachmentAdapter>
}

/** Keep the original text for copy/recall, while the bubble shows file names instead of transport markers. */
function UploadedInput({ entry, core }: { entry: EntryRecord; core: ReactNode }) {
  const message = entry.model?.find((item): item is UserMessage => item.role === 'user')
  if (!message) return core
  const text =
    typeof message.content === 'string'
      ? message.content
      : message.content.flatMap((item) => (item.type === 'text' ? [item.text] : [])).join('\n')
  const lines = text.split('\n')
  const references = lines.flatMap((line) => parseFileReference(line) ?? [])
  if (!references.length) return core
  const visible = lines
    .filter((line) => !parseFileReference(line))
    .join('\n')
    .trim()
  return (
    <UserView actionText={text} entry={entry} message={message} text={visible}>
      <div aria-label="Attached files" className="flex min-w-0 flex-wrap gap-2">
        {references.map((file) => (
          <div
            className="flex min-w-0 max-w-full items-center gap-2 rounded-md border border-border/70 bg-background/50 px-2 py-1.5"
            key={file.id}
          >
            <FileIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="min-w-0 truncate text-xs" title={file.name}>
              {file.name}
            </span>
            <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
              {formatBytes(file.size)}
            </span>
          </div>
        ))}
      </div>
    </UserView>
  )
}

export default defineWebExtension({
  composer: UploadComposer,
  entries: { 'pi.user': UploadedInput },
  slots: {
    'composer.actions': [{ component: FilePicker, order: -10 }],
    'composer.attachments': [Attachments],
  },
})
