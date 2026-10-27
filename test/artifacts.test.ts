import { apis, idleNeed, temp } from './helpers.ts'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fauxProvider } from '@earendil-works/pi-ai/providers/faux'
import { AgentDoc, configure, defineTask, ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import type { ConversationId } from '@earendil-works/pi-durable'
import { afterEach, expect, it } from 'vitest'
import { context, prepareHarness } from '../server/harness.ts'
import type { OpenHost } from '../server/harness.ts'
import type { ExtensionHost } from '../server/extensions.ts'
import { Metadata } from '../server/metadata.ts'
import { emit } from '../server/events.ts'
import { ConversationsApi } from '../extensions/conversations/api.ts'
import { WorkspacesApi } from '../extensions/workspaces/api.ts'
import { Workspaces } from '../extensions/workspaces/workspaces.ts'
import { Subagents, Standing, SubagentsApi } from '../extensions/subagents/api.ts'
import { submitInput } from '../server/submit.ts'
import { send } from '../extensions/messages/send.ts'
import artifactExtension, { Registry, actions } from '../.ultimate/extensions/artifacts/server.ts'
import { ArtifactsApi } from '../.ultimate/extensions/artifacts/api.ts'
import { ArtifactStorage, digest } from '../.ultimate/extensions/artifacts/storage.ts'
import type { FeedbackInput } from '../.ultimate/extensions/artifacts/types.ts'

const anchor = defineTask<null, { phase: 'done' }, null>({
  name: 'artifacts-test.owner',
  version: 1,
  initial: () => ({ phase: 'done' }),
  phases: {
    done: (_task, runtime, ctx) =>
      runtime.commit(
        () => ({ status: 'terminal', outcome: { status: 'completed', result: null } }),
        ctx,
      ),
  },
  abort: (_task, runtime, ctx) =>
    runtime.commit(() => ({ status: 'terminal', outcome: { status: 'aborted' } }), ctx),
})
const openedHosts: OpenHost[] = []
afterEach(async () => {
  for (const opened of openedHosts.splice(0)) await opened.close()
})

async function fixture() {
  const root = await temp('ultimate-artifacts-')
  const workspace = join(root, 'workspace')
  await mkdir(workspace)
  await writeFile(join(workspace, 'page.html'), '<h1>First</h1>')
  await writeFile(join(workspace, 'style.css'), 'h1 { color: red }')
  const prepared = await prepareHarness({
    home: join(root, 'state'),
    ultimateRoot: root,
    projectRoot: workspace,
    userHome: root,
    faux: fauxProvider(),
  })
  const services = apis()
  const onOpen: (() => Promise<void>)[] = []
  const onRelease: (() => Promise<void>)[] = []
  const resources = new Map<string, unknown>()
  const concluded = new Set<ConversationId>()
  let opened!: OpenHost
  const host = {
    ...prepared,
    projectRoot: workspace,
    harness: () => opened.harness,
    metadata: Metadata,
    implement: services.implement,
    want: services.want,
    need: ((api) =>
      services.provided.has(api.name)
        ? services.need(api)
        : idleNeed(api)) as ExtensionHost['need'],
    resource: (key: string, create: () => unknown) => {
      if (!resources.has(key)) resources.set(key, create())
      return resources.get(key)
    },
    onOpen: (callback: () => Promise<void>) => onOpen.push(callback),
    onRelease: (callback: () => Promise<void>) => onRelease.push(callback),
    onClose: () => {},
    notice: () => {},
    extensions: () => [],
    doc: () => undefined,
    emit,
    submit: (
      id: number,
      request: Parameters<ExtensionHost['submit']>[1],
      options: Parameters<ExtensionHost['submit']>[2],
    ) => submitInput(prepared, opened.harness, id, request, options),
  } as unknown as ExtensionHost
  services.implement(ConversationsApi, {
    ...idleNeed(ConversationsApi),
    concludedIn: async () => concluded,
  })
  services.implement(WorkspacesApi, { ...idleNeed(WorkspacesApi), doc: Workspaces })
  prepared.registry.install(artifactExtension(host))
  const open = async () => {
    opened = await prepared.open()
    const close = opened.close.bind(opened)
    opened.close = async () => {
      for (const callback of onRelease) await callback()
      await close()
    }
    openedHosts.push(opened)
    for (const callback of onOpen) await callback()
  }
  await open()
  const create = async () => {
    const conversation = await opened.harness.createConversation(
      { ownership: { kind: 'ownerless' } },
      context,
    )
    const agent = await opened.root.agent(context)
    await opened.harness.commit(
      (tx) => configure(tx, conversation.id, { model: agent.model, tools: [], cwd: workspace }),
      context,
    )
    return conversation.id
  }
  const owner = await create()
  const ultimate = await create()
  services.implement(SubagentsApi, {
    ...idleNeed(SubagentsApi),
    standing: async (name) => {
      expect(name).toBe('ultimate')
      return ultimate
    },
  })
  await opened.harness.commit(async (tx) => {
    ;(await tx.doc(Standing, ROOT_CONVERSATION_ID)).ultimate = ultimate
  }, context)
  const service = services.need(ArtifactsApi)
  const reopen = async () => {
    const index = openedHosts.indexOf(opened)
    openedHosts.splice(index, 1)
    await opened.close()
    await open()
  }
  return {
    host,
    services,
    service,
    root,
    workspace,
    owner,
    ultimate,
    create,
    concluded,
    reopen,
    opened: () => opened,
  }
}

it('publishes from the authenticated owner, refreshes the coherent bundle, and retains it after workspace cleanup', async () => {
  const f = await fixture()
  await f.opened().harness.commit(async (tx) => {
    await configure(tx, f.owner, { cwd: join(f.root, 'not-the-workspace') })
    ;(await tx.doc(Workspaces, ROOT_CONVERSATION_ID)).items[String(f.owner)] = {
      path: f.workspace,
      branch: 'review',
      base: 'base',
      source: f.workspace,
      target: 'main',
      state: 'ready',
    }
  }, context)
  const artifact = await actions.publish(
    { title: 'Review', path: 'page.html', assets: ['style.css'], ownerConversation: 9999 },
    {
      host: f.host,
      conversationId: f.owner,
      signal: new AbortController().signal,
      exec: async () => ({ stdout: '', stderr: '' }),
    },
  )
  expect(artifact.ownerConversation).toBe(f.owner)
  expect(artifact.source.workspace).toBe(f.workspace)
  const initial = await f.service.read(artifact.id, context)
  expect(initial.html).toBe('<h1>First</h1>')
  expect(initial.assets).toEqual([
    {
      path: 'style.css',
      mime: 'text/css',
      base64: Buffer.from('h1 { color: red }').toString('base64'),
    },
  ])
  const other = await f.create()
  await expect(
    f.service.publish({ id: artifact.id, title: 'Hijack', path: 'page.html' }, other, context),
  ).rejects.toThrow('Only the artifact owner')
  await writeFile(join(f.workspace, 'page.html'), '<h1>Revised</h1>')
  await writeFile(join(f.workspace, 'style.css'), 'h1 { color: blue }')
  const refreshed = await f.service.read(artifact.id, context)
  expect(refreshed.artifact.contentHash).not.toBe(artifact.contentHash)
  expect(refreshed.html).toBe('<h1>Revised</h1>')
  expect(Buffer.from(refreshed.assets[0].base64, 'base64').toString()).toContain('blue')
  const storage = new ArtifactStorage(f.host.home)
  await expect(readFile(join(storage.snapshotPath(artifact), 'page.html'))).rejects.toMatchObject({
    code: 'ENOENT',
  })
  await rm(f.workspace, { recursive: true })
  await f.opened().harness.commit(async (tx) => {
    ;(await tx.doc(Workspaces, ROOT_CONVERSATION_ID)).items[String(f.owner)].state = 'removed'
  }, context)
  await f.reopen()
  const retained = await f.service.read(artifact.id, context)
  expect(retained.html).toBe(refreshed.html)
  expect(retained.artifact.contentHash).toBe(refreshed.artifact.contentHash)
  expect(retained.sourceError).toBe('Artifact workspace is removed')
  expect(await f.service.list(context)).toEqual([refreshed.artifact])
})

it('saves exact feedback and images before sending, recovers a lost acknowledgement once, and preserves a concluded route', async () => {
  const f = await fixture()
  const artifact = await f.service.publish({ title: 'Review', path: 'page.html' }, f.owner, context)
  const input: FeedbackInput = {
    artifactId: artifact.id,
    requestId: 'human-1',
    contentHash: artifact.contentHash,
    recipientConversation: f.owner,
    notes: [
      {
        id: 'n1',
        text: 'Increase contrast',
        anchor: { kind: 'element', selector: 'img', text: '' },
      },
    ],
    images: [
      {
        name: 'reference.png',
        mime: 'image/png',
        base64: Buffer.from('reference-image-bytes').toString('base64'),
      },
    ],
  }
  const original = f.host.submit.bind(f.host)
  let calls = 0
  let receipt: number | undefined
  f.host.submit = async (destination, request, options) => {
    const ctx = options.context
    calls++
    const saved = await f.opened().harness.snapshot(Registry, ROOT_CONVERSATION_ID, ctx)
    const record = Object.values(saved!.feedback)[0]
    expect(record.bundle.state).toBe('saved')
    expect(record.bundle).toMatchObject({
      ...input,
      images: [{ name: 'reference.png', mime: 'image/png' }],
    })
    expect(record.bundle.images[0]).not.toHaveProperty('base64')
    const storage = new ArtifactStorage(f.host.home)
    expect(
      JSON.parse(
        await readFile(
          join(storage.feedbackPath(artifact.id, record.bundle.id), 'bundle.json'),
          'utf8',
        ),
      ),
    ).toMatchObject(input)
    expect(await readFile(storage.imagePaths(record.bundle)[0], 'utf8')).toBe(
      'reference-image-bytes',
    )
    expect(destination).toBe(f.owner)
    expect(request.text).toContain(storage.imagePaths(record.bundle)[0])
    expect(request.whenBusy).toBe('followUp')
    receipt = (await original(destination, request, options)).submissionId
    throw new Error('Lost acknowledgement after input admission')
  }
  const saved = await f.service.feedback(input, context)
  expect(saved.state).toBe('saved')
  expect(saved.deliveryError).toContain('Lost acknowledgement')
  expect(calls).toBe(1)
  f.concluded.add(f.owner)
  f.host.submit = async (...args) => {
    calls++
    return original(...args)
  }
  await f.reopen()
  expect(calls).toBe(1)
  expect(f.concluded.has(f.owner)).toBe(true)
  f.host.submit = original
  const duplicate = await f.service.feedback(input, context)
  expect(duplicate).toMatchObject({
    ...input,
    id: saved.id,
    routedTo: f.owner,
    state: 'delivered',
    submissionId: receipt,
  })
  expect(duplicate.deliveryError).toBeUndefined()
  const [summary] = await f.service.feedbackList(artifact.id, context)
  expect(summary.images).toEqual([{ name: 'reference.png', mime: 'image/png' }])
  expect(summary.images[0]).not.toHaveProperty('base64')
  const full = await f.service.feedbackRead(artifact.id, saved.id, context)
  expect(full).toEqual(duplicate)
  expect(full.images).toEqual(input.images)
  const otherOwner = await f.create()
  const otherArtifact = await f.service.publish(
    { title: 'Other review', path: 'page.html' },
    otherOwner,
    context,
  )
  await expect(f.service.feedbackRead(otherArtifact.id, saved.id, context)).rejects.toThrow(
    'Unknown feedback for this artifact',
  )
  const admitted = await f
    .opened()
    .harness.commit((tx) => tx.submissionByRequest(f.owner, `artifacts:${saved.id}`), context)
  expect(admitted?.id).toBe(receipt)
  await expect(
    f.service.feedback({ ...input, notes: [{ id: 'n1', text: 'Different' }] }, context),
  ).rejects.toThrow('conflicts')
  f.concluded.add(f.owner)
  const routed = await f.service.feedback({ ...input, requestId: 'human-2' }, context)
  expect(routed).toMatchObject({
    recipientConversation: f.owner,
    routedTo: f.ultimate,
    state: 'delivered',
  })
  const ultimateAdmission = await f
    .opened()
    .harness.commit((tx) => tx.submissionByRequest(f.ultimate, `artifacts:${routed.id}`), context)
  expect(ultimateAdmission?.id).toBe(routed.submissionId)
  f.concluded.delete(f.owner)
  expect(
    (await f.service.feedbackList(artifact.id, context)).find((bundle) => bundle.id === routed.id)
      ?.routedTo,
  ).toBe(f.ultimate)
})

it('reroutes saved but unadmitted feedback when its destination concludes before recovery', async () => {
  const f = await fixture()
  const artifact = await f.service.publish({ title: 'Review', path: 'page.html' }, f.owner, context)
  const original = f.host.submit.bind(f.host)
  f.host.submit = async () => {
    throw new Error('Interrupted before admission')
  }
  const saved = await f.service.feedback(
    {
      artifactId: artifact.id,
      requestId: 'not-admitted',
      contentHash: artifact.contentHash,
      recipientConversation: f.owner,
      notes: [{ id: 'n', text: 'Please revise' }],
      images: [],
    },
    context,
  )
  expect(saved).toMatchObject({
    routedTo: f.owner,
    state: 'saved',
    deliveryError: 'Interrupted before admission',
  })
  f.concluded.add(f.owner)
  f.host.submit = original
  await f.reopen()
  const [recovered] = await f.service.feedbackList(artifact.id, context)
  expect(recovered).toMatchObject({
    recipientConversation: f.owner,
    routedTo: f.ultimate,
    state: 'delivered',
  })
  const receipts = await f.opened().harness.commit(
    async (tx) => ({
      owner: (await tx.submissionByRequest(f.owner, `artifacts:${saved.id}`))?.id,
      ultimate: (await tx.submissionByRequest(f.ultimate, `artifacts:${saved.id}`))?.id,
    }),
    context,
  )
  expect(receipts).toEqual({ owner: undefined, ultimate: recovered.submissionId })
})

it('recovers an orphaned feedback folder without confusing its payload or immutable route', async () => {
  const f = await fixture()
  const artifact = await f.service.publish({ title: 'Review', path: 'page.html' }, f.owner, context)
  const input: FeedbackInput = {
    artifactId: artifact.id,
    requestId: 'orphan',
    contentHash: artifact.contentHash,
    recipientConversation: f.owner,
    notes: [{ id: 'n', text: 'Keep this original' }],
    images: [],
  }
  const id = digest(JSON.stringify([input.artifactId, input.requestId]))
  const storage = new ArtifactStorage(f.host.home)
  await storage.saveFeedback({ ...input, id, createdAt: 123, routedTo: f.ultimate, state: 'saved' })
  await expect(
    f.service.feedback(
      { ...input, notes: [{ id: 'n', text: 'Changed after interrupted save' }] },
      context,
    ),
  ).rejects.toThrow('conflicts')
  const recovered = await f.service.feedback(input, context)
  expect(recovered).toMatchObject({ ...input, createdAt: 123, routedTo: f.ultimate })
})

it('admits human feedback for a child publisher without impersonating a message sender', async () => {
  const f = await fixture()
  const child = await f.opened().harness.commit(async (tx) => {
    const taskId = await tx.createTask(anchor, null, {
      ownership: { kind: 'conversation' },
      conversationId: f.owner,
      background: true,
    })
    const { id } = await tx.createConversation({ ownership: { kind: 'task', taskId } })
    const agent = await tx.doc(AgentDoc, f.owner)
    await configure(tx, id, { model: agent.model, tools: [], cwd: f.workspace })
    return id
  }, context)
  await f.opened().harness.commit(async (tx) => {
    ;(await tx.doc(Subagents, f.owner)).agents[String(child)] = {
      conversationId: child,
      agent: 'maker',
      background: false,
      reported: [],
    }
  }, context)
  await expect(
    send(f.host, child, { to: `#${f.ultimate}`, text: 'Not permitted', reply: false }, context),
  ).rejects.toThrow('Subagents report')
  const artifact = await f.service.publish(
    { title: 'Child review', path: 'page.html' },
    child,
    context,
  )
  const bundle = await f.service.feedback(
    {
      artifactId: artifact.id,
      requestId: 'child-review',
      contentHash: artifact.contentHash,
      recipientConversation: child,
      notes: [{ id: 'n', text: 'Please revise' }],
      images: [],
    },
    context,
  )
  expect(bundle).toMatchObject({ state: 'delivered', routedTo: child })
  const admitted = await f
    .opened()
    .harness.commit((tx) => tx.submissionByRequest(child, `artifacts:${bundle.id}`), context)
  expect(admitted?.id).toBe(bundle.submissionId)
})
