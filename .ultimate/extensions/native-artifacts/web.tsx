import { FileCodeIcon, HistoryIcon, InfoIcon, MessageSquareIcon, RefreshCwIcon } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import {
  Card,
  StatusLine,
  defineWebExtension,
  useAction,
  useConversations,
  useExtensionUiState,
  useUltimate,
} from '@/sdk'
import type { ToolCallView } from '@/sdk'
import type { Artifact, ArtifactAnchor } from '../artifacts/types.ts'
import { FeedbackComposer, FeedbackHistory, NoteEditor, conversationName } from './feedback.tsx'
import type { NativeDocument, TargetStatus } from './types.ts'
import { List, Read, anyDrafts, hasDraft, useReviewDraft } from './ui.tsx'
import { ArtifactFrame } from './viewer.tsx'

// Keep both revisions across surface switches: notes refer to the displayed one, polls use the latest fetched one.
const displayed = new Map<string, NativeDocument>()
const fetched = new Map<string, NativeDocument>()
const short = (hash: string) => hash.slice(0, 8)

function PublishedArtifact({ call, core }: { call: ToolCallView; core: ReactNode }) {
  const [, select] = useExtensionUiState<string | null>('selected', null)
  const { showSurface } = useUltimate()
  const conversations = useConversations()
  const value = call.details
  if (call.status !== 'done' || !isArtifact(value)) return core
  return (
    <Card className="overflow-hidden" data-published-artifact={value.id}>
      <header className="flex items-center gap-2 border-b border-border/60 px-3 py-2 font-mono text-[11px] text-muted-foreground">
        <FileCodeIcon className="size-3.5 text-brand" />
        HTML artifact<span className="ml-auto">{short(value.contentHash)}</span>
      </header>
      <div className="space-y-2 px-3 py-3">
        <p className="text-[13px] font-medium">{value.title}</p>
        <p className="break-words text-[11px] text-muted-foreground">
          Made by {conversationName(value.ownerConversation, conversations)}
        </p>
        <Button
          onClick={() => {
            select(value.id)
            showSurface('native-artifacts')
          }}
          size="sm"
          variant="outline"
        >
          Open review
        </Button>
      </div>
    </Card>
  )
}

function isArtifact(value: unknown): value is Artifact {
  if (!value || typeof value !== 'object') return false
  const artifact = value as Partial<Artifact>
  return (
    typeof artifact.id === 'string' &&
    artifact.id.length > 0 &&
    typeof artifact.title === 'string' &&
    typeof artifact.contentHash === 'string' &&
    Number.isSafeInteger(artifact.ownerConversation) &&
    Number(artifact.ownerConversation) > 0 &&
    Number.isSafeInteger(artifact.recipientConversation) &&
    Number(artifact.recipientConversation) > 0 &&
    typeof artifact.updatedAt === 'number' &&
    !!artifact.source &&
    typeof artifact.source.workspace === 'string' &&
    typeof artifact.source.path === 'string' &&
    Array.isArray(artifact.source.assets) &&
    artifact.source.assets.every((asset) => typeof asset === 'string')
  )
}

