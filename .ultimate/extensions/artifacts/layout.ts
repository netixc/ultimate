import { artifactId, digest } from './storage.ts'
import type {
  LayoutDismissInput,
  LayoutFinding,
  LayoutIssue,
  LayoutPassInput,
  LayoutState,
  LayoutViewport,
} from './types.ts'

export const MAX_LAYOUT_FINDINGS = 100
export const MAX_LAYOUT_ISSUES = 200
export const MAX_FEEDBACK_LAYOUT_ISSUES = 50

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Expected layout object')
  return value as Record<string, unknown>
}
function hash(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value))
    throw new Error('Expected layout content hash')
  return value
}
function boundedText(value: unknown, limit: number, name: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > limit)
    throw new Error(`Invalid layout ${name}`)
  return value
}
function viewport(value: unknown): LayoutViewport {
  const input = object(value)
  if (
    ![input.width, input.height].every(
      (n) => typeof n === 'number' && Number.isSafeInteger(n) && n >= 1 && n <= 100000,
    )
  )
    throw new Error('Invalid measured layout viewport')
  return { width: input.width as number, height: input.height as number }
}
export function layoutPassInput(value: unknown): LayoutPassInput {
  const input = object(value)
  if (
    typeof input.complete !== 'boolean' ||
    !Array.isArray(input.findings) ||
    input.findings.length > MAX_LAYOUT_FINDINGS
  )
    throw new Error(`Layout pass requires completeness and at most ${MAX_LAYOUT_FINDINGS} findings`)
  const findings = input.findings.map((item): LayoutFinding => {
    const finding = object(item)
    if (
      !['page-horizontal-overflow', 'clipped-control', 'unreachable-control'].includes(
        finding.rule as string,
      ) ||
      !['horizontal', 'vertical'].includes(finding.axis as string) ||
      typeof finding.overflowPx !== 'number' ||
      !Number.isFinite(finding.overflowPx) ||
      finding.overflowPx < 0 ||
      finding.overflowPx > 1000000
    )
      throw new Error('Invalid measured layout finding')
    if (finding.rule === 'page-horizontal-overflow' && finding.axis !== 'horizontal')
      throw new Error('Page horizontal overflow requires a horizontal axis')
    return {
      rule: finding.rule as LayoutFinding['rule'],
      selector: boundedText(finding.selector, 2048, 'selector'),
      axis: finding.axis as LayoutFinding['axis'],
      overflowPx: finding.overflowPx,
    }
  })
  return {
    artifactId: artifactId(input.artifactId),
    contentHash: hash(input.contentHash),
    viewport: viewport(input.viewport),
    complete: input.complete,
    findings,
    ...(input.error === undefined ? {} : { error: boundedText(input.error, 1000, 'error') }),
  }
}
export function layoutDismissInput(value: unknown): LayoutDismissInput {
  const input = object(value)
  return {
    artifactId: artifactId(input.artifactId),
    issueId: hash(input.issueId),
    contentHash: hash(input.contentHash),
  }
}
export function layoutView(state: LayoutState | undefined, currentHash: string): LayoutState {
  return {
    issues: (state?.issues ?? []).map((issue) => {
      if (issue.status !== 'dismissed' || issue.dismissedFor === currentHash) return issue
      const observed = { ...issue, status: 'open' as const }
      delete observed.dismissedFor
      return observed
    }),
    ...(state?.pass ? { pass: state.pass, stale: state.pass.contentHash !== currentHash } : {}),
  }
}
const sameViewport = (left: LayoutViewport, right: LayoutViewport) =>
  left.width === right.width && left.height === right.height
function issueId(input: LayoutPassInput, finding: LayoutFinding) {
  return digest(
    JSON.stringify([
      input.artifactId,
      finding.rule,
      finding.selector,
      finding.axis,
      input.viewport.width,
      input.viewport.height,
    ]),
  )
}
export function observeLayout(
  state: LayoutState | undefined,
  input: LayoutPassInput,
  currentHash: string,
  at: number,
): LayoutState {
  const current = layoutView(state, currentHash)
  if (input.contentHash !== currentHash)
    return {
      ...current,
      pass: {
        contentHash: input.contentHash,
        viewport: input.viewport,
        complete: false,
        at,
        error:
          'Stale layout pass: artifact content changed; measure the displayed current snapshot',
      },
      stale: true,
    }
  const issues = new Map(current.issues.map((issue) => [issue.id, issue]))
  const seen = new Set<string>()
  let omitted = 0
  for (const finding of input.findings) {
    const id = issueId(input, finding)
    seen.add(id)
    const previous = issues.get(id)
    if (!previous && issues.size >= MAX_LAYOUT_ISSUES) {
      omitted++
      continue
    }
    const dismissed = previous?.status === 'dismissed' && previous.dismissedFor === currentHash
    issues.set(id, {
      ...finding,
      id,
      viewport: input.viewport,
      contentHash: currentHash,
      lastSeenAt: at,
      status: dismissed ? 'dismissed' : 'open',
      ...(dismissed ? { dismissedFor: currentHash } : {}),
    })
  }
  const error = [
    input.error,
    omitted
      ? `Issue capacity reached (${MAX_LAYOUT_ISSUES}); ${omitted} findings not retained. Existing observations were preserved; this pass is incomplete.`
      : undefined,
  ]
    .filter(Boolean)
    .join('; ')
  const complete = input.complete && !error
  if (complete) {
    for (const [id, issue] of issues) {
      // Absence in the same revision or another exact viewport is not evidence of repair.
      if (
        !seen.has(id) &&
        issue.contentHash !== currentHash &&
        sameViewport(issue.viewport, input.viewport)
      )
        issues.set(id, { ...issue, status: 'resolved' })
    }
  }
  return {
    issues: [...issues.values()],
    pass: {
      contentHash: currentHash,
      viewport: input.viewport,
      complete,
      at,
      ...(error ? { error } : {}),
    },
    stale: false,
  }
}
export function dismissLayout(
  state: LayoutState | undefined,
  input: LayoutDismissInput,
  currentHash: string,
): LayoutState {
  if (input.contentHash !== currentHash)
    throw new Error('Cannot dismiss layout diagnostics for stale artifact content')
  const current = layoutView(state, currentHash)
  const issue = current.issues.find((item) => item.id === input.issueId)
  if (!issue) throw new Error('Unknown layout issue for this artifact')
  return {
    ...current,
    issues: current.issues.map((item) =>
      item.id === issue.id ? { ...item, status: 'dismissed', dismissedFor: currentHash } : item,
    ),
  }
}
export function feedbackLayoutIssues(state: LayoutState | undefined, ids: string[]): LayoutIssue[] {
  const unique = [...new Set(ids)]
  if (unique.length > MAX_FEEDBACK_LAYOUT_ISSUES)
    throw new Error(
      `At most ${MAX_FEEDBACK_LAYOUT_ISSUES} layout issues may be referenced per feedback batch`,
    )
  return unique.map((id) => {
    const issue = state?.issues.find((item) => item.id === id)
    if (!issue) throw new Error('Unknown layout issue for this artifact')
    return structuredClone(issue)
  })
}
