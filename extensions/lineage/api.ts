/**
 * Lineage: the project's conversation trees. Roots keep a tally of what happened, branches fork from them for one
 * feature or fix, and notes carry news between conversations without waking them.
 */
import type { Context } from '@earendil-works/chord'
import { defineDoc, ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import type { ConversationId, TaskId, Tx } from '@earendil-works/pi-durable'
import type { ReplySettlement } from '../subagents/api.ts'
import { defineApi } from '../../shared/extension-api.ts'
import { RootsDoc } from './refs.ts'
import type { MemoryItem } from './refs.ts'
import type { BranchInput, leaveNote, rootOf, startBranch } from './server.ts'

/** The project's roots, each the top of one conversation tree; a fresh project's first conversation is its first. */
export const Roots = defineDoc<{ roots: number[] }>({
  kind: RootsDoc.kind,
  checkpointWhen: () => false,
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({ roots: [ROOT_CONVERSATION_ID] }),
})

/** `brief`: the branch's context starts at its project's memory brief instead of the full tally. */
export type BranchState = { from: number; at: number; intent: string; brief?: true }
/**
 * A branch's origin and prompt, written in its forking commit; absent on roots and on conversations made otherwise.
 * Read it to tell a lineage branch from other conversations, before its first run.
 */
export const Branch = defineDoc<{ branch?: BranchState }>({
  kind: 'lineage.branch',
  checkpointWhen: () => false,
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({}),
})

export type LineageService = {
  /** Start a branch from conversation `input.from` with its prompt as first input; returns the new conversation id. */
  branch: (input: BranchInput, ctx: Context) => ReturnType<typeof startBranch>
  /** The root of the tree conversation `id` belongs to, or undefined outside any tree. */
  rootOf: (id: number, ctx: Context) => ReturnType<typeof rootOf>
  /** Leave `text` in conversation `to` (or the root of the source's tree) for its next turn, without waking it. */
  leaveNote: (
    to: number | 'root',
    text: string,
    source?: Parameters<typeof leaveNote>[3],
  ) => ReturnType<typeof leaveNote>
  /** Apply memory `ops` to root `root` in one atomic batch, written at `now`; returns what changed. */
  remember: (root: number, ops: readonly unknown[], ctx: Context, now?: number) => Promise<string>
  /**
   * The memory brief a branch starts from (memory index and recent landings) of conversation `id`'s tree root, else
   * of the project's only root; undefined without either or while it has no memories.
   */
  memoryBrief: (
    id: number,
    ctx: Context,
  ) => Promise<{ root: number; text: string; memories: number } | undefined>
  /** The memories of conversation `id`'s tree root, else of the project's only root; undefined without either. */
  memoriesOf: (
    id: number,
    ctx: Context,
  ) => Promise<{ root: number; memories: Record<string, MemoryItem> } | undefined>
}
export { Branched, Rooted } from './refs.ts'

/** Trees, branches and notes; core, so `need` it. */
export const LineageApi = defineApi<LineageService>()('lineage')
/** Message transport participating in a landed branch's one-shot conclusion; messages fills this point. */
export type LandingRepliesService = {
  /** Freeze already admitted reply deliveries inside this branch's owned conversation tree. */
  admitted(tx: Tx, conversations: ConversationId[]): Promise<TaskId[]>
  /** Read those deliveries, their callback inputs and recovered parent reports in the concluding transaction. */
  settle(tx: Tx, deliveries: TaskId[]): Promise<ReplySettlement>
}
/** The bounded reply frontier for ConcludeLanded; not a general idle/busy gate. */
export const LandingReplies = defineApi<LandingRepliesService>()('lineage.landing-replies')
export const tier = 'core'
