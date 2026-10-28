import { apis, idleNeed, temp } from '../../../../test/helpers.ts'
import { lstat, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fauxProvider } from '@earendil-works/pi-ai/providers/faux'
import { AgentDoc, configure, defineTask, ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import type { ConversationId } from '@earendil-works/pi-durable'
import { afterEach, expect, it } from 'vitest'
import { context, prepareHarness } from '../../../../server/harness.ts'
import type { OpenHost } from '../../../../server/harness.ts'
import type { ExtensionHost } from '../../../../server/extensions.ts'
import { Metadata } from '../../../../server/metadata.ts'
import { emit } from '../../../../server/events.ts'
import { ConversationsApi } from '../../../../extensions/conversations/api.ts'
import { WorkspacesApi } from '../../../../extensions/workspaces/api.ts'
import { Workspaces } from '../../../../extensions/workspaces/workspaces.ts'
import { Subagents, Standing, SubagentsApi } from '../../../../extensions/subagents/api.ts'
import { submitInput } from '../../../../server/submit.ts'
import { send } from '../../../../extensions/messages/send.ts'
import artifactExtension, { Registry, actions } from '../server.ts'
import { ArtifactsApi, FeedbackTooLargeError } from '../api.ts'
import { ArtifactStorage, digest, feedbackInput } from '../storage.ts'
import { FEEDBACK_IMAGE_MAX_BYTES, FEEDBACK_MAX_JSON_BYTES } from '../types.ts'
import type { FeedbackInput, LayoutFinding } from '../types.ts'

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

it('refreshes unchanged content without retransferring HTML, assets or the annotation channel', async () => {
  const f = await fixture()
  const artifact = await f.service.publish({ title: 'Review', path: 'page.html' }, f.owner, context)
  const actionContext = {
    host: f.host,
    conversationId: f.owner,
    signal: new AbortController().signal,
    exec: async () => ({ stdout: '', stderr: '' }),
  }
  const snapshot = await actions.read({ id: artifact.id }, actionContext)
  expect(snapshot.html).toBe('<h1>First</h1>')
  const full = await actions.reviewRead(
    { id: artifact.id, parentOrigin: 'https://review.example' },
    actionContext,
  )
  expect(full).toHaveProperty('srcdoc', expect.stringContaining('First'))
  expect(full).toHaveProperty('channel')
  const unchanged = await actions.reviewRead(
    {
      id: artifact.id,
      parentOrigin: 'https://review.example',
      knownHash: snapshot.artifact.contentHash,
    },
    actionContext,
  )
  expect(unchanged).toEqual({
    unchanged: true,
    artifact: snapshot.artifact,
    sourceError: undefined,
  })
  expect(unchanged).not.toHaveProperty('srcdoc')
  expect(unchanged).not.toHaveProperty('channel')
})

it('rejects a landing log destination before retaining or admitting a new feedback batch', async () => {
  const f = await fixture()
  const artifact = await f.service.publish({ title: 'Review', path: 'page.html' }, f.owner, context)
  const lander = await f.create()
  await f.opened().harness.commit(async (tx) => {
    ;(await tx.doc(Workspaces, ROOT_CONVERSATION_ID)).landerConversations[f.workspace] = lander
  }, context)
  const input: FeedbackInput = {
    artifactId: artifact.id,
    requestId: 'refuse-lander',
    contentHash: artifact.contentHash,
    recipientConversation: lander,
    notes: [{ id: 'note', text: 'Keep this draft' }],
    images: [],
  }
  await expect(f.service.feedback(input, context)).rejects.toThrow(
    'The landing log cannot receive artifact feedback',
  )
  expect(
    await actions.reviewFeedback(JSON.parse(JSON.stringify(input)), {
      host: f.host,
      conversationId: f.owner,
      signal: new AbortController().signal,
      exec: async () => ({ stdout: '', stderr: '' }),
    }),
  ).toMatchObject({ rejected: 'destination' })
  expect(
    (await f.opened().harness.snapshot(Registry, ROOT_CONVERSATION_ID, context))?.feedback,
  ).toEqual({})
  await expect(
    lstat(join(f.host.home, 'artifacts', artifact.id, 'feedback')),
  ).rejects.toMatchObject({ code: 'ENOENT' })
  const id = digest(JSON.stringify([artifact.id, input.requestId]))
  expect(
    await f
      .opened()
      .harness.commit((tx) => tx.submissionByRequest(lander, `artifacts:${id}`), context),
  ).toBeUndefined()
})

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

it('retains real layout observations and only resolves them after a complete newer-hash pass at the exact measured viewport', async () => {
  const f = await fixture()
  const first = await f.service.publish({ title: 'Layout', path: 'page.html' }, f.owner, context)
  const viewport = { width: 800, height: 601 }
  const finding: LayoutFinding = {
    rule: 'clipped-control',
    selector: '#save',
    axis: 'vertical',
    overflowPx: 42,
  }
  expect(await f.service.layoutRead(first.id, context)).toEqual({ issues: [] })
  const observed = await f.service.layoutPass(
    {
      artifactId: first.id,
      contentHash: first.contentHash,
      viewport,
      complete: true,
      findings: [finding],
    },
    context,
  )
  const [issue] = observed.issues
  expect(issue).toMatchObject({
    ...finding,
    viewport,
    contentHash: first.contentHash,
    status: 'open',
  })
  const absentSameHash = await f.service.layoutPass(
    {
      artifactId: first.id,
      contentHash: first.contentHash,
      viewport,
      complete: true,
      findings: [],
    },
    context,
  )
  expect(absentSameHash.issues[0].status).toBe('open')
  const dismissed = await f.service.layoutDismiss(
    { artifactId: first.id, issueId: issue.id, contentHash: first.contentHash },
    context,
  )
  expect(dismissed.issues[0]).toMatchObject({
    status: 'dismissed',
    dismissedFor: first.contentHash,
  })
  await writeFile(join(f.workspace, 'page.html'), '<h1>Revised layout</h1>')
  const revised = await f.service.read(first.id, context)
  const currentHash = revised.artifact.contentHash
  const stale = await f.service.layoutRead(first.id, context)
  expect(stale).toMatchObject({
    stale: true,
    issues: [{ status: 'open', contentHash: first.contentHash }],
  })
  // A user can dismiss an older observation for the current revision without falsifying its provenance.
  expect(
    (
      await f.service.layoutDismiss(
        { artifactId: first.id, issueId: issue.id, contentHash: currentHash },
        context,
      )
    ).issues[0],
  ).toMatchObject({
    status: 'dismissed',
    dismissedFor: currentHash,
    contentHash: first.contentHash,
  })
  const pass = {
    artifactId: first.id,
    contentHash: currentHash,
    viewport,
    complete: true,
    findings: [],
  }
  const incomplete = await f.service.layoutPass(
    { ...pass, complete: false, error: 'Font measurement deadline' },
    context,
  )
  expect(incomplete).toMatchObject({
    pass: { complete: false, error: 'Font measurement deadline' },
    issues: [{ status: 'dismissed' }],
  })
  const otherViewport = await f.service.layoutPass(
    { ...pass, viewport: { ...viewport, height: 600 } },
    context,
  )
  expect(otherViewport.issues[0].status).toBe('dismissed')
  const rejected = await f.service.layoutPass({ ...pass, contentHash: first.contentHash }, context)
  expect(rejected).toMatchObject({
    stale: true,
    pass: { complete: false, error: expect.stringContaining('Stale') },
  })
  expect((await f.service.layoutRead(first.id, context)).pass).toEqual(otherViewport.pass)
  await expect(
    f.service.layoutDismiss(
      { artifactId: first.id, issueId: issue.id, contentHash: first.contentHash },
      context,
    ),
  ).rejects.toThrow('stale')
  const resolved = await f.service.layoutPass(pass, context)
  expect(resolved.issues[0]).toMatchObject({
    id: issue.id,
    contentHash: first.contentHash,
    lastSeenAt: issue.lastSeenAt,
    status: 'resolved',
  })
  await f.reopen()
  expect((await f.service.layoutRead(first.id, context)).issues[0].status).toBe('resolved')
  const present = await f.service.layoutPass(
    { ...pass, findings: [{ ...finding, overflowPx: 60 }] },
    context,
  )
  expect(present.issues[0]).toMatchObject({
    id: issue.id,
    status: 'open',
    contentHash: currentHash,
    overflowPx: 60,
  })
  const differentlyMeasured = await f.service.layoutPass(
    { ...pass, viewport: { width: 801, height: 601 }, findings: [finding] },
    context,
  )
  expect(differentlyMeasured.issues).toHaveLength(2)
  expect(differentlyMeasured.issues[1].id).not.toBe(issue.id)
})

it('keeps bounded layout state honest when observation capacity is exhausted', async () => {
  const f = await fixture()
  const artifact = await f.service.publish(
    { title: 'Capacity', path: 'page.html' },
    f.owner,
    context,
  )
  const findings = (offset: number): LayoutFinding[] =>
    Array.from({ length: 100 }, (_, index) => ({
      rule: 'page-horizontal-overflow',
      selector: `#wide-${offset + index}`,
      axis: 'horizontal',
      overflowPx: 12,
    }))
  const input = {
    artifactId: artifact.id,
    contentHash: artifact.contentHash,
    viewport: { width: 390, height: 844 },
    complete: true,
    findings: findings(0),
  }
  await f.service.layoutPass(input, context)
  await f.service.layoutPass({ ...input, findings: findings(100) }, context)
  await writeFile(join(f.workspace, 'page.html'), '<h1>New revision with capacity reached</h1>')
  const revised = await f.service.read(artifact.id, context)
  const result = await f.service.layoutPass(
    { ...input, contentHash: revised.artifact.contentHash, findings: findings(200) },
    context,
  )
  expect(result.issues).toHaveLength(200)
  expect(result.issues.every((issue) => issue.status === 'open')).toBe(true)
  expect(result.pass).toMatchObject({
    complete: false,
    error: expect.stringContaining('100 findings not retained'),
  })
  expect((await f.service.layoutRead(artifact.id, context)).pass).toEqual(result.pass)
})

it('saves note-associated images and immutable server-observed issue context across reads and admission retries', async () => {
  const f = await fixture()
  const artifact = await f.service.publish(
    { title: 'Associations', path: 'page.html' },
    f.owner,
    context,
  )
  const finding: LayoutFinding = {
    rule: 'unreachable-control',
    selector: '#submit',
    axis: 'horizontal',
    overflowPx: 55,
  }
  const viewport = { width: 390, height: 844 }
  const [issue] = (
    await f.service.layoutPass(
      {
        artifactId: artifact.id,
        contentHash: artifact.contentHash,
        viewport,
        complete: true,
        findings: [finding],
      },
      context,
    )
  ).issues
  await writeFile(join(f.workspace, 'page.html'), '<h1>Repaired revision</h1>')
  const revised = await f.service.read(artifact.id, context)
  await f.service.layoutPass(
    {
      artifactId: artifact.id,
      contentHash: revised.artifact.contentHash,
      viewport,
      complete: true,
      findings: [],
    },
    context,
  )
  const input: FeedbackInput = {
    artifactId: artifact.id,
    requestId: 'associated',
    contentHash: artifact.contentHash,
    recipientConversation: f.owner,
    notes: [
      { id: 'picture-note', text: '' },
      { id: 'layout-note', text: 'Check the measured target', layoutIssueIds: [issue.id] },
    ],
    images: [
      {
        name: 'note.png',
        mime: 'image/png',
        base64: Buffer.from('note-image').toString('base64'),
        noteId: 'picture-note',
      },
      {
        name: 'general.png',
        mime: 'image/png',
        base64: Buffer.from('general-image').toString('base64'),
      },
    ],
  }
  const original = f.host.submit.bind(f.host)
  let makerText = ''
  f.host.submit = async (...args) => {
    makerText = args[1].text
    await original(...args)
    throw new Error('Lost acknowledgement')
  }
  const saved = await f.service.feedback(
    { ...input, layoutIssues: [{ ...issue, overflowPx: 999 }] } as FeedbackInput,
    context,
  )
  expect(saved.layoutIssues).toEqual([{ ...issue, status: 'resolved' }])
  expect(saved.images).toEqual(input.images)
  expect(makerText).toContain('for note picture-note')
  expect(makerText).toContain('general reference')
  expect(makerText).toContain(`Layout issue references: ${issue.id}`)
  expect(makerText).toContain(JSON.stringify(saved.layoutIssues![0]))
  const storage = new ArtifactStorage(f.host.home)
  expect(
    JSON.parse(
      await readFile(join(storage.feedbackPath(artifact.id, saved.id), 'bundle.json'), 'utf8'),
    ),
  ).toMatchObject({ images: input.images, layoutIssues: saved.layoutIssues })
  await f.service.layoutPass(
    {
      artifactId: artifact.id,
      contentHash: revised.artifact.contentHash,
      viewport,
      complete: true,
      findings: [{ ...finding, overflowPx: 80 }],
    },
    context,
  )
  f.host.submit = original
  await f.reopen()
  const duplicate = await f.service.feedback(input, context)
  expect(duplicate).toMatchObject({
    state: 'delivered',
    images: input.images,
    layoutIssues: saved.layoutIssues,
  })
  await expect(
    f.service.feedback(
      { ...input, images: [input.images[0], { ...input.images[1], noteId: 'layout-note' }] },
      context,
    ),
  ).rejects.toThrow('conflicts')
  const [metadata] = await f.service.feedbackList(artifact.id, context)
  expect(metadata.images).toEqual([
    { name: 'note.png', mime: 'image/png', noteId: 'picture-note' },
    { name: 'general.png', mime: 'image/png' },
  ])
  expect((await f.service.feedbackRead(artifact.id, saved.id, context)).layoutIssues).toEqual(
    saved.layoutIssues,
  )
  await expect(
    f.service.feedback(
      { ...input, requestId: 'bad-note', images: [{ ...input.images[0], noteId: 'missing' }] },
      context,
    ),
  ).rejects.toThrow('noteId')
  await expect(
    f.service.feedback({ ...input, requestId: 'phantom', images: [input.images[1]] }, context),
  ).rejects.toThrow('Blank notes')
  const other = await f.service.publish({ title: 'Other', path: 'page.html' }, f.owner, context)
  await expect(
    f.service.feedback({ ...input, artifactId: other.id, requestId: 'cross-artifact' }, context),
  ).rejects.toThrow('Unknown layout issue')
})

it('reports expanded feedback size as a definitive typed rejection before saving or admitting, without rejecting an earlier retained batch', async () => {
  const f = await fixture()
  const artifact = await f.service.publish(
    { title: 'Large context', path: 'page.html' },
    f.owner,
    context,
  )
  const observed = await f.service.layoutPass(
    {
      artifactId: artifact.id,
      contentHash: artifact.contentHash,
      viewport: { width: 390, height: 844 },
      complete: true,
      findings: Array.from({ length: 50 }, (_, index) => ({
        rule: 'clipped-control',
        selector: `main > ${'div > '.repeat(330)}button#control-${index}`,
        axis: 'vertical',
        overflowPx: 10,
      })),
    },
    context,
  )
  const input: FeedbackInput = {
    artifactId: artifact.id,
    requestId: 'expanded-size',
    contentHash: artifact.contentHash,
    recipientConversation: f.owner,
    notes: Array.from({ length: 50 }, (_, index) => ({
      id: `note-${index}`,
      text: '\u0001'.repeat(4000),
      ...(index < 15
        ? { anchor: { kind: 'element' as const, selector: '#target', text: '\u0001'.repeat(2000) } }
        : {}),
      ...(index === 0 ? { layoutIssueIds: observed.issues.map((issue) => issue.id) } : {}),
    })),
    images: [
      {
        name: 'reference.png',
        mime: 'image/png',
        base64: Buffer.alloc(FEEDBACK_IMAGE_MAX_BYTES).toString('base64'),
      },
    ],
  }
  const normalized = feedbackInput(input)
  expect(Buffer.byteLength(JSON.stringify(normalized))).toBeLessThan(FEEDBACK_MAX_JSON_BYTES)
  expect(
    Buffer.byteLength(JSON.stringify({ ...normalized, layoutIssues: observed.issues })),
  ).toBeGreaterThan(FEEDBACK_MAX_JSON_BYTES)
  let admitted = 0
  f.host.submit = async () => {
    admitted++
    throw new Error('Unexpected admission')
  }
  const rejected = await f.service.feedback(input, context).catch((error: unknown) => error)
  expect(rejected).toBeInstanceOf(FeedbackTooLargeError)
  expect(rejected).toMatchObject({ code: 'feedback-too-large' })
  expect(admitted).toBe(0)
  expect(
    (await f.opened().harness.snapshot(Registry, ROOT_CONVERSATION_ID, context))?.feedback ?? {},
  ).toEqual({})
  const id = digest(JSON.stringify([artifact.id, input.requestId]))
  expect(
    await f
      .opened()
      .harness.commit((tx) => tx.submissionByRequest(f.owner, `artifacts:${id}`), context),
  ).toBeUndefined()
  const storage = new ArtifactStorage(f.host.home)
  await expect(lstat(join(storage.artifactPath(artifact.id), 'feedback'))).rejects.toMatchObject({
    code: 'ENOENT',
  })
  expect(() =>
    feedbackInput({
      ...input,
      notes: input.notes.map((note, index) =>
        index === 15 ? { ...note, anchor: input.notes[0].anchor } : note,
      ),
    }),
  ).toThrow(FeedbackTooLargeError)
  // An earlier save's immutable context wins over a newly expanded candidate for the same request.
  const earlier = await storage.saveFeedback({
    ...input,
    id,
    createdAt: 1,
    routedTo: f.owner,
    state: 'saved',
  })
  const reused = await storage.saveFeedback({ ...earlier, layoutIssues: observed.issues })
  expect(reused).toEqual(earlier)
})
