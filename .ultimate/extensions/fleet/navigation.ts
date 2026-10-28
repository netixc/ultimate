import type { FleetNavigationState, FleetProject, FleetSnapshot } from './types.ts'

const key = 'fleet'

/** Only small menu state crosses origins; drafts never belong in a navigation URL. */
export function navigationUrl(target: string, state: FleetNavigationState, base: string) {
  const url = new URL(target, base)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
    throw new Error('Fleet requires an HTTP or HTTPS instance address.')
  const hash = new URLSearchParams(url.hash.slice(1))
  hash.set(key, JSON.stringify(state))
  url.hash = hash.toString()
  return url.href
}

/** Finish pending navigation once; consuming its fragment makes later reloads start fresh. */
export function arrivingState(href: string) {
  const url = new URL(href)
  const hash = new URLSearchParams(url.hash.slice(1))
  const carried = hash.get(key)
  if (carried === null) return { cleanUrl: url.href }
  hash.delete(key)
  url.hash = hash.toString()
  const cleanUrl = url.href
  try {
    const value: unknown = JSON.parse(carried)
    if (!value || typeof value !== 'object') return { cleanUrl }
    const state = value as Partial<FleetNavigationState>
    if (
      typeof state.open !== 'boolean' ||
      typeof state.pinned !== 'boolean' ||
      typeof state.homeUrl !== 'string' ||
      typeof state.homeName !== 'string' ||
      typeof state.homeProjectId !== 'string' ||
      !state.homeProjectId ||
      typeof state.homeMachine !== 'string' ||
      !state.homeMachine ||
      (state.homePort !== undefined && typeof state.homePort !== 'string')
    )
      return { cleanUrl }
    const home = new URL(state.homeUrl)
    if (!['http:', 'https:'].includes(home.protocol) || home.username || home.password)
      return { cleanUrl }
    return {
      cleanUrl,
      state: {
        open: state.open,
        pinned: state.pinned,
        homeUrl: home.href,
        homeName: state.homeName,
        homeProjectId: state.homeProjectId,
        homeMachine: state.homeMachine,
        ...(state.homePort ? { homePort: state.homePort } : {}),
      },
    }
  } catch {
    // An edited or malformed fragment is not navigation state; use the reference's initial state.
    return { cleanUrl }
  }
}

/** An absent original home never borrows another instance's name or awaiting count. */
export function homeProject(
  snapshot: FleetSnapshot,
  state: FleetNavigationState,
  base: string,
): FleetProject {
  if (!state.homeProjectId) return snapshot.home
  // A published address may replace the configured URL; the known host/project identity stays the same.
  const identified = snapshot.machines
    .find((machine) => machine.name === state.homeMachine)
    ?.projects.find((project) => project.id === state.homeProjectId)
  const known =
    identified ??
    [snapshot.home, ...snapshot.machines.flatMap((machine) => machine.projects)].find(
      (project) => project.url && new URL(project.url, base).href === state.homeUrl,
    )
  return (
    known ?? {
      id: 'home',
      name: state.homeName,
      initials: state.homeName.slice(0, 2).toLowerCase(),
      url: state.homeUrl,
      port: state.homePort,
      current: false,
      inFlight: false,
      awaiting: 0,
      available: false,
    }
  )
}
