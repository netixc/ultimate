import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { temp } from '../../../../test/helpers.ts'
import type { ExtensionHost } from '../../../../server/extensions.ts'
import type { ActionContext } from '../../../../server/actions.ts'
import type { RootEvent } from '../../../../extensions/lineage/types.ts'
import type { TailscaleService } from '../../../../extensions/tailscale/api.ts'
import type { Message, MessagesService } from '../../../../extensions/messages/api.ts'
import messages from '../../../../extensions/messages/server.ts'
import type { FlightIndex } from '../../../../lib/in-flight.ts'
import { postAction } from '../../../../lib/remote.ts'
import { actions } from '../server.ts'
import { fleetInventory, instanceSnapshot } from '../data.ts'
import type { InstanceSnapshot } from '../data.ts'

vi.mock('../../../../lib/remote.ts', async (original) => ({
  ...(await original<typeof import('../../../../lib/remote.ts')>()),
  postAction: vi.fn<typeof postAction>(),
}))

afterEach(() => vi.clearAllMocks())

const signal = () => new AbortController().signal
const peer = (id: string, name: string, machine = 'workstation'): InstanceSnapshot => ({
  machine: { id: machine, name: machine },
  project: { id, name, port: '4801' },
  inFlight: true,
  awaiting: 0,
})

async function fixture() {
  const userHome = await temp('ultimate-fleet-')
  await mkdir(join(userHome, '.ultimate'), { recursive: true })
  await writeFile(
    join(userHome, '.ultimate/settings.json'),
    JSON.stringify({
      remotes: {
        workstation: {
          docs: 'https://workstation.example:8443',
          api: 'https://workstation.example:8444',
        },
        alias: { docs: 'https://workstation.example:8443' },
        laptop: { app: 'https://laptop.example' },
      },
    }),
  )
  const state: {
    index: FlightIndex
    landings: RootEvent[]
    roots: number[]
    foreground: number[]
    messages: Message[]
    concluded: number[]
  } = {
    index: { queue: [], results: {} },
    landings: [],
    roots: [1],
    foreground: [],
    messages: [],
    concluded: [],
  }
  let messageService: MessagesService | undefined
  const host = {
    userHome,
    projects: vi.fn<ExtensionHost['projects']>().mockResolvedValue([
      {
        home: '/registry/app',
        root: '/private/app',
        name: 'app',
        current: true,
        conversations: [],
      },
      {
        home: '/registry/docs',
        name: 'docs',
        current: false,
        running: { pid: 123, url: 'http://127.0.0.1:4801' },
        conversations: [],
      },
      { home: '/registry/stopped', name: 'stopped', current: false, conversations: [] },
    ]),
    system: () => ({
      machine: { hostname: 'desktop' },
      process: { url: 'http://127.0.0.1:4800' },
    }),
    uiState: vi.fn<ExtensionHost['uiState']>().mockResolvedValue({
      'ext.conversations.concluded': [],
      'private.ui': 'secret',
    }),
    conversations: vi.fn<ExtensionHost['conversations']>().mockReturnValue([
      { id: 1, busy: false },
      {
        id: 2,
        branchOf: { conversationId: 1, at: 1 },
        busy: false,
        inputAt: 100,
        title: 'private title',
        cwd: '/private/work',
      },
    ]),
    want: vi.fn<ExtensionHost['want']>().mockReturnValue(undefined),
    need: vi
      .fn<(api: { name: string }) => unknown>()
      .mockImplementation((api) =>
        api.name === 'messages'
          ? messageService
          : api.name === 'conversations'
            ? { concluded: async () => new Set(state.concluded) }
            : { doc: { definition: { kind: 'ultimate.workspaces' } } },
      ),
    implement: vi
      .fn<(api: { name: string }, service: unknown) => void>()
      .mockImplementation((api, service) => {
        if (api.name === 'messages') messageService = service as MessagesService
      }),
    doc: vi.fn<ExtensionHost['doc']>().mockReturnValue(undefined),
    invoke: vi.fn<ExtensionHost['invoke']>().mockImplementation(async () => state.landings),
    harness: () => ({
      snapshot: async (doc: { definition: { kind: string } }) => {
        if (doc.definition.kind === 'lineage.roots') return { roots: state.roots }
        if (doc.definition.kind === 'board')
          return { messages: state.messages, next: state.messages.length + 1 }
        return state.index
      },
      taskGraph: async () => ({
        dispose: vi.fn<() => void>(),
        value: {
          tasks: Object.fromEntries(
            state.foreground.map((id) => [
              id,
              {
                conversationId: id,
                background: false,
                state: { status: 'running' },
              },
            ]),
          ),
        },
      }),
    }),
  } as unknown as ExtensionHost
  // Install the actual MessagesApi implementation over mocked persistence; no server, tasks or models are run.
  messages(host)
  return { host, state }
}

