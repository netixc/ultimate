import { TriangleAlertIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import type { LayoutState } from './types.ts'
import type { ReviewDraft } from './ui.tsx'

const titles = {
  'page-horizontal-overflow': 'Page extends horizontally',
  'clipped-control': 'Control is clipped',
  'unreachable-control': 'Control cannot be reached',
}

export function Issues({
  state,
  loading,
  error,
  open,
  setOpen,
  draft,
  update,
  retry,
  reveal,
  dismiss,
}: {
  state?: LayoutState
  loading: boolean
  error?: string
  open: boolean
  setOpen: (open: boolean) => void
  draft: ReviewDraft
  update: (change: (current: ReviewDraft) => ReviewDraft) => void
  retry: () => void
  reveal: (selector: string) => void
  dismiss: (id: string) => void
}) {
  const issues = state?.issues.filter((issue) => issue.status === 'open') ?? []
  const selected = issues.filter((issue) => draft.selectedIssues?.includes(issue.id))
  const all = issues.length > 0 && selected.length === issues.length
  const batchIds = new Set([
    ...draft.notes.flatMap((note) => note.layoutIssueIds ?? []),
    ...selected.map((issue) => issue.id),
  ])
  const limit = batchIds.size > 50 || draft.notes.length >= 50
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          size="sm"
          variant="ghost"
          aria-label={state ? `Issues · ${issues.length}` : 'Issues · checking'}
          className={issues.length ? 'text-warning' : ''}
        >
          <TriangleAlertIcon />
          Issues {state ? issues.length : '…'}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        side="bottom"
        className="flex max-h-[75dvh] w-[min(28rem,calc(100vw-1.5rem))] flex-col gap-3 p-3"
        data-artifact-issues
      >
        <div>
          <h2 className="text-[14px] font-medium">Layout issues</h2>
          <p className="mt-1 text-[12px] text-muted-foreground">
            {loading
              ? `Checking layout…${state ? ` · ${issues.length} retained open observations` : ''}`
              : state
                ? `${issues.length} open measured issues`
                : 'No layout result yet.'}
          </p>
        </div>
        {error && (
          <p className="text-[12px] text-error" role="alert">
            {error}{' '}
            <button type="button" className="cursor-pointer underline" onClick={retry}>
              Retry
            </button>
          </p>
        )}
        {state?.stale && (
          <p className="text-[12px] text-warning">
            This preview is an earlier revision. Findings keep their measured revision.
          </p>
        )}
        {state?.pass && !state.pass.complete && (
          <p className="text-[12px] text-warning">
            Incomplete check
            {state.pass.error ? `: ${state.pass.error}` : '. Some content could not be measured.'}
          </p>
        )}
        {!state?.pass && !loading && (
          <p className="text-[12px] text-muted-foreground">
            Waiting for the artifact’s measurement pass.
          </p>
        )}
        {issues.length > 0 && (
          <label className="flex items-center gap-2 text-[12px]">
            <input
              type="checkbox"
              checked={all}
              onChange={() =>
                update((current) => ({
                  ...current,
                  selectedIssues: all ? [] : issues.map((issue) => issue.id),
                }))
              }
            />
            Select all
            <span className="ml-auto text-muted-foreground">{selected.length} selected</span>
          </label>
        )}
        <div className="min-h-0 space-y-2 overflow-y-auto">
          {issues.map((issue) => (
            <div className="space-y-2 rounded-md border border-border/70 p-3" key={issue.id}>
              <label className="flex items-start gap-2 text-[12px] font-medium">
                <input
                  className="mt-0.5"
                  type="checkbox"
                  aria-label={`Select ${titles[issue.rule]} ${issue.selector}`}
                  checked={draft.selectedIssues?.includes(issue.id) ?? false}
                  onChange={(event) =>
                    update((current) => ({
                      ...current,
                      selectedIssues: event.target.checked
                        ? [...(current.selectedIssues ?? []), issue.id]
                        : current.selectedIssues?.filter((id) => id !== issue.id),
                    }))
                  }
                />
                {titles[issue.rule]}
              </label>
              <p className="text-[12px] text-muted-foreground">
                Measured {Math.round(issue.overflowPx)}px{' '}
                {issue.axis === 'horizontal' ? 'horizontally' : 'vertically'} outside its available
                area.
              </p>
              <p className="font-mono text-[10px] text-muted-foreground">
                {issue.viewport.width} × {issue.viewport.height} · rev{' '}
                {issue.contentHash.slice(0, 8)}
              </p>
              <p className="break-all font-mono text-[10px] text-muted-foreground">
                {issue.selector}
              </p>
              <div className="flex gap-2">
                <Button size="xs" variant="outline" onClick={() => reveal(issue.selector)}>
                  Reveal
                </Button>
                <Button
                  size="xs"
                  variant="ghost"
                  disabled={loading}
                  onClick={() => dismiss(issue.id)}
                >
                  Dismiss
                </Button>
              </div>
            </div>
          ))}
        </div>
        {!loading && state?.pass?.complete && issues.length === 0 && (
          <p className="text-[12px] text-muted-foreground">
            No open findings from the measured checks. This is not a full layout or accessibility
            review.
          </p>
        )}
        <div className="space-y-2 border-t border-border/70 pt-3">
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            Only page horizontal overflow and clipped or unreachable controls are checked. Queueing
            adds a draft, not a repair or send. Resolution requires a complete newer-content check
            at the same measured viewport.
          </p>
          {limit && (
            <p className="text-[11px] text-warning">
              A batch can reference up to 50 unique issues and contain up to 50 notes.
            </p>
          )}
          <Button
            className="w-full"
            size="sm"
            disabled={selected.length === 0 || limit}
            onClick={() => {
              const ids = selected.map((issue) => issue.id)
              update((current) => ({
                ...current,
                notes: [
                  ...current.notes,
                  {
                    id: crypto.randomUUID(),
                    text: `Please review and fix these ${ids.length} selected measured layout issues. Use the recorded rule, selector, overflow and viewport context; preserve unrelated content. These observations are not proof of a repair.`,
                    layoutIssueIds: ids,
                  },
                ],
                selectedIssues: [],
              }))
              setOpen(false)
            }}
          >
            Queue selected fixes
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  )
}