function Review({ artifact }: { artifact: Artifact }) {
  const [latest, setLatest] = useState<NativeDocument | undefined>(() => fetched.get(artifact.id))
  const result = useAction(
    Read,
    {
      id: artifact.id,
      parentOrigin: window.location.origin,
      knownHash: latest?.artifact.contentHash,
    },
    { onError: () => {} },
  )
  const [document, setDocument] = useState<NativeDocument | undefined>(() =>
    displayed.get(artifact.id),
  )
  useEffect(() => {
    const value = result.data
    if (!value) return
    setLatest((current) => {
      if ('unchanged' in value) {
        if (!current) throw new Error('An initial artifact read must include its document.')
        if (
          JSON.stringify(current.artifact) === JSON.stringify(value.artifact) &&
          current.sourceError === value.sourceError
        )
          return current
        const next = { ...current, artifact: value.artifact, sourceError: value.sourceError }
        fetched.set(artifact.id, next)
        return next
      }
      fetched.set(artifact.id, value)
      return value
    })
  }, [result.data, artifact.id])
  useEffect(() => {
    if (!document && latest) {
      displayed.set(artifact.id, latest)
      setDocument(latest)
    } else if (
      document &&
      latest &&
      document.artifact.contentHash === latest.artifact.contentHash &&
      JSON.stringify(document.artifact) !== JSON.stringify(latest.artifact)
    ) {
      const next = { ...document, artifact: latest.artifact }
      displayed.set(artifact.id, next)
      setDocument(next)
    }
  }, [document, latest, artifact.id])
  const { refetch } = result
  useEffect(() => {
    const timer = window.setInterval(() => {
      // useAction reports errors in state and resolves undefined, including aborted polls.
      // oxlint-disable-next-line typescript/no-floating-promises
      if (!window.document.hidden) void refetch()
    }, 2000)
    return () => window.clearInterval(timer)
  }, [refetch])
  if (!document)
    return (
      <div className="flex flex-1 items-center justify-center p-6 text-[13px] text-muted-foreground">
        {result.error ? (
          <div className="space-y-3 text-center">
            <p className="text-error">Couldn’t open artifact: {result.error.message}</p>
            <Button onClick={() => result.refetch()} size="sm" variant="outline">
              Retry
            </Button>
          </div>
        ) : (
          'Loading artifact…'
        )}
      </div>
    )
  return (
    <LoadedReview
      document={document}
      latest={latest}
      onDocument={(next) => {
        displayed.set(artifact.id, next)
        setDocument(next)
      }}
      readError={result.error?.message}
      retry={() => void result.refetch()}
    />
  )
}

