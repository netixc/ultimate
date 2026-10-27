/** The finite message/reply frontier used by lineage's existing landed-branch conclusion. */
import { ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import type { ConversationId, Cursor, TaskId, Tx } from '@earendil-works/pi-durable'
import type { ExtensionHost } from '../../server/extensions.ts'
import type { LandingRepliesService } from '../lineage/api.ts'
import { SubagentsApi } from '../subagents/api.ts'
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
    async admitted(tx, conversations) {
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
      return deliveries
    },
    settle,
  }
}
