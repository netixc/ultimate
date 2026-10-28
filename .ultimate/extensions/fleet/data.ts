import { createHash } from 'node:crypto'
import type { Context } from '@earendil-works/chord'
import { ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import { BACKGROUND_CONTEXT, withAbortSignal } from '@earendil-works/chord/context'
import type { ExtensionHost } from '../../../server/extensions.ts'
import { postAction, remotes } from '../../../lib/remote.ts'
import { TailscaleApi } from '../../../extensions/tailscale/api.ts'
import { Roots } from '../../../extensions/lineage/api.ts'
import type { RootEvent } from '../../../extensions/lineage/types.ts'
import { WorkspacesApi } from '../../../extensions/workspaces/api.ts'
import { MessagesApi } from '../../../extensions/messages/api.ts'
import { ConversationsApi } from '../../../extensions/conversations/api.ts'
import type { OverviewState } from '../../../extensions/conversations/types.ts'
import type { PauseDocState } from '../../../extensions/pause/refs.ts'
import {
  hiddenConversationIds,
  inFlight as branchInFlight,
  stillOpen,
} from '../../../lib/in-flight.ts'
import type { FleetMachine, FleetProject, FleetSnapshot } from './types.ts'

/** Only identity, an optional published address, and an aggregate leave an instance. */
export interface InstanceSnapshot {
  machine: { id: string; name: string }
  project: { id: string; name: string; url?: string; port?: string }
  inFlight: boolean
  awaiting: number
}

const projectId = (home: string) => createHash('sha256').update(home).digest('hex').slice(0, 16)
const initials = (name: string) => name.slice(0, 2).toLowerCase()
const compactName = (name: string) => {
  const host = name.split('.')[0]
  return host.length <= 3 ? host : host.slice(0, 2)
}
const loopback = (url: URL) => ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)

function address(value: unknown): URL | undefined {
  if (typeof value !== 'string') return undefined
  try {
    const url = new URL(value)
    if (['http:', 'https:'].includes(url.protocol) && !url.username && !url.password) {
      url.hash = ''
      return url
    }
  } catch {
    // Invalid addresses supply no navigation or transport target.
  }
  return undefined
}

/** The sidebar's In flight section: open branches of live roots, not unread answers or just busy runs. */
async function projectInFlight(host: ExtensionHost, context: Context, signal: AbortSignal) {
  const harness = host.harness()
  const overviewDoc = host.doc('ultimate.conversation-overview')
  const pauseDoc = host.doc('pause.state')
  const [roots, index, concluded, overview, pause] = await Promise.all([
    harness.snapshot(Roots, ROOT_CONVERSATION_ID, context),
    harness.snapshot(host.need(WorkspacesApi).doc, ROOT_CONVERSATION_ID, context),
    host.need(ConversationsApi).concluded(context),
    overviewDoc ? harness.snapshot(overviewDoc, ROOT_CONVERSATION_ID, context) : undefined,
    pauseDoc ? harness.snapshot(pauseDoc, ROOT_CONVERSATION_ID, context) : undefined,
  ])
  const graph = await harness.taskGraph(context)
  const foreground = Object.values(graph.value.tasks).filter((task) => !task.background)
  graph.dispose()
  const parked = new Set<number>()
  if ((pause as PauseDocState | undefined)?.paused) {
    for (const task of foreground) parked.add(task.conversationId)
    for (const task of foreground)
      if (task.state.status === 'running') parked.delete(task.conversationId)
  }
  const runStates = (overview as OverviewState | undefined)?.conversations ?? {}
  const conversations = host.conversations().map((conversation) => ({
    ...conversation,
    busy:
      !parked.has(conversation.id) &&
      (foreground.some((task) => task.conversationId === conversation.id) ||
        runStates[conversation.id]?.runState === 'working'),
  }))
  const hidden = hiddenConversationIds(conversations, [...concluded])
  const topLevel = conversations.filter(
    (conversation) =>
      conversation.parentConversationId === undefined &&
      conversation.label !== 'agent' &&
      conversation.label !== 'lander' &&
      !hidden.has(conversation.id),
  )
  const rootIds = new Set(
    (roots?.roots ?? []).filter((id) => topLevel.some((item) => item.id === id)),
  )
  const landings = (
    await Promise.all(
      [...rootIds].map(async (id) => {
        try {
          return (await host.invoke(
            'lineage',
            'recent',
            { id, types: ['landed'], limit: 20 },
            signal,
          )) as RootEvent[]
        } catch (error) {
          // Like useLandings, a root just unlisted contributes no landing notes; the next read retries it.
          console.warn(`Fleet could not read landings for root ${id}:`, error)
          return []
        }
      }),
    )
  ).flat()
  const working = new Set<number>()
  for (const conversation of conversations) {
    if (!conversation.busy) continue
    let top = conversation
    while (top.parentConversationId !== undefined && top.ownerTaskId !== undefined) {
      const parent = conversations.find((item) => item.id === top.parentConversationId)
      if (!parent) break
      top = parent
    }
    working.add(top.id)
  }
  const branches = new Set(rootIds)
  // Reach only branches below listed roots, as the sidebar's branchesBelow traversal does.
  for (let changed = true; changed;) {
    changed = false
    for (const conversation of topLevel)
      if (
        conversation.branchOf &&
        branches.has(conversation.branchOf.conversationId) &&
        !branches.has(conversation.id)
      ) {
        branches.add(conversation.id)
        changed = true
      }
  }
  return topLevel.some(
    (conversation) =>
      !rootIds.has(conversation.id) &&
      branches.has(conversation.id) &&
      branchInFlight(conversation, index ?? { queue: [], results: {} }) &&
      stillOpen({ conversation, working: working.has(conversation.id) }, landings),
  )
}