function LoadedReview({
  document,
  latest,
  onDocument,
  readError,
  retry,
}: {
  document: NativeDocument
  latest?: NativeDocument
  onDocument: (document: NativeDocument) => void
  readError?: string
  retry: () => void
}) {
  const artifact = document.artifact
  const [draft, update] = useReviewDraft(artifact)
  const [feedbackOpen, setFeedbackOpen] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [detailsOpen, setDetailsOpen] = useState(false)
  const [noteOpen, setNoteOpen] = useState(false)
  const [interacting, setInteracting] = useState(false)
  const [statuses, setStatuses] = useState<TargetStatus[]>([])
  const [frameError, setFrameError] = useState<string>()
  const conversations = useConversations()
  const { switchConversation, showSurface } = useUltimate()
  const pending = hasDraft(draft)
  const modalOpen = noteOpen || feedbackOpen || historyOpen || detailsOpen
  const blocked = pending || modalOpen || interacting
  const updateReady = !!latest && latest.artifact.contentHash !== artifact.contentHash
  const anchors = useMemo(
    () => [
      ...draft.notes.flatMap((note) => (note.anchor ? [note.anchor] : [])),
      ...(draft.anchor ? [draft.anchor] : []),
    ],
    [draft.notes, draft.anchor],
  )
  const apply = () => {
    if (!latest || blocked) return
    update((current) => ({
      ...current,
      contentHash: latest.artifact.contentHash,
      recipient: String(latest.artifact.recipientConversation),
    }))
    setStatuses([])
    setFrameError(undefined)
    onDocument(latest)
  }
  useEffect(() => {
    // The default picker stays active; only an actual gesture or unfinished feedback defers a newer revision.
    if (updateReady && !blocked) apply()
  })
  const target = (anchor: ArtifactAnchor) => {
    update((current) => (current.anchor ? current : { ...current, anchor, editor: '' }))
    setFrameError(undefined)
    setNoteOpen(true)
  }
  const sourceError = latest ? latest.sourceError : document.sourceError
  const count = draft.notes.length + (draft.anchor ? 1 : 0)
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-artifact-review={artifact.id}>
      <header className="flex h-10 shrink-0 items-center gap-1.5 border-b border-border/70 px-2">
        <FileCodeIcon className="size-3.5 shrink-0 text-muted-foreground" />
        <h1 className="min-w-0 flex-1 truncate text-[12px]" title={artifact.title}>
          {artifact.title}
        </h1>
        <Button onClick={() => setFeedbackOpen(true)} size="sm" variant="ghost">
          <MessageSquareIcon />
          Feedback{count ? ` · ${count}` : pending ? ' · Draft' : ''}
        </Button>
        <Button
          aria-label="Feedback history"
          title="Feedback history"
          onClick={() => setHistoryOpen(true)}
          size="icon-sm"
          variant="ghost"
        >
          <HistoryIcon />
        </Button>
        <Button
          aria-label="Artifact details"
          title="Artifact details"
          onClick={() => setDetailsOpen(true)}
          size="icon-sm"
          variant="ghost"
        >
          <InfoIcon />
        </Button>
      </header>
      <div className="relative min-h-0 flex-1" aria-label="Artifact preview">
        <ArtifactFrame
          document={document}
          mode={modalOpen || draft.anchor ? 'view' : 'annotate'}
          anchors={anchors}
          onTarget={target}
          onStatuses={setStatuses}
          onReady={() => setFrameError(undefined)}
          onError={setFrameError}
          onInteracting={setInteracting}
        />
        {(sourceError || readError || frameError || updateReady) && (
          <div
            className="absolute bottom-3 left-3 right-3 mx-auto w-fit max-w-[calc(100%-1.5rem)] rounded-md border border-border/70 bg-background px-3 py-2 text-[12px] shadow-sm"
            role="status"
          >
            {frameError ??
              (sourceError
                ? `Showing retained snapshot: ${sourceError}`
                : readError
                  ? `Refresh failed: ${readError}`
                  : 'Update ready · finish feedback to refresh.')}
            {readError && (
              <button className="ml-2 cursor-pointer underline" onClick={retry} type="button">
                Retry
              </button>
            )}
            {updateReady && !blocked && (
              <Button onClick={apply} size="xs" variant="ghost">
                <RefreshCwIcon />
                Apply update
              </Button>
            )}
          </div>
        )}
      </div>
      <Dialog open={noteOpen && !!draft.anchor} onOpenChange={setNoteOpen}>
        <DialogContent
          className="max-h-[85dvh] overflow-y-auto p-4 sm:max-w-sm"
          aria-describedby="native-artifacts-note-description"
        >
          <DialogTitle className="pr-6 text-[14px]">Add note</DialogTitle>
          <DialogDescription className="sr-only" id="native-artifacts-note-description">
            {draft.anchor?.kind === 'text' ? 'Selected text' : 'Selected element'}. Closing keeps
            this draft in your feedback.
          </DialogDescription>
          <NoteEditor draft={draft} update={update} onAdded={() => setNoteOpen(false)} />
        </DialogContent>
      </Dialog>
      <Dialog open={feedbackOpen} onOpenChange={setFeedbackOpen}>
        <DialogContent
          className="flex max-h-[85dvh] flex-col gap-0 overflow-hidden p-0 sm:max-w-lg"
          aria-describedby="native-artifacts-feedback-description"
        >
          <div className="border-b border-border/70 px-3 py-4">
            <DialogTitle className="pr-6 text-[14px]">Feedback</DialogTitle>
            <DialogDescription className="sr-only" id="native-artifacts-feedback-description">
              Review notes, add general feedback or reference images, then send to the maker.
            </DialogDescription>
          </div>
          <FeedbackComposer
            artifact={artifact}
            draft={draft}
            update={update}
            statuses={statuses}
            onContinueNote={() => {
              setFeedbackOpen(false)
              setNoteOpen(true)
            }}
          />
        </DialogContent>
      </Dialog>
      <Dialog open={historyOpen} onOpenChange={setHistoryOpen}>
        <DialogContent
          className="flex max-h-[85dvh] flex-col gap-0 overflow-hidden p-0 sm:max-w-lg"
          aria-describedby="native-artifacts-history-description"
        >
          <div className="border-b border-border/70 px-3 py-4">
            <DialogTitle className="pr-6 text-[14px]">Feedback history</DialogTitle>
            <DialogDescription className="sr-only" id="native-artifacts-history-description">
              Saved feedback and delivery receipts for this artifact.
            </DialogDescription>
          </div>
          <div className="min-h-0 overflow-y-auto">
            {historyOpen && <FeedbackHistory artifact={artifact} />}
          </div>
        </DialogContent>
      </Dialog>
      <Dialog open={detailsOpen} onOpenChange={setDetailsOpen}>
        <DialogContent
          className="max-h-[85dvh] overflow-y-auto p-4 sm:max-w-md"
          aria-describedby="native-artifacts-details-description"
        >
          <DialogTitle className="pr-6 text-[14px]">Artifact details</DialogTitle>
          <DialogDescription className="text-[12px]" id="native-artifacts-details-description">
            Click an element or drag over text to add a note. On phones, use native text-selection
            handles.
          </DialogDescription>
          <dl className="space-y-3 text-[12px]">
            <div>
              <dt className="text-muted-foreground">Made by</dt>
              <dd>
                <button
                  className="cursor-pointer text-left hover:underline"
                  onClick={() => {
                    switchConversation(artifact.ownerConversation)
                    showSurface('agent')
                  }}
                  type="button"
                >
                  {conversationName(artifact.ownerConversation, conversations)}
                </button>
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Original revision</dt>
              <dd className="break-all font-mono text-[11px]">{artifact.contentHash}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Local file</dt>
              <dd className="break-words font-mono text-[11px]">{artifact.source.path}</dd>
            </div>
          </dl>
          <label className="space-y-1.5 text-[12px] text-muted-foreground">
            Feedback to conversation
            <input
              aria-label="Feedback destination"
              className="mt-1 w-full rounded-md border border-border/70 bg-background px-2 py-2 text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
              inputMode="numeric"
              value={draft.recipient}
              disabled={!!draft.request}
              onChange={(event) =>
                update((current) => ({ ...current, recipient: event.target.value }))
              }
            />
          </label>
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            Static local HTML. Authored scripts and network access are blocked. Concluded or
            unavailable destinations route through @ultimate. Drafts stay in this tab, not on disk;
            send before reloading.
          </p>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function Artifacts() {
  const artifacts = useAction(List, null, { onError: () => {} })
  const [selected, select] = useExtensionUiState<string | null>('selected', null)
  const { refetch } = artifacts
  useEffect(() => {
    const timer = window.setInterval(() => {
      // useAction reports errors in state and resolves undefined, including aborted polls.
      // oxlint-disable-next-line typescript/no-floating-promises
      if (!document.hidden) void refetch()
    }, 2000)
    return () => window.clearInterval(timer)
  }, [refetch])
  const active = artifacts.data?.find((artifact) => artifact.id === selected) ?? artifacts.data?.[0]
  return (
    <>
      {artifacts.data && artifacts.data.length > 1 && (
        <nav className="border-b border-border/70 p-2">
          <select
            aria-label="Choose artifact"
            className="max-w-full rounded border border-border/70 bg-background px-2 py-1 text-[12px]"
            value={active?.id}
            onChange={(event) => select(event.target.value)}
          >
            {artifacts.data.map((artifact) => (
              <option key={artifact.id} value={artifact.id}>
                {artifact.title}
              </option>
            ))}
          </select>
        </nav>
      )}
      {active ? (
        <Review artifact={active} key={active.id} />
      ) : (
        <div className="flex min-w-0 flex-1 items-center justify-center p-6">
          <div className="max-w-sm space-y-3 text-center">
            <FileCodeIcon className="mx-auto size-6 text-muted-foreground" />
            <h1 className="text-[14px] font-medium">
              {artifacts.loading
                ? 'Loading artifacts…'
                : artifacts.error
                  ? 'Artifacts unavailable'
                  : 'No HTML artifacts yet'}
            </h1>
            <p className="text-[13px] leading-relaxed text-muted-foreground">
              {artifacts.error?.message ??
                'Ask the maker to publish a local HTML file. Click an element or drag over text to add feedback.'}
            </p>
            {artifacts.error && (
              <Button onClick={() => artifacts.refetch()} size="sm" variant="outline">
                Retry
              </Button>
            )}
          </div>
        </div>
      )}
      <StatusLine />
    </>
  )
}

function DraftGuard() {
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (anyDrafts()) event.preventDefault()
    }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [])
  return null
}

export default defineWebExtension({
  slots: { overlay: [DraftGuard] },
  surfaces: [
    {
      id: 'native-artifacts',
      title: 'Artifacts',
      icon: FileCodeIcon,
      description: 'Review local HTML and send precise feedback to its maker',
      component: Artifacts,
    },
  ],
  tools: { artifact_publish: PublishedArtifact },
})
