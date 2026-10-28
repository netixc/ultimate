import { useCallback, useEffect, useRef, useState } from 'react'
import {
  actionRef,
  defineWebExtension,
  errorMessage,
  notify,
  prepareInstanceNavigation,
  useAction,
  useConversations,
  useDocOf,
  useSystem,
  useUiState,
} from '@/sdk'
import { MessagesDoc } from '../../../extensions/messages/refs.ts'
import { WorkspacesDoc } from '../../../extensions/workspaces/refs.ts'
import { RootsDoc } from '../../../extensions/lineage/refs.ts'
import { FleetMenu } from './menu.tsx'
import { arrivingState, homeProject, navigationUrl } from './navigation.ts'
import type { FleetNavigationState, FleetProject, FleetSnapshot } from './types.ts'

const Inventory = actionRef<{ origin: string }, FleetSnapshot>('fleet', 'inventory')

function Fleet() {
  const [arrival] = useState(() => arrivingState(location.href))
  const [state, setState] = useState<FleetNavigationState>(
    () =>
      arrival.state ?? {
        open: true,
        pinned: false,
        homeUrl: `${location.origin}/`,
        homeName: '',
        homeProjectId: '',
        homeMachine: '',
      },
  )
  useEffect(() => {
    if (arrival.cleanUrl !== location.href)
      history.replaceState(history.state, '', arrival.cleanUrl)
  }, [arrival.cleanUrl])
  const [leaving, setLeaving] = useState(false)
  const system = useSystem()
  const { data, loading, refetch } = useAction(Inventory, { origin: location.origin })
  const fetching = useRef(loading)
  fetching.current = loading
  const queued = useRef(false)
  const refresh = useCallback(() => {
    if (fetching.current) {
      queued.current = true
      return
    }
    fetching.current = true
    queued.current = false
    // oxlint-disable-next-line typescript/no-floating-promises -- useAction reports failures and resolves undefined.
    void refetch()
  }, [refetch])
  const messages = useDocOf(1, MessagesDoc)
  const workspaces = useDocOf(1, WorkspacesDoc)
  const roots = useDocOf(1, RootsDoc)
  const [concluded] = useUiState<number[] | null>('ext.conversations.concluded', null)
  const conversations = useConversations()
  const activity = JSON.stringify(conversations.map(({ id, busy, inputAt }) => [id, busy, inputAt]))
  useEffect(refresh, [messages, workspaces, roots, concluded, activity, refresh])
  useEffect(() => {
    // Coalesce local changes while remote snapshots finish; never keep cancelling a slow inventory.
    if (!loading && queued.current) refresh()
  }, [loading, refresh])
  useEffect(() => {
    const visible = () => {
      if (document.visibilityState === 'visible') refresh()
    }
    window.addEventListener('focus', visible)
    document.addEventListener('visibilitychange', visible)
    return () => {
      window.removeEventListener('focus', visible)
      document.removeEventListener('visibilitychange', visible)
    }
  }, [refresh])

  const current: FleetProject = {
    id: 'current',
    name: system?.project.name ?? '',
    initials: (system?.project.name ?? '').slice(0, 2).toLowerCase(),
    port: location.port || undefined,
    url: '/',
    current: true,
    inFlight: false,
    awaiting: 0,
    available: true,
  }
  const snapshot = data ?? { home: current, machines: [] }
  const home = homeProject(snapshot, state, location.href)

  const select = async (project: FleetProject) => {
    if (leaving || project.current || !project.available || !project.url) return
    setLeaving(true)
    try {
      const url = navigationUrl(
        project.url,
        {
          ...state,
          homeName: home.name,
          homePort: home.port,
          homeProjectId: state.homeProjectId || home.id,
          homeMachine:
            state.homeMachine ||
            snapshot.machines.find((machine) =>
              machine.projects.some((candidate) => candidate.id === home.id),
            )?.name ||
            '',
        },
        location.href,
      )
      await prepareInstanceNavigation()
      location.assign(url)
    } catch (error) {
      notify({ level: 'error', message: errorMessage(error) })
      setLeaving(false)
    }
  }

  return (
    <FleetMenu
      snapshot={{ ...snapshot, home }}
      open={state.open}
      pinned={state.pinned}
      onToggleOpen={() => setState((previous) => ({ ...previous, open: !previous.open }))}
      onTogglePin={() => setState((previous) => ({ ...previous, pinned: !previous.pinned }))}
      onSelect={(project) => void select(project)}
    />
  )
}

export default defineWebExtension({ slots: { 'shell.rail': [Fleet] } })