/** Only the aggregate and public instance identity leave this read-only action. */
export async function instanceSnapshot(
  host: ExtensionHost,
  signal: AbortSignal,
): Promise<InstanceSnapshot> {
  const context = withAbortSignal(signal, BACKGROUND_CONTEXT)
  const [projects, flight, questions] = await Promise.all([
    host.projects(),
    projectInFlight(host, context, signal),
    host.need(MessagesApi).openQuestions(context),
  ])
  const current = projects.find((project) => project.current)
  if (!current) throw new Error('This project is not listed among the projects')
  const system = host.system()
  const published = host.want(TailscaleApi)?.status()
  const url = published?.state === 'ready' ? address(published.url) : undefined
  const port = address(system.process.url)?.port
  return {
    machine: { id: system.machine.hostname, name: system.machine.hostname },
    project: {
      id: projectId(current.home),
      name: current.name,
      ...(url && !loopback(url) ? { url: url.href.replace(/\/$/, '') } : {}),
      ...(port ? { port } : {}),
    },
    inFlight: flight,
    awaiting: questions.length,
  }
}

function readSnapshot(value: unknown): InstanceSnapshot {
  if (!value || typeof value !== 'object') throw new Error('Invalid Fleet snapshot')
  const { machine, project, inFlight, awaiting } = value as InstanceSnapshot
  if (
    !machine ||
    typeof machine.id !== 'string' ||
    !machine.id ||
    typeof machine.name !== 'string' ||
    !project ||
    typeof project.id !== 'string' ||
    !project.id ||
    typeof project.name !== 'string' ||
    typeof inFlight !== 'boolean' ||
    !Number.isSafeInteger(awaiting) ||
    awaiting < 0
  )
    throw new Error('Invalid Fleet snapshot')
  const url = address(project.url)
  return {
    machine: { id: machine.id, name: machine.name },
    project: {
      id: project.id,
      name: project.name,
      ...(url ? { url: url.href } : {}),
      ...(typeof project.port === 'string' ? { port: project.port } : {}),
    },
    inFlight,
    awaiting,
  }
}

