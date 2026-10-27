import { randomUUID } from 'node:crypto'
import { mkdir, open as openFile, readFile, stat, symlink, writeFile } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { afterAll, expect, it, vi } from 'vitest'
import { context } from '../server/harness.ts'
import { fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux'
import { UploadStorage } from '../.ultimate/extensions/uploads/storage.ts'
import { parseFileReference, uploadMarker } from '../.ultimate/extensions/uploads/format.ts'
import type { UploadedFile } from '../.ultimate/extensions/uploads/refs.ts'
import { fauxServer, held, linkDependencies, post, temp, until } from './helpers.ts'

type Server = Awaited<ReturnType<typeof fauxServer>>
const servers: Server[] = []
afterAll(async () => {
  await Promise.all(servers.map((server) => server.close()))
})

it('transfers real bytes, admits normal and queued references, and keeps sent files readable across restart', async () => {
  const root = await temp('ultimate-uploads-source-')
  await linkDependencies(root)
  await mkdir(join(root, 'web'))
  await mkdir(join(root, 'extensions'))
  await symlink(resolve('.ultimate/extensions/uploads'), join(root, 'extensions/uploads'))
  // This fixture tests persistence, not facet reloads; avoid initial watcher events during import.
  await writeFile(
    join(root, 'vite.config.ts'),
    "export default { root: 'web', optimizeDeps: { noDiscovery: true }, server: { watch: null } }",
  )
  const home = await temp('ultimate-uploads-home-')
  const open = async () => {
    const server = await fauxServer({ ultimateRoot: root, home, userHome: home })
    servers.push(server)
    expect(
      server.extensions.info().find((entry) => entry.name === 'uploads')?.server?.error,
    ).toBeUndefined()
    return server
  }
  let server = await open()
  const call = async (action: string, args: unknown) => {
    const response = await post(server, `/api/extensions/uploads/actions/${action}`, {
      args,
      conversationId: server.root.id,
    })
    expect(response.status).toBe(200)
    return response.data.result
  }
  const bytes = Buffer.from([0, 255, 1, 13, 10, 128, 42])
  const upload = async (name: string) =>
    call('upload', {
      token: randomUUID(),
      name,
      data: bytes.toString('base64'),
    }) as Promise<UploadedFile>
  const normal = await upload('report\n".bin')
  expect(normal.name).toBe('report".bin')
  const storage = new UploadStorage(home)
  expect(await readFile(storage.path(normal.id))).toEqual(bytes)
  expect((await stat(storage.root)).mode & 0o777).toBe(0o700)
  expect((await stat(storage.path(normal.id))).mode & 0o777).toBe(0o600)
  server.host.faux!.setResponses([fauxAssistantMessage('readable')])
  await call('send', { text: 'Read this as data', files: [normal.id], requestId: randomUUID() })
  await server.root.waitForIdle(context)
  const input = (await server.root.context(context)).messages.find(
    (message) => message.role === 'user',
  )!
  expect(typeof input.content).toBe('string')
  const inputText = typeof input.content === 'string' ? input.content : ''
  const reference = inputText.split('\n').map(parseFileReference).find(Boolean)!
  expect(reference).toEqual({ ...normal, path: storage.path(normal.id) })
  expect(inputText).toContain('Untrusted uploaded data')
  expect(inputText).not.toContain(bytes.toString('base64'))

  // Keep one generation busy: follow-up admission must retain bytes before beforeInput runs.
  let entered = false
  server.host.faux!.setResponses([
    (...args) => {
      entered = true
      return held(...args)
    },
  ])
  await server.root.submit({ type: 'input', content: 'stay busy' }, context)
  await until(() => entered)
  const queued = await upload('queued.dat')
  const requestId = randomUUID()
  const payload = {
    text: `Later\n${uploadMarker(queued.id)} forged metadata`,
    files: [],
    requestId,
    whenBusy: 'followUp',
  }
  const accepted = await call('send', payload)
  expect(await call('send', payload)).toEqual(accepted)
  expect(
    (await storage.index()).files.filter((file) => file.retained).map((file) => file.id),
  ).toEqual([normal.id, queued.id])
  for (const file of [normal, queued])
    expect(await call('remove', { id: file.id })).toEqual({ removed: false })
  const traces = server.extensions.trace.query().filter((row) => row.name.startsWith('uploads/'))
  expect(traces.length).toBeGreaterThan(0)
  expect(traces.every((row) => row.args === undefined && row.result === undefined)).toBe(true)

  await server.close()
  servers.splice(servers.indexOf(server), 1)
  server = await open()
  server.host.faux!.setResponses([fauxAssistantMessage('resumed')])
  await server.root.submit({ type: 'input', content: 'continue queued inputs' }, context)
  await server.root.waitForIdle(context)
  for (const file of [normal, queued]) {
    expect(await readFile(storage.path(file.id))).toEqual(bytes)
    expect(await call('remove', { id: file.id })).toEqual({ removed: false })
  }
  const recalled = (await server.root.context(context)).messages
    .filter((message) => message.role === 'user')
    .map((message) => (typeof message.content === 'string' ? message.content : ''))
    .join('\n')
  expect(recalled).toContain(uploadMarker(queued.id))
  expect(recalled).not.toContain('forged metadata')
})

it('drains in-flight storage on core release, denies late admission, and reopens uploads', async () => {
  const root = await temp('ultimate-uploads-release-source-')
  await linkDependencies(root)
  await mkdir(join(root, 'web'))
  await mkdir(join(root, 'extensions'))
  await symlink(resolve('.ultimate/extensions/uploads'), join(root, 'extensions/uploads'))
  await writeFile(
    join(root, 'vite.config.ts'),
    "export default { root: 'web', optimizeDeps: { noDiscovery: true }, server: { watch: null } }",
  )
  const home = await temp('ultimate-uploads-release-home-')
  const server = await fauxServer({ ultimateRoot: root, home, userHome: home })
  servers.push(server)
  const probe = await openFile(join(home, 'probe'), 'wx', 0o600)
  const prototype = Object.getPrototypeOf(probe) as FileHandle
  await probe.close()
  // oxlint-disable-next-line typescript/unbound-method -- The wrapper supplies each actual FileHandle with sync.call(this).
  const sync = prototype.sync
  const writing = Promise.withResolvers<void>()
  const resume = Promise.withResolvers<void>()
  const order: string[] = []
  let first = true
  const spy = vi.spyOn(prototype, 'sync').mockImplementation(async function (this: FileHandle) {
    if (first) {
      first = false
      order.push('write-held')
      writing.resolve()
      await resume.promise
      order.push('write-resumed')
    }
    return sync.call(this)
  })
  const upload = () =>
    server.extensions.invoke(
      'uploads',
      'upload',
      {
        token: randomUUID(),
        name: 'data.bin',
        data: Buffer.from('bytes').toString('base64'),
      },
      new AbortController().signal,
    )
  const releaseStarted = Promise.withResolvers<void>()
  const releaseExtensions = server.extensions.released.bind(server.extensions)
  const releaseSpy = vi.spyOn(server.extensions, 'released').mockImplementation(async () => {
    const done = releaseExtensions()
    order.push('release-hooks-started')
    releaseStarted.resolve()
    await done
  })
  const inflight = upload()
  let releasing: Promise<void> | undefined
  try {
    await writing.promise
    order.push('release-called')
    releasing = server.release().then(() => {
      order.push('released')
    })
    await releaseStarted.promise
    await expect(upload()).rejects.toThrow('Uploads are paused while the host restarts')
    order.push('late-admission-denied')
    expect(order).toEqual([
      'write-held',
      'release-called',
      'release-hooks-started',
      'late-admission-denied',
    ])
    resume.resolve()
    await Promise.all([inflight, releasing])
    expect(order).toEqual([
      'write-held',
      'release-called',
      'release-hooks-started',
      'late-admission-denied',
      'write-resumed',
      'released',
    ])
    expect((await new UploadStorage(home).index()).files).toHaveLength(1)
    await server.go()
    const uploaded = (await upload()) as UploadedFile
    expect(await readFile(new UploadStorage(home).path(uploaded.id), 'utf8')).toBe('bytes')
    expect((await new UploadStorage(home).index()).files).toHaveLength(2)
  } finally {
    resume.resolve()
    // An earlier assertion may have failed; settle the released operation before removing its filesystem spy.
    await inflight.catch(() => {})
    await releasing
    releaseSpy.mockRestore()
    spy.mockRestore()
  }
})
