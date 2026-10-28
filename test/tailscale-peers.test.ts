import { expect, test } from 'vitest'
import { configuredPeerHosts, readPeerOnline } from '../extensions/tailscale/peers.ts'

test('Tailscale matches only configured hosts and returns one device identity across ports', async () => {
  const hosts = configuredPeerHosts({
    laptop: {
      first: 'https://laptop.example.ts.net:4747',
      second: 'https://laptop.example.ts.net:4748',
    },
    short: { app: 'https://laptop:4750' },
  })
  const status = {
    BackendState: 'Running',
    Peer: {
      a: { ID: 'device-a', HostName: 'laptop', DNSName: 'laptop.example.ts.net.', Online: false },
      b: { ID: 'device-b', HostName: 'other', DNSName: 'other.example.ts.net.', Online: true },
    },
  }
  const result = await readPeerOnline(
    ['LAPTOP.EXAMPLE.TS.NET', 'laptop', 'other.example.ts.net', 'missing'],
    hosts,
    async () => JSON.stringify(status),
  )
  expect(result).toEqual({
    'LAPTOP.EXAMPLE.TS.NET': { id: 'device-a', online: false },
    laptop: { id: 'device-a', online: false },
    'other.example.ts.net': null,
    missing: null,
  })
  expect(
    new Set(Object.values(result).flatMap((peer) => (peer?.online === false ? [peer.id] : [])))
      .size,
  ).toBe(1)
})

test('missing, ambiguous and refused status remain unknown, never offline', async () => {
  const requested = ['laptop', 'unknown.example.ts.net']
  const hosts = new Set(requested)
  expect(
    await readPeerOnline(requested, hosts, async () => {
      throw new Error('Access denied (403)')
    }),
  ).toEqual({ laptop: null, 'unknown.example.ts.net': null })
  expect(
    await readPeerOnline(requested, hosts, async () =>
      JSON.stringify({
        BackendState: 'Running',
        Peer: {
          a: { ID: 'a', HostName: 'laptop', Online: false },
          b: { ID: 'b', HostName: 'laptop', Online: true },
        },
      }),
    ),
  ).toEqual({ laptop: null, 'unknown.example.ts.net': null })
})