export async function fleetInventory(
  host: ExtensionHost,
  signal: AbortSignal,
  origin?: string,
): Promise<FleetSnapshot> {
  const [local, configured, self] = await Promise.all([
    host.projects(),
    remotes(host),
    instanceSnapshot(host, signal),
  ])
  const hosts = [
    ...new Set(
      configured.flatMap((item) => {
        const url = address(item.url)
        return url ? [url.hostname] : []
      }),
    ),
  ]
  const peers = (await host.want(TailscaleApi)?.peerOnline(hosts)) ?? {}
  const caller = address(origin)
  const localBrowser = caller !== undefined && loopback(caller)
  const home: FleetProject = {
    ...self.project,
    initials: initials(self.project.name),
    url: '/',
    current: true,
    inFlight: self.inFlight,
    awaiting: self.awaiting,
    available: true,
  }
  const targets = [
    ...local
      .filter((item) => !item.current)
      .map((item) => ({
        id: projectId(item.home),
        name: item.name,
        machine: self.machine.id,
        url: item.running?.url,
        local: true,
      })),
    ...configured.map((item) => ({ ...item, id: item.name, local: false })),
  ]
  // Deduplicate addresses before transport; arguments cannot introduce a new target URL.
  const requests = new Map<string, Promise<InstanceSnapshot | undefined>>()
  for (const target of targets) {
    const url = address(target.url)
    if (!url || (!target.local && peers[url.hostname]?.online === false) || requests.has(url.href))
      continue
    requests.set(
      url.href,
      postAction(
        { url: url.href.replace(/\/$/, ''), label: target.name },
        'fleet',
        'snapshot',
        null,
        signal,
      )
        .then(readSnapshot)
        .catch((error: unknown) => {
          // An inaccessible instance stays listed and unavailable, never a proven offline device.
          console.warn(`Fleet snapshot unavailable for ${target.name}:`, error)
          return undefined
        }),
    )
  }
  const results = await Promise.all(
    targets.map(async (target) => {
      const url = address(target.url)
      return { target, url, snapshot: url ? await requests.get(url.href) : undefined }
    }),
  )
  const machines = new Map<string, FleetMachine>()
  const machine = (id: string, name: string) => {
    let found = machines.get(id)
    if (!found) {
      found = { id, name, shortName: compactName(name), online: null, projects: [] }
      machines.set(id, found)
    }
    return found
  }
  const here = machine(self.machine.id, self.machine.name)
  here.online = true
  here.projects.push(home)
  // Successful aliases identify their device; a failed endpoint on that same named device stays in its group.
  const identities = new Map<string, InstanceSnapshot['machine']>()
  const peerIdentities = new Map<string, string>()
  for (const { target, url, snapshot } of results) {
    if (snapshot) {
      identities.set(target.machine, snapshot.machine)
      const peer = !target.local && url ? peers[url.hostname] : undefined
      if (peer) peerIdentities.set(snapshot.machine.id, peer.id)
    }
  }
  for (const { target, url, snapshot } of results) {
    const identity = target.local
      ? self.machine
      : (snapshot?.machine ??
        identities.get(target.machine) ?? {
          id: target.machine,
          name: target.machine,
        })
    const peer = !target.local && url ? peers[url.hostname] : undefined
    const device = peer?.id ?? peerIdentities.get(identity.id)
    const group = machine(
      identity.id === self.machine.id
        ? self.machine.id
        : device
          ? `tailscale:${device}`
          : identity.id,
      identity.name,
    )
    if (snapshot) group.online = true
    else if (group.online !== true && peer) group.online = peer.online
    const published = address(snapshot?.project.url)
    // A remote's loopback is never the browser's loopback. Do not map public ports onto registry ports.
    const reachable =
      published && !loopback(published)
        ? published
        : url && (!loopback(url) || (target.local && localBrowser))
          ? url
          : undefined
    const project: FleetProject = {
      id: snapshot?.project.id ?? target.id,
      name: snapshot?.project.name ?? target.name,
      initials: initials(snapshot?.project.name ?? target.name),
      ...(reachable ? { url: reachable.href.replace(/\/$/, '') } : {}),
      ...(snapshot?.project.port || url?.port ? { port: snapshot?.project.port ?? url!.port } : {}),
      current: identity.id === self.machine.id && snapshot?.project.id === self.project.id,
      inFlight: snapshot?.inFlight ?? false,
      awaiting: snapshot?.awaiting ?? 0,
      available: snapshot !== undefined,
    }
    if (!group.projects.some((item) => item.id === project.id)) group.projects.push(project)
  }
  return {
    home,
    machines: [...machines.values()],
  }
}
