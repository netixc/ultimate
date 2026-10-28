/**
 * Workspaces: isolated Git worktrees for conversations and the lander that merges them into their target branch.
 * Other extensions create, look up, land and discard a conversation's worktree through this service.
 */
import type { Context } from '@earendil-works/chord'
import type { ConversationId, EntryId, SubmissionId, TaskId, Tx } from '@earendil-works/pi-durable'
import { defineApi } from '../../shared/extension-api.ts'
import type { git } from '../../lib/git.ts'
import type { Workspaces, workspaces } from './workspaces.ts'

type Implementation = ReturnType<typeof workspaces>

export type WorkspaceService = {
  /** The worktree of conversation `id` (path, branch, target, state), or undefined when it has none. */
  get: Implementation['get']
  /** Give conversation `id` a new worktree of `cwd`'s repository inside `tx`; throws when `cwd` cannot be isolated. */
  create: Implementation['create']
  /** Fast-forward the worktree of `id`'s owner to the worktree tip of subagent `id`; returns what landed. */
  land: Implementation['land']
  /** Remove the worktree of `id` without landing it. */
  discard: Implementation['discard']
  /** Free the worktrees of concluded conversations `ids` and their descendants; returns the ones kept (busy, unlanded). */
  release: Implementation['release']
  /** Run `git` with `args` in a directory; rejects with Git's message. Use it instead of spawning Git yourself. */
  git: typeof git
  /** The worktree index document (`ultimate.workspaces` on the root), for reads inside a transaction. */
  doc: typeof Workspaces
  /** Make the project folder a Git repository with a first commit, so worktrees and landing work. */
  setupGit(): Promise<void>
}
/** Worktrees and landing; core, so `need` it. */
export const WorkspacesApi = defineApi<WorkspaceService>()('workspaces')

export { CheckRan, SubmissionLanded } from './refs.ts'
export type { LandedData } from './refs.ts'
export type BranchesService = {
  /** The conversation that started branch `id`, which hears that its submission landed. */
  starter(id: ConversationId, ctx: Context): Promise<number | undefined>
  /** Inside `tx`: whether branch `id` has work of its own that will wake it again, so a landing leaves it open. */
  working(tx: Tx, id: ConversationId): Promise<boolean>
}
/** What a landing asks about the branch it landed; messages provides it. `want` it. */
export const Branches = defineApi<BranchesService>()('workspaces.branches')
/** The finite internal reply chain admitted at a landing, and the input boundary it may extend. */
export type LandingFrontier = {
  family: ConversationId[]
  after: EntryId
  deliveries: TaskId[]
  reports: { conversationId: ConversationId; requestId: string }[]
  /** Inputs of runs active at capture; generation handoffs keep these exact receipt IDs. */
  runs: { conversationId: ConversationId; inputs: SubmissionId[] }[]
}
export type LandingRepliesService = {
  /** Freeze already admitted internal replies and the family's latest entry at landing. */
  capture(tx: Tx, id: ConversationId): Promise<LandingFrontier>
  /** Drain only that chain; new inputs, unanswered callbacks and stopped runs leave the branch open. */
  settle(tx: Tx, frontier: LandingFrontier): Promise<'pending' | 'settled' | 'unanswered'>
}
/** Messages supplies exact delivery and subagent-report receipts to the single lander route. */
export const LandingReplies = defineApi<LandingRepliesService>()('workspaces.landing-replies')
export const tier = 'core'
