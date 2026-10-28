import {
  FileCodeIcon,
  InfoIcon,
  PanelRightCloseIcon,
  PanelRightOpenIcon,
  RefreshCwIcon,
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { Switch } from '@/components/ui/switch'
import {
  Card,
  ComposerRedirect,
  Conversation,
  ConversationScope,
  StatusLine,
  api,
  cn,
  defineWebExtension,
  errorMessage,
  useAction,
  useConversations,
  useExtensionUiState,
  useUltimate,
  useViewport,
} from '@/sdk'
import type { ToolCallView } from '@/sdk'
import type { Artifact, ArtifactAnchor, LayoutState } from '../artifacts/types.ts'
import { ArtifactComposer, FeedbackHistory, conversationName } from './feedback.tsx'
import { Issues } from './issues.tsx'
import { NoteCard } from './note-card.tsx'
import type {
  LayoutDiagnostics,
  NativeDocument,
  RevealTarget,
  TargetRect,
  TargetStatus,
} from './types.ts'
import {
  LayoutDismiss,
  LayoutPass,
  LayoutRead,
  List,
  Read,
  ReviewComposerContext,
  anyDrafts,
  hasDraft,
  useReviewDraft,
} from './ui.tsx'
import { ArtifactFrame } from './viewer.tsx'

const displayed = new Map<string, NativeDocument>()
const fetched = new Map<string, NativeDocument>()
const short = (hash: string) => hash.slice(0, 8)
const safeComposerTarget = {
  placeholder: 'Use Send to Agent in the review composer',
  send: async () => {
    throw new Error('Use Send to Agent in the review composer. Nothing was sent.')
  },
}

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
      // useAction reports failures in state and resolves undefined, including aborted polls.
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
  const viewport = useViewport()
  const phone = viewport !== 'desktop'
  const [sidebarOpen, setSidebarOpen] = useState(() => window.innerWidth >= 1024)
  const [annotate, setAnnotate] = useState(true)
  const [issuesOpen, setIssuesOpen] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [detailsOpen, setDetailsOpen] = useState(false)
  const [interacting, setInteracting] = useState(false)
  const [statuses, setStatuses] = useState<TargetStatus[]>([])
  const [rect, setRect] = useState<TargetRect | null>(null)
  const [reveal, setReveal] = useState<RevealTarget>()
  const [focusNote, setFocusNote] = useState(0)
  const [frameError, setFrameError] = useState<string>()
  const frame = useRef<HTMLElement>(null)
  const layout = useAction(LayoutRead, { artifactId: artifact.id }, { onError: () => {} })
  const [layoutState, setLayoutState] = useState<LayoutState>()
  const currentChannel = useRef(document.channel)
  currentChannel.current = document.channel
  // Serialize frame-local snapshots; a new document starts an independent queue.
  const layoutQueue = useRef(Promise.resolve())
  const [checking, setChecking] = useState(true)
  const [layoutError, setLayoutError] = useState<string>()
  const lastPass = useRef<LayoutDiagnostics | undefined>(undefined)
  useEffect(() => {
    if (layout.data) setLayoutState((current) => current ?? layout.data)
  }, [layout.data])
  useEffect(() => {
    setChecking(true)
    lastPass.current = undefined
    layoutQueue.current = Promise.resolve()
  }, [document.channel])
  const conversations = useConversations()
  const { switchConversation, showSurface } = useUltimate()
  const recipient = Number(draft.recipient)
  const validRecipient = Number.isSafeInteger(recipient) && recipient > 0
  const conversationId = validRecipient ? recipient : artifact.recipientConversation
  const pending = hasDraft(draft)
  const blocked = pending || historyOpen || detailsOpen || issuesOpen || interacting
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
    if (updateReady && !blocked) apply()
  })
  const target = (anchor: ArtifactAnchor, targetRect: TargetRect) => {
    let accepted = false
    update((current) => {
      if (current.editorId) return current
      accepted = true
      return { ...current, anchor, editorId: crypto.randomUUID(), editor: '' }
    })
    if (accepted) {
      setRect(targetRect)
      setFrameError(undefined)
    }
  }
  const diagnostics = (pass: LayoutDiagnostics) => {
    lastPass.current = pass
    const request = layoutQueue.current.then(async () => {
      if (currentChannel.current !== document.channel) return
      setChecking(true)
      try {
        const state = await api.action(LayoutPass, {
          ...pass,
          artifactId: artifact.id,
          contentHash: artifact.contentHash,
        })
        if (currentChannel.current !== document.channel) return
        setLayoutState(state)
        setLayoutError(undefined)
      } catch (failure) {
        if (currentChannel.current === document.channel)
          setLayoutError(`Couldn’t save layout check: ${errorMessage(failure)}`)
      } finally {
        if (currentChannel.current === document.channel) setChecking(false)
      }
    })
    layoutQueue.current = request
    return request
  }
  const dismiss = (issueId: string) => {
    const request = layoutQueue.current.then(async () => {
      if (currentChannel.current !== document.channel) return
      setChecking(true)
      try {
        const state = await api.action(LayoutDismiss, {
          artifactId: artifact.id,
          issueId,
          contentHash: artifact.contentHash,
        })
        if (currentChannel.current !== document.channel) return
        setLayoutState(state)
        setLayoutError(undefined)
        update((current) => ({
          ...current,
          selectedIssues: current.selectedIssues?.filter((id) => id !== issueId),
        }))
      } catch (failure) {
        if (currentChannel.current === document.channel)
          setLayoutError(`Couldn’t dismiss issue: ${errorMessage(failure)}`)
      } finally {
        if (currentChannel.current === document.channel) setChecking(false)
      }
    })
    layoutQueue.current = request
    return request
  }
  const sourceError = latest ? latest.sourceError : document.sourceError
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-artifact-review={artifact.id}>
      <header className="flex h-11 shrink-0 items-center gap-2 border-b border-border/70 px-2">
        <div className="min-w-0 flex-1">
          <h1 className="hidden truncate text-[12px] sm:block" title={artifact.title}>
            {artifact.title}
          </h1>
        </div>
        <Issues
          state={layoutState}
          loading={checking || layout.loading}
          error={layoutError ?? (!layoutState ? layout.error?.message : undefined)}
          open={issuesOpen}
          setOpen={setIssuesOpen}
          draft={draft}
          update={update}
          retry={() => (lastPass.current ? diagnostics(lastPass.current) : layout.refetch())}
          reveal={(selector) =>
            setReveal((current) => ({ selector, request: (current?.request ?? 0) + 1 }))
          }
          dismiss={dismiss}
        />
        <label className="flex items-center gap-1.5 text-[12px]">
          <Switch aria-label="Annotate" checked={annotate} onCheckedChange={setAnnotate} />
          <span>Annotate</span>
        </label>
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label={sidebarOpen ? 'Hide sidebar' : 'Show sidebar'}
          title={sidebarOpen ? 'Hide sidebar' : 'Show sidebar'}
          onClick={() => setSidebarOpen(!sidebarOpen)}
        >
          {sidebarOpen ? <PanelRightCloseIcon /> : <PanelRightOpenIcon />}
        </Button>
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label="Artifact details"
          title="Artifact details"
          onClick={() => setDetailsOpen(true)}
        >
          <InfoIcon />
        </Button>
      </header>
      <div className="relative flex min-h-0 flex-1">
        <section
          ref={frame}
          className="relative min-h-0 min-w-0 flex-1"
          aria-label="Artifact preview"
          data-artifact-frame
        >
          <ArtifactFrame
            document={document}
            mode={
              annotate && !draft.editorId && !historyOpen && !detailsOpen && !issuesOpen
                ? 'annotate'
                : 'view'
            }
            anchors={anchors}
            selected={draft.anchor}
            reveal={reveal}
            onTarget={target}
            onRect={(next) => {
              if (draft.editorId) setRect(next)
            }}
            onStatuses={setStatuses}
            onReady={() => setFrameError(undefined)}
            onError={setFrameError}
            onInteracting={setInteracting}
            onDiagnostics={diagnostics}
          />
          {(sourceError || readError || frameError || updateReady) && (
            <div
              className="absolute right-3 bottom-3 left-3 mx-auto w-fit max-w-[calc(100%-1.5rem)] rounded-md border border-border/70 bg-background px-3 py-2 text-[12px] shadow-sm"
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
        </section>
        <aside
          aria-label="Conversation"
          data-artifact-conversation
          className={cn(
            'flex min-h-0 shrink-0 flex-col wrap-anywhere border-border/70 bg-background',
            phone
              ? 'absolute inset-x-0 bottom-0 z-30 h-3/4 rounded-t-lg border-t shadow-xl'
              : 'w-[24rem] border-l',
            !sidebarOpen && 'hidden',
          )}
        >
          <div className="shrink-0 space-y-2 border-b border-border/70 p-3">
            <div className="flex items-center justify-between gap-2">
              <h2 className="text-[13px] font-medium">Conversation</h2>
              <button
                type="button"
                className="cursor-pointer text-[11px] text-muted-foreground hover:underline"
                onClick={() => setHistoryOpen(true)}
              >
                Receipts
              </button>
            </div>
            <label className="flex items-center gap-2 text-[11px] text-muted-foreground">
              Send to conversation
              <input
                aria-label="Feedback destination"
                inputMode="numeric"
                className="w-20 rounded border border-border/70 bg-background px-2 py-1 text-base text-foreground outline-none focus-visible:ring-2 focus-visible:ring-brand/40 sm:text-[12px]"
                value={draft.recipient}
                disabled={!!draft.request}
                onChange={(event) =>
                  update((current) => ({ ...current, recipient: event.target.value }))
                }
              />
            </label>
            <p className="text-[10px] leading-relaxed text-muted-foreground">
              Full conversation #{conversationId}; it may include other work.{' '}
              {!validRecipient && 'Enter a valid destination before sending.'}
            </p>
          </div>
          <ReviewComposerContext.Provider
            value={{
              artifact,
              draft,
              update,
              statuses,
              onContinueNote: () => {
                setFocusNote((current) => current + 1)
                if (phone) setSidebarOpen(false)
              },
            }}
          >
            <ConversationScope id={conversationId}>
              <ComposerRedirect to={safeComposerTarget}>
                <Conversation variant="dock" />
              </ComposerRedirect>
            </ConversationScope>
          </ReviewComposerContext.Provider>
        </aside>
      </div>
      {draft.editorId && (
        <NoteCard
          draft={draft}
          update={update}
          rect={rect}
          frame={frame.current}
          focus={focusNote}
          onClose={() => setRect(null)}
        />
      )}
      <Dialog open={historyOpen} onOpenChange={setHistoryOpen}>
        <DialogContent
          className="flex max-h-[85dvh] flex-col gap-0 overflow-hidden p-0 sm:max-w-lg"
          aria-describedby="native-artifacts-history-description"
        >
          <div className="border-b border-border/70 px-3 py-4">
            <DialogTitle className="pr-6 text-[14px]">Feedback receipts</DialogTitle>
            <DialogDescription className="sr-only" id="native-artifacts-history-description">
              Saved feedback and actual delivery routes, not read or repair confirmations.
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
            Turn Annotate on, then click an element or drag over text. Queue notes first; only Send
            to Agent sends the batch.
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
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            Static local HTML: authored scripts and network are blocked. Queued notes and selected
            fixes stay only in this tab until sent. Concluded or unavailable destinations route
            through @ultimate; the actual route appears on the receipt. Native conversation replies
            may discuss unrelated work.
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
      // useAction reports failures in state and resolves undefined, including aborted polls.
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
                'Ask the maker to publish local HTML, then annotate and queue feedback for its maker.'}
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
  composer: ArtifactComposer,
  surfaces: [
    {
      id: 'native-artifacts',
      title: 'Artifacts',
      icon: FileCodeIcon,
      description: 'Annotate, queue and explicitly send feedback to the maker',
      component: Artifacts,
    },
  ],
  tools: { artifact_publish: PublishedArtifact },
})
