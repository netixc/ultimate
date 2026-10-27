import {
  ArrowLeftIcon,
  FileCodeIcon,
  MessageSquareIcon,
  MousePointer2Icon,
  RefreshCwIcon,
  TypeIcon,
} from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import {
  Card,
  Conversation,
  Dock,
  Header,
  StatusLine,
  cn,
  defineWebExtension,
  useAction,
  useConversations,
  useExtensionUiState,
  useUltimate,
  useViewport,
} from '@/sdk'
import type { ToolCallView } from '@/sdk'
import type { Artifact, ArtifactAnchor } from '../artifacts/types.ts'
import { FeedbackPanel, conversationName } from './feedback.tsx'
import type { CaptureMode, NativeDocument, TargetStatus } from './types.ts'
import { List, Read, anyDrafts, hasDraft, useReviewDraft } from './ui.tsx'
import { ArtifactFrame } from './viewer.tsx'

// Retain the displayed revision across surface switches while its tab-local notes are still pending.
const displayed = new Map<string, NativeDocument>()
const fetched = new Map<string, NativeDocument>()
const short = (hash: string) => hash.slice(0, 8)

function PublishedArtifact({ call, core }: { call: ToolCallView; core: ReactNode }) {
  const [selected, select] = useExtensionUiState<string | null>('selected', null)
  const { showSurface } = useUltimate()
  const conversations = useConversations()
  const value = call.details
  if (call.status !== 'done' || !isArtifact(value)) return core
  return (
    <Card className="overflow-hidden" data-published-artifact={value.id}>
      <header className="flex items-center gap-2 border-b border-border/60 px-3 py-2 font-mono text-[11px] text-muted-foreground">
        <FileCodeIcon className="size-3.5 text-brand" />
        HTML artifact
        <span className="ml-auto">{short(value.contentHash)}</span>
      </header>
      <div className="space-y-2 px-3 py-3">
        <p className="text-[13px] font-medium">{value.title}</p>
        <p className="break-words text-[11px] text-muted-foreground">
          Made by {conversationName(value.ownerConversation, conversations)}
        </p>
        <Button
          onClick={() => {
            if (selected !== value.id) select(value.id)
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
      // useAction renders action errors and resolves undefined, including aborted polls.
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
            <Button onClick={() => void result.refetch()} size="sm" variant="outline">
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
  const [mobileFeedback, setMobileFeedback] = useExtensionUiState('feedbackOpen', false)
  const [mode, setMode] = useState<CaptureMode>('view')
  const [capture, setCapture] = useState(0)
  const [statuses, setStatuses] = useState<TargetStatus[]>([])
  const [frameError, setFrameError] = useState<string>()
  const conversations = useConversations()
  const pending = hasDraft(draft)
  const updateReady = !!latest && latest.artifact.contentHash !== artifact.contentHash
  const blocked = pending || mode !== 'view'
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
    // Ignore regenerated bridge channels for identical content; refresh only coherent, newer snapshots.
    if (updateReady && !blocked) apply()
  })
  const target = (anchor: ArtifactAnchor) => {
    update((current) => ({ ...current, anchor, editor: '' }))
    setMode('view')
    setFrameError(undefined)
    if (phone) setMobileFeedback(true)
  }
  const sourceError = latest ? latest.sourceError : document.sourceError
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-artifact-review={artifact.id}>
      <div className="space-y-2 border-b border-border/70 px-3 py-2.5">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0 flex-1">
            <h1 className="break-words text-[14px] font-medium">{artifact.title}</h1>
          </div>
          {phone && (
            <Button onClick={() => setMobileFeedback(!mobileFeedback)} size="sm" variant="outline">
              {mobileFeedback ? <ArrowLeftIcon /> : <MessageSquareIcon />}
              {mobileFeedback
                ? 'Artifact'
                : `Feedback${draft.notes.length ? ` · ${draft.notes.length}` : pending ? ' · Draft' : ''}`}
            </Button>
          )}
        </div>
        <div className="space-y-1 font-mono text-[11px] text-muted-foreground">
          <p className="flex min-w-0 items-baseline gap-1">
            <span className="shrink-0">Made by</span>
            <span className="truncate">
              {conversations.find((item) => item.id === artifact.ownerConversation)?.title ??
                'conversation'}
            </span>
            <span className="shrink-0">
              #{artifact.ownerConversation} · rev {short(artifact.contentHash)}
            </span>
          </p>
          <p className="flex min-w-0 items-baseline gap-1">
            <span className="shrink-0">Feedback to</span>
            <span className="truncate">
              {conversations.find((item) => item.id === Number(draft.recipient))?.title ??
                'conversation'}
            </span>
            <span className="shrink-0">
              {Number.isSafeInteger(Number(draft.recipient)) && Number(draft.recipient) > 0
                ? `#${draft.recipient}`
                : 'not set'}
            </span>
          </p>
        </div>
        <p className="text-[11px] text-muted-foreground">
          Static review · scripts and network access blocked.
        </p>
        {sourceError && (
          <p className="text-[12px] text-warning" role="status">
            Showing retained snapshot: {sourceError}
          </p>
        )}
        {readError && (
          <p className="text-[12px] text-warning" role="status">
            Refresh failed: {readError}{' '}
            <button className="cursor-pointer underline" onClick={retry} type="button">
              Retry
            </button>
          </p>
        )}
        {updateReady && (
          <div className="flex flex-wrap items-center gap-2 text-[12px] text-warning" role="status">
            <RefreshCwIcon className="size-3" />
            Update ready
            {blocked ? (
              ' · finish or remove drafts and exit annotation mode to refresh.'
            ) : (
              <Button onClick={apply} size="xs" variant="outline">
                Apply update
              </Button>
            )}
          </div>
        )}
      </div>
      <div className="flex min-h-0 flex-1">
        <section
          aria-label="Artifact preview"
          className={cn(
            'flex min-h-0 min-w-0 flex-1 flex-col',
            phone && mobileFeedback && 'hidden',
          )}
        >
          <div className="flex flex-wrap items-center gap-1 border-b border-border/70 px-2 py-1.5">
            <Button
              aria-pressed={mode === 'element'}
              disabled={!!draft.anchor}
              onClick={() => {
                setMode(mode === 'element' ? 'view' : 'element')
                setFrameError(undefined)
              }}
              size="sm"
              variant={mode === 'element' ? 'secondary' : 'ghost'}
            >
              <MousePointer2Icon />
              Pick element
            </Button>
            <Button
              aria-pressed={mode === 'text'}
              disabled={!!draft.anchor}
              onClick={() => {
                setMode(mode === 'text' ? 'view' : 'text')
                setFrameError(undefined)
              }}
              size="sm"
              variant={mode === 'text' ? 'secondary' : 'ghost'}
            >
              <TypeIcon />
              Select text
            </Button>
            {mode !== 'view' && (
              <Button
                onClick={() => {
                  setMode('view')
                  setFrameError(undefined)
                }}
                size="sm"
                variant="ghost"
              >
                Done
              </Button>
            )}
          </div>
          {mode === 'element' && (
            <p
              className="border-b border-border/70 px-3 py-2 text-[12px] text-muted-foreground"
              role="status"
            >
              Select an element in the artifact. Links and controls won’t activate.
            </p>
          )}
          {mode === 'text' && (
            <div className="flex flex-wrap items-center gap-2 border-b border-border/70 px-3 py-2">
              <p className="min-w-0 flex-1 text-[12px] text-muted-foreground">
                Select text naturally, then capture it. On phones, use long-press and the selection
                handles.
              </p>
              <Button
                onPointerDown={(event) => event.preventDefault()}
                onClick={() => setCapture((current) => current + 1)}
                size="sm"
                variant="outline"
              >
                Note selected text
              </Button>
            </div>
          )}
          {draft.anchor && phone && (
            <Button
              className="m-2"
              onClick={() => setMobileFeedback(true)}
              size="sm"
              variant="outline"
            >
              Finish selected note
            </Button>
          )}
          {frameError && (
            <p className="border-b border-border/70 px-3 py-2 text-[12px] text-error" role="alert">
              {frameError}
            </p>
          )}
          <div className="min-h-0 flex-1">
            <ArtifactFrame
              anchors={anchors}
              capture={capture}
              document={document}
              mode={mode}
              onError={setFrameError}
              onReady={() => setFrameError(undefined)}
              onStatuses={setStatuses}
              onTarget={target}
            />
          </div>
        </section>
        <aside
          aria-label="Artifact feedback"
          className={cn(
            'flex min-h-0 flex-col border-border/70 bg-background',
            phone ? (mobileFeedback ? 'w-full' : 'hidden') : 'w-[21rem] shrink-0 border-l',
          )}
        >
          {!phone && (
            <div className="flex h-10 shrink-0 items-center border-b border-border/70 px-3 font-mono text-[11px] text-muted-foreground">
              Feedback
            </div>
          )}
          <FeedbackPanel
            artifact={artifact}
            draft={draft}
            onDraftAdded={() => setMode('view')}
            statuses={statuses}
            update={update}
          />
        </aside>
      </div>
    </div>
  )
}

