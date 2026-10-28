/**
 * Tailscale: publishes this server on the user's tailnet over HTTPS. Other extensions read where it is reachable.
 */
import { defineApi } from '../../shared/extension-api.ts'
import type { Status } from './refs.ts'
import type { PeerStatuses } from './peers.ts'

export type { PeerOnline, PeerStatuses } from './peers.ts'

export type { Status }

/** What the `tailscale` service gives other extensions: this server's status, `url` once it is published. */
export interface TailscaleService {
  /** This server's current publication status; read `url` for its tailnet address. */
  status(): Status
  /** Read Tailscale's online flag only for requested hosts already named in user remotes. Unknown is null. */
  peerOnline(hostnames: string[]): Promise<PeerStatuses>
}
/** Tailnet publication; `want` it, since tailscale is optional. */
export const TailscaleApi = defineApi<TailscaleService>()('tailscale')
