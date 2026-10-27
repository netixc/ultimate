import { NetworkIcon, SquareArrowOutUpRightIcon, TriangleAlertIcon } from 'lucide-react'
import { useEffect } from 'react'
import {
  Tool,
  ToolContent,
  ToolDiagnostics,
  ToolHeader,
  ToolOutput,
  ToolSection,
} from '@/components/ai/tool'
import {
  cn,
  defineWebExtension,
  useAction,
  useConversation,
  useDoc,
  useDocKind,
  useUltimate,
} from '@/sdk'
import type { ToolCallView } from '@/sdk'
import { openAgentSource } from '../../../extensions/subagents/ui.tsx'
import { Runs, Status } from './refs.ts'
import type { ReviewStatus } from './refs.ts'

const labels = {
  pending: 'Awaiting reply',
  received: 'Reply received',
  failed: 'Failed',
  missing: 'Missing reply',
}

function ReviewRun({ call }: { call: ToolCallView }) {
  const snapshot = call.details as ReviewStatus | undefined
  const id = snapshot?.id ?? (typeof call.args.id === 'string' ? call.args.id : undefined)
  const subagents = useDocKind('ultimate.subagents')
  const runs = useDoc(Runs)
  const status = useAction(Status, { id: id ?? '' }, { enabled: false })
  const { refetch } = status
  useEffect(() => {
    // oxlint-disable-next-line typescript/no-floating-promises -- useAction reports failures and resolves undefined rather than rejecting.
    if (id && (snapshot || runs?.runs[id])) void refetch()
  }, [id, subagents, runs, snapshot, refetch])
  const run = status.data ?? snapshot
  const received = run?.members.filter((member) => member.status === 'received').length ?? 0
  const action = typeof call.args.action === 'string' ? call.args.action : 'start'
  return (
    <Tool defaultOpen>
      <ToolHeader
        icon={NetworkIcon}
        meta={run ? `${received}/${run.members.length} replies` : undefined}
        name="review team"
        state={call.status}
        title={
          run ? (
            <span title={`${run.base}..${run.head}`}>
              {run.base.slice(0, 7)}..{run.head.slice(0, 7)}
            </span>
          ) : (
            action
          )
        }
      />
      <ToolContent>
        {run ? (
          <ToolSection className="space-y-2">
            <p className="text-[11px] text-muted-foreground">
              Replies received ≠ approved; lead decides.
            </p>
            {run.members.length ? (
              <ul className="divide-y divide-border/40">
                {run.members.map((member) => (
                  <Member key={member.conversationId} member={member} />
                ))}
              </ul>
            ) : (
              <p className="text-muted-foreground">No reviewers in this run.</p>
            )}
          </ToolSection>
        ) : (
          !status.error &&
          call.status !== 'error' && (
            <ToolSection>
              <p className="text-muted-foreground" role="status">
                {status.loading || call.status === 'running' || call.status === 'streaming'
                  ? 'Loading review team…'
                  : 'No review run to show.'}
              </p>
            </ToolSection>
          )
        )}
        {status.error && (
          <ToolSection>
            <p className="break-words text-error" role="alert">
              Could not refresh review status: {status.error.message}
            </p>
            {run && <p className="text-muted-foreground">Showing the last known status.</p>}
            <button
              className="cursor-pointer rounded-sm text-muted-foreground underline underline-offset-4 hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
              onClick={() => void refetch()}
              type="button"
            >
              Retry
            </button>
          </ToolSection>
        )}
        {call.status === 'error' && <ToolOutput isError output={call.output} />}
        <ToolDiagnostics diagnostics={call.diagnostics} />
      </ToolContent>
    </Tool>
  )
}

function Member({ member }: { member: ReviewStatus['members'][number] }) {
  const conversation = useConversation((value) => value.id)
  const { switchConversation } = useUltimate()
  return (
    <li className="py-2 first:pt-0 last:pb-0">
      <div className="flex items-start justify-between gap-3">
        <button
          className="group min-w-0 cursor-pointer rounded-sm text-left hover:text-brand focus-visible:outline-2 focus-visible:outline-ring"
          onClick={(event) => {
            const entry = Number(
              event.currentTarget.closest('[data-entry-id]')?.getAttribute('data-entry-id'),
            )
            if (conversation)
              openAgentSource(
                switchConversation,
                { conversation: member.conversationId, entry: member.answerId },
                { conversation, ...(entry ? { entry } : {}) },
              )
          }}
          title={`Open ${member.name} #${member.conversationId}`}
          type="button"
        >
          <span className="flex flex-wrap items-center gap-x-1.5">
            <span className="break-words text-foreground group-hover:text-brand">
              {member.name}
            </span>
            <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
              #{member.conversationId}
              <SquareArrowOutUpRightIcon className="size-3" />
            </span>
          </span>
          {(member.provider || member.model) && (
            <span className="mt-0.5 block break-words text-[10px] text-muted-foreground">
              {[member.provider, member.model].filter(Boolean).join(' / ')}
            </span>
          )}
        </button>
        <span
          className={cn(
            'shrink-0 pt-0.5 text-[11px]',
            member.status === 'failed'
              ? 'text-error'
              : member.status === 'missing'
                ? 'text-warning'
                : 'text-muted-foreground',
          )}
        >
          {labels[member.status]}
        </span>
      </div>
      {member.failures.length > 0 && (
        <details className="mt-1 text-[11px] text-warning">
          <summary className="cursor-pointer rounded-sm focus-visible:outline-2 focus-visible:outline-ring">
            <TriangleAlertIcon className="mr-1 inline size-3" />
            {member.failures.length} prior failure{member.failures.length === 1 ? '' : 's'}
          </summary>
          <ul className="mt-1 space-y-1 pl-4">
            {member.failures.map((failure, index) => (
              // oxlint-disable-next-line react/no-array-index-key -- Failures are an append-only log and may repeat.
              <li className="break-words whitespace-pre-wrap" key={index}>
                {failure}
              </li>
            ))}
          </ul>
        </details>
      )}
    </li>
  )
}

export default defineWebExtension({ tools: { review_run: ReviewRun } })
