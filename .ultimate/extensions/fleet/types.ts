/** A project instance, not a conversation or a machine. Addresses come only from the local registry or user remotes. */
export interface FleetProject {
  id: string
  name: string
  initials: string
  url?: string
  port?: string
  current: boolean
  inFlight: boolean
  /** Open questions from this instance's @ultimate waiting on the user's answer or dismissal. */
  awaiting: number
  available: boolean
}

export interface FleetMachine {
  id: string
  name: string
  shortName: string
  /** Unknown is not offline. A refused or timed-out instance does not prove a device is offline. */
  online: boolean | null
  /** Reserved reference mark; its meaning and behavior have not been specified. */
  eye?: boolean
  projects: FleetProject[]
}

export interface FleetSnapshot {
  home: FleetProject
  machines: FleetMachine[]
}

export interface FleetNavigationState {
  open: boolean
  pinned: boolean
  homeUrl: string
  homeName: string
  homeProjectId: string
  homeMachine: string
  homePort?: string
}
