/** Review execution snapshots and read-only collection; received replies are not review approval. */
import { actionRef, docRef } from '../../../shared/extension-api.ts'

export type ReviewStatus = {
  id: string
  base: string
  head: string
  assignment: string
  members: {
    name: string
    conversationId: number
    status: 'pending' | 'received' | 'failed' | 'missing'
    answerId?: number
    provider?: string
    model?: string
    text?: string
    failures: string[]
  }[]
}
/** `{ id }` → actual reply status for a run owned by the shown conversation. */
export const Status = actionRef<{ id: string }, ReviewStatus>('review-run', 'status')
/** Immutable run inputs and selected children on their review lead. */
export const Runs = docRef<{ runs: Record<string, { base: string; head: string }> }>(
  'review-run.runs',
)