it('inventories registered local projects and user remotes, deduplicates devices, and keeps failures unknown', async () => {
  const { host } = await fixture()
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.mocked(postAction).mockImplementation(async ({ url }) => {
    if (url === 'http://127.0.0.1:4801') return peer('local-docs', 'docs', 'desktop')
    if (url === 'https://workstation.example:8443') return peer('remote-docs', 'docs')
    if (url === 'https://workstation.example:8444') throw new Error('refused (403)')
    throw new Error('timeout')
  })
  try {
    const result = await fleetInventory(host, signal(), 'https://desktop.example')
    expect(result.home).toMatchObject({ name: 'app', current: true, url: '/', inFlight: true })
    expect(result.machines.map(({ id, online }) => ({ id, online }))).toEqual([
      { id: 'desktop', online: true },
      { id: 'workstation', online: true },
      { id: 'laptop', online: null },
    ])
    expect(result.machines[0].projects).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'docs', available: true, port: '4801', inFlight: true }),
        expect.objectContaining({ name: 'stopped', available: false, inFlight: false }),
      ]),
    )
    expect(result.machines[0].projects.find((item) => item.name === 'docs')?.url).toBeUndefined()
    expect(result.machines[1].projects).toHaveLength(2)
    expect(result.machines[1].projects[0]).toMatchObject({
      url: 'https://workstation.example:8443',
      inFlight: true,
      available: true,
    })
    expect(result.machines[1].projects[1]).toMatchObject({ name: 'api', available: false })
    expect(result).not.toHaveProperty('offlineDevices')
    expect(result.machines.every((item) => item.eye === undefined)).toBe(true)
    expect(postAction).toHaveBeenCalledTimes(4)
    expect(postAction).toHaveBeenCalledWith(
      { url: 'https://workstation.example:8443', label: 'docs' },
      'fleet',
      'snapshot',
      null,
      expect.any(AbortSignal),
    )
    expect(warning).toHaveBeenCalledTimes(2)
    expect(JSON.stringify(result)).not.toMatch(/private|registry|title|cwd|unread/)
  } finally {
    warning.mockRestore()
  }
})

it('groups Tailscale-reported offline projects without creating an awaiting badge count', async () => {
  const { host } = await fixture()
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const peerOnline = vi.fn<TailscaleService['peerOnline']>().mockResolvedValue({
    'workstation.example': { id: 'one-device', online: false },
    'laptop.example': null,
  })
  vi.spyOn(host, 'want').mockReturnValue({
    status: () => ({ state: 'disabled' }),
    peerOnline,
  })
  vi.mocked(postAction).mockImplementation(async ({ url }) => {
    if (url === 'http://127.0.0.1:4801') return peer('local-docs', 'docs', 'desktop')
    throw new Error('refused (403)')
  })
  try {
    const result = await fleetInventory(host, signal(), 'http://127.0.0.1:4800')
    expect(peerOnline).toHaveBeenCalledWith(['workstation.example', 'laptop.example'])
    const offline = result.machines.filter((machine) => machine.online === false)
    expect(offline).toHaveLength(1)
    expect(offline[0]).toMatchObject({ id: 'tailscale:one-device', shortName: 'wo' })
    expect(offline[0].projects).toHaveLength(2)
    expect(offline[0].projects.every((project) => !project.available)).toBe(true)
    expect(result).not.toHaveProperty('offlineDevices')
    expect(result.home.awaiting).toBe(0)
    expect(result.machines.find((machine) => machine.name === 'laptop')?.online).toBe(null)
    expect(postAction).toHaveBeenCalledTimes(2)
    expect(result.home.initials).toBe('ap')
  } finally {
    warning.mockRestore()
  }
})

