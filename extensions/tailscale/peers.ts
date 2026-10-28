export interface PeerOnline {
  /** Opaque device identity: multiple configured ports on one peer count once. */
  id: string
  online: boolean
}

export type PeerStatuses = Record<string, PeerOnline | null>

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}
const name = (value: string) => value.toLowerCase().replace(/\.$/, '')

/** Only owner-configured remote hosts are eligible; the tailnet is never an inventory source. */
export function configuredPeerHosts(remotes: unknown) {
  const hosts = new Set<string>()
  for (const projects of Object.values(object(remotes))) {
    for (const address of Object.values(object(projects))) {
      if (typeof address !== 'string') continue
      try {
        const url = new URL(address)
        if (['http:', 'https:'].includes(url.protocol) && !url.username && !url.password)
          hosts.add(name(url.hostname))
      } catch {
        // An invalid remote URL cannot identify a configured Tailscale peer.
      }
    }
  }
  return hosts
}

/** Return only exact requested/configured matches, never the other devices or raw status output. */
export async function readPeerOnline(
  requested: string[],
  configured: ReadonlySet<string>,
  read: () => Promise<string>,
): Promise<PeerStatuses> {
  const result: PeerStatuses = Object.fromEntries(requested.map((host) => [host, null]))
  const eligible = requested.filter((host) => configured.has(name(host)))
  if (!eligible.length) return result
  try {
    const status = object(JSON.parse(await read()))
    if (status.BackendState !== 'Running') return result
    const peers = Object.values(object(status.Peer)).map(object)
    for (const host of eligible) {
      const matches = peers.filter((peer) =>
        [peer.DNSName, peer.HostName].some(
          (value) => typeof value === 'string' && name(value) === name(host),
        ),
      )
      if (matches.length !== 1) continue
      const [peer] = matches
      if (typeof peer.ID === 'string' && typeof peer.Online === 'boolean')
        result[host] = { id: peer.ID, online: peer.Online }
    }
    return result
  } catch {
    // Missing CLI, denied access and malformed status supply no device-liveness evidence. Never infer offline.
    return result
  }
}
