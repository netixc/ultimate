/** The pure open-branch predicates shared by the sidebar and project-level activity indicators. */
export type FlightConversation = { id: number; busy: boolean; inputAt?: number }

/** Only the workspace evidence used to decide whether a branch has landed. */
export type FlightIndex = {
  queue: readonly { conversationId: number }[]
  results: Record<
    string,
    {
      conversationId?: number
      outcome: string
      steps: readonly { at: number }[]
      at: number
    }
  >
}

/** Only the root landing-note evidence used to decide whether a branch is still open. */
export type FlightLanding = { from?: number; at?: number }

/** Conclude a whole conversation subtree, even when a descendant has live tasks. */
export function hiddenConversationIds(
  conversations: readonly {
    id: number
    parentConversationId?: number
    branchOf?: { conversationId: number }
  }[],
  concluded: readonly number[],
) {
  const hidden = new Set(concluded)
  let changed = true
  while (changed) {
    changed = false
    for (const conversation of conversations) {
      const parent = conversation.parentConversationId ?? conversation.branchOf?.conversationId
      if (parent !== undefined && hidden.has(parent) && !hidden.has(conversation.id)) {
        hidden.add(conversation.id)
        changed = true
      }
    }
  }
  return hidden
}

/** When a branch last landed: its latest landed submission's last step. */
export function landedAt(index: FlightIndex, id: number) {
  let at: number | undefined
  for (const result of Object.values(index.results))
    if (result.conversationId === id && result.outcome === 'landed')
      at = Math.max(at ?? 0, result.steps.at(-1)?.at ?? result.at)
  return at
}

/**
 * Whether a branch is still in flight: started and neither concluded (the caller leaves those out) nor landed since
 * its latest input. A branch that lands and then gets new work is in flight again.
 */
export function inFlight(conversation: FlightConversation, index: FlightIndex) {
  if (conversation.busy) return true
  if (index.queue.some((item) => item.conversationId === conversation.id)) return true
  const landed = landedAt(index, conversation.id)
  return landed === undefined || (conversation.inputAt ?? 0) > landed
}

/**
 * Whether a flight still counts as open once the roots' own landing notes are known too: the lander keeps only recent
 * results, so a branch whose landing note is newer than its latest input landed, unless it works again.
 */
export const stillOpen = (
  flight: { conversation: FlightConversation; working: boolean },
  landings: readonly FlightLanding[],
) =>
  flight.working ||
  !landings.some(
    (event) =>
      event.from === flight.conversation.id &&
      (event.at ?? 0) >= (flight.conversation.inputAt ?? 0),
  )