it('exposes only instance identity, published address and the sidebar In flight aggregate', async () => {
  const { host, state } = await fixture()
  const abort = signal()
  vi.spyOn(host, 'want').mockReturnValue({
    status: () => ({ state: 'ready', url: 'https://desktop.example:8443' }),
  })
  const snapshot = await actions.snapshot(null, { host, signal: abort } as ActionContext)
  expect(snapshot).toEqual({
    machine: { id: 'desktop', name: 'desktop' },
    project: {
      id: expect.stringMatching(/^[a-f0-9]{16}$/),
      name: 'app',
      url: 'https://desktop.example:8443',
      port: '4800',
    },
    inFlight: true,
    awaiting: 0,
  })
  expect(host.uiState).not.toHaveBeenCalled()
  expect(JSON.stringify(snapshot)).not.toMatch(/private|registry|secret|title|cwd|unread/)
  const flight = async () => (await instanceSnapshot(host, abort)).inFlight
  // All answers seen, but an idle unlanded branch remains in flight; unread is not the source.
  vi.mocked(host.uiState).mockResolvedValue({ 'ext.conversations.seen': { 2: 999 } })
  expect(await flight()).toBe(true)
  state.index.results.done = {
    conversationId: 2,
    outcome: 'landed',
    steps: [{ at: 200 }],
    at: 150,
  }
  // Conversely an unread answer on landed work does not make the project in flight.
  vi.spyOn(host, 'conversations').mockReturnValue([
    { id: 1, busy: false },
    { id: 2, branchOf: { conversationId: 1, at: 1 }, busy: false, inputAt: 100, answerAt: 300 },
  ])
  vi.mocked(host.uiState).mockResolvedValue({ 'ext.conversations.seen': { 2: 0 } })
  expect(await flight()).toBe(false)
  state.index.queue = [{ conversationId: 2 }]
  expect(await flight()).toBe(true)
  state.index.queue = []
  vi.spyOn(host, 'conversations').mockReturnValue([
    { id: 1, busy: false },
    { id: 2, branchOf: { conversationId: 1, at: 1 }, busy: false, inputAt: 201 },
  ])
  expect(await flight()).toBe(true)
  // A root landing note still closes work after the bounded workspace results have been evicted.
  state.index.results = {}
  state.landings = [{ type: 'landed', entry: 1, from: 2, at: 201, sha: 'abc', commits: 1 }]
  expect(await flight()).toBe(false)
  state.foreground = [2]
  expect(await flight()).toBe(true)
  state.foreground = []
  state.landings = []
  state.concluded = [1]
  expect(await flight()).toBe(false)
  state.concluded = []
  state.roots = []
  expect(await flight()).toBe(false)
})

it('keeps the real home Ultimate awaiting count distinct from a switched-to instance', async () => {
  const home = await fixture()
  const other = await fixture()
  for (const { host } of [home, other])
    await writeFile(join(host.userHome, '.ultimate/settings.json'), JSON.stringify({ remotes: {} }))
  const question = (id: number, override: Partial<Message> = {}): Message => ({
    id,
    from: 10,
    to: 'user',
    text: 'Private question?',
    at: id,
    reply: true,
    state: 'delivered',
    ...override,
  })
  // The actual MessagesApi counts only delivered, reply-enabled questions to the user.
  home.state.messages = [
    question(1),
    question(2, { state: 'answered' }),
    question(3, { state: 'dismissed' }),
    question(4, { reply: false }),
    question(5, { state: 'sent' }),
    question(6, { from: 2, to: 10 }),
  ]
  other.state.messages = [question(1), question(2), question(3)]
  vi.spyOn(other.host, 'projects').mockResolvedValue([
    {
      home: '/registry/app',
      name: 'app',
      current: false,
      running: { pid: 123, url: 'http://127.0.0.1:4800' },
      conversations: [],
    },
    { home: '/registry/docs', name: 'docs', current: true, conversations: [] },
  ])
  const system = other.host.system()
  vi.spyOn(other.host, 'system').mockReturnValue({
    ...system,
    process: { ...system.process, url: 'http://127.0.0.1:4801' },
  })
  const [homeSnapshot, otherSnapshot] = await Promise.all([
    instanceSnapshot(home.host, signal()),
    instanceSnapshot(other.host, signal()),
  ])
  expect(homeSnapshot.awaiting).toBe(1)
  expect(otherSnapshot.awaiting).toBe(3)
  vi.mocked(postAction).mockImplementation(async ({ url }) =>
    url === 'http://127.0.0.1:4801' ? otherSnapshot : homeSnapshot,
  )
  const first = await fleetInventory(home.host, signal(), 'http://127.0.0.1:4800')
  expect(first.home.awaiting).toBe(1)
  expect(
    first.machines[0].projects.find((project) => project.id === otherSnapshot.project.id)?.awaiting,
  ).toBe(3)
  const switched = await fleetInventory(other.host, signal(), 'http://127.0.0.1:4801')
  expect(switched.home.awaiting).toBe(3)
  const originalHome = switched.machines
    .flatMap((machine) => machine.projects)
    .find((project) => project.id === first.home.id)
  expect(originalHome).toMatchObject({ name: 'app', url: 'http://127.0.0.1:4800', awaiting: 1 })
  expect(switched).not.toHaveProperty('offlineDevices')
  expect(JSON.stringify(switched)).not.toMatch(/Private question|messages|conversation|text/)
})
