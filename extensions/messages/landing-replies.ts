/** The finite message/reply frontier drained by the lander's single conclusion decision. */
import { ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import type { ConversationId, Cursor, EntryId, TaskId, Tx } from '@earendil-works/pi-durable'
import type { ExtensionHost } from '../../server/extensions.ts'
import type { LandingRepliesService } from '../workspaces/api.ts'
import { Subagents, SubagentsApi } from '../subagents/api.ts'
import type { ReplySettlement } from '../subagents/api.ts'
import type { Message } from './api.ts'
import type { DeliveryReceipt } from './delivery.ts'

export function landingReplies(host: ExtensionHost): LandingRepliesService {
  const settle = async (tx: Tx, deliveries: TaskId[], recover = true): Promise<ReplySettlement> => {
    const entries: ReplySettlement['entries'] = []
    for (const id of deliveries) {
      const task = await tx.task(id)
      if (!task || task.abortRequested) return { state: 'unanswered', entries }
      if (task.state.status !== 'terminal') return { state: 'pending', entries }
      if (task.state.outcome.status !== 'completed') return { state: 'unanswered', entries }
      const message = (task.input as { message: Message }).message
      const original = await tx.submissionByRequest(
        message.to as ConversationId,
        `board:${message.id}`,
      )
      if (original && 'entry' in original && original.entry) entries.push(original.entry)
      if (original?.status === 'unanswered') return { state: 'unanswered', entries }
      const callback = task.state.outcome.result as DeliveryReceipt | null
      if (!callback) continue
      if ('delivery' in callback) {
        const forwarded = await settle(tx, [callback.delivery], recover)
        entries.push(...forwarded.entries)
        if (forwarded.state !== 'settled') return { state: forwarded.state, entries }
        continue
      }
      const input = await tx.submissionByRequest(callback.conversationId, callback.requestId)
      if (!input) return { state: 'unanswered', entries }
      const reply = await host.need(SubagentsApi).settleReply(tx, input)
      entries.push(...reply.entries)
      if (reply.state === 'unanswered') return { state: 'unanswered', entries }
      if (reply.state === 'pending') {
        // Recovery may create its Reporter here, closing the answered-before-recovery gap. Pi permits
        // no table reads after that write, so return immediately; later checks read the new receipt.
        if (recover) await host.need(SubagentsApi).recoverReply(tx, input)
        return { state: 'pending', entries }
      }
    }
    return { state: 'settled', entries }
  }
  return {
    async capture(tx, id) {
      const conversations = [id]
      let after = 0
      const reports: { conversationId: ConversationId; requestId: string }[] = []
      for (const member of conversations) {
        after = Math.max(
          after,
          (await tx.scanEntries({ conversationId: member }, 1)).items[0]?.id ?? 0,
        )
        const children = await tx.doc(Subagents, member)
        for (const child of Object.values(children.agents)) conversations.push(child.conversationId)
        for (const action of Object.values(children.actions)) {
          const requestId = `subagent:${action.reporter}`
          const input = await tx.submissionByRequest(action.conversationId, requestId)
          // The child already answered at landing, but its parent report may still be queued.
          // Freeze that exact causal input too; an ongoing child's future answer is new work.
          if (
            input?.status === 'done' &&
            input.type === 'input' &&
            (await host.need(SubagentsApi).settleReply(tx, input)).state === 'pending'
          )
            reports.push({ conversationId: action.conversationId, requestId })
        }
      }
      const family = new Set(conversations)
      const deliveries: TaskId[] = []
      let cursor: Cursor | undefined
      do {
        const page = await tx.scanTasks(
          { conversationId: ROOT_CONVERSATION_ID, kind: 'board.delivery' },
          200,
          cursor,
        )
        for (const task of page.items) {
          const { message } = task.input as { message: Message }
          if (
            !message.reply ||
            !family.has(message.from as ConversationId) ||
            !family.has(message.to as ConversationId)
          )
            continue
          // Completed callbacks can still owe an answer or a recovered Reporter. The task's result pins
          // their request address even after the bounded message log has dropped their rows.
          if (
            task.state.status !== 'terminal' ||
            (await settle(tx, [task.id], false)).state === 'pending'
          )
            deliveries.push(task.id)
        }
        cursor = page.next
      } while (cursor)
      return { family: conversations, after: after as EntryId, deliveries, reports }
    },
    async settle(tx, frontier) {
      const entries = []
      for (const report of frontier.reports) {
        const input = await tx.submissionByRequest(report.conversationId, report.requestId)
        if (!input) return 'unanswered'
        const settled = await host.need(SubagentsApi).settleReply(tx, input)
        entries.push(...settled.entries)
        if (settled.state === 'pending') {
          await host.need(SubagentsApi).recoverReply(tx, input)
          return 'pending'
        }
        if (settled.state === 'unanswered') return 'unanswered'
      }
      const replies = await settle(tx, frontier.deliveries)
      if (replies.state !== 'settled') return replies.state
      // Only the frozen chain may extend the landing boundary. An unrelated input keeps the
      // branch open even when it already answered or failed before this transaction resumed.
      const allowed = new Set([...entries, ...replies.entries])
      for (const member of frontier.family) {
        let cursor: Cursor | undefined
        do {
          const page = await tx.scanEntries(
            { conversationId: member, minEntryId: (frontier.after + 1) as EntryId },
            200,
            cursor,
          )
          if (page.items.some((entry) => entry.input && !allowed.has(entry.id))) return 'unanswered'
          cursor = page.next
        } while (cursor)
      }
      return 'settled'
    },
  }
}