function Artifacts() {
  const artifacts = useAction(List, null, { onError: () => {} })
  const [selected, select] = useExtensionUiState<string | null>('selected', null)
  const viewport = useViewport()
  const [conversationOpen, setConversationOpen] = useState(false)
  const { refetch } = artifacts
  useEffect(() => {
    const timer = window.setInterval(() => {
      // useAction renders action errors and resolves undefined, including aborted polls.
      // oxlint-disable-next-line typescript/no-floating-promises
      if (!document.hidden) void refetch()
    }, 2000)
    return () => window.clearInterval(timer)
  }, [refetch])
  const active = artifacts.data?.find((artifact) => artifact.id === selected) ?? artifacts.data?.[0]
  return (
    <>
      <Header>
        <FileCodeIcon className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="text-[13px]">Artifacts</span>
        {artifacts.data && artifacts.data.length > 1 && (
          <select
            aria-label="Choose artifact"
            className="min-w-0 max-w-56 rounded border border-border/70 bg-background px-2 py-1 text-[12px]"
            onChange={(event) => select(event.target.value)}
            value={active?.id}
          >
            {artifacts.data.map((artifact) => (
              <option key={artifact.id} value={artifact.id}>
                {artifact.title}
              </option>
            ))}
          </select>
        )}
        {viewport === 'desktop' && (
          <Button
            aria-pressed={conversationOpen}
            onClick={() => setConversationOpen(!conversationOpen)}
            size="xs"
            variant="ghost"
          >
            Conversation
          </Button>
        )}
      </Header>
      <div className="flex min-h-0 flex-1">
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
                {artifacts.error
                  ? artifacts.error.message
                  : 'Ask the maker to publish a local HTML file. Review it here, point to an element or text, and send feedback to its maker.'}
              </p>
              {artifacts.error && (
                <Button onClick={() => void artifacts.refetch()} size="sm" variant="outline">
                  Retry
                </Button>
              )}
            </div>
          </div>
        )}
        {viewport === 'desktop' && conversationOpen && (
          <Dock title="conversation">
            <Conversation variant="dock" />
          </Dock>
        )}
      </div>
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
