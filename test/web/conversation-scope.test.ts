import { createElement as h, Fragment } from 'react'
import type { EffectCallback, ReactElement, ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { StreamedView } from '../../shared/protocol.ts'
import { actionRef, docRef } from '../../shared/extension-api.ts'
import { FakeSource } from './fake-source.ts'
import { fillComposer, prepareInstanceNavigation } from '../../web/src/app/composer.tsx'
import type { NavigationDraft } from '../../web/src/app/navigation-drafts.ts'

const preservation = vi.hoisted(() =>
  vi.fn<(drafts: NavigationDraft[]) => Promise<void>>(async () => {}),
)
const recovery = vi.hoisted(() => ({
  has: vi.fn<() => boolean>(() => false),
  restore: vi.fn<(restore: (drafts: NavigationDraft[]) => void) => Promise<void>>(async () => {}),
}))
vi.mock('../../web/src/app/navigation-drafts.ts', () => ({
  hasNavigationDrafts: recovery.has,
  restoreNavigationDrafts: recovery.restore,
  saveNavigationDrafts: preservation,
}))

const harness = vi.hoisted(() => ({
  sources: [] as FakeSource[],
  effects: [] as EffectCallback[],
  submit: undefined as (() => void) | undefined,
  change: undefined as ((event: { target: { value: string } }) => void) | undefined,
  keyDown: undefined as ((event: object) => void) | undefined,
  stop: undefined as (() => void) | undefined,
  cancel: undefined as (() => void) | undefined,
  fetch: vi.fn<typeof fetch>(async () => Response.json({ ok: true })),
}))
// Server rendering supplies real React context but has no commit phase. Run captured effects explicitly, and read
// external-store snapshots directly, to exercise scopes and composer callbacks without a DOM or a new dependency.
vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) => snapshot(),
  useEffect: (effect: EffectCallback) => harness.effects.push(effect),
}))
vi.mock('../../web/src/sdk/client.ts', async () => {
  const { createStore } = await import('../../web/src/sdk/store.ts')
  const { createApi } = await import('../../web/src/sdk/api.ts')
  const { createRegistry } = await import('../../web/src/sdk/registry.ts')
  const { FakeSource } = await import('./fake-source.ts')
  const store = createStore({
    eventSource: (url) => {
      const stream = new FakeSource(url)
      harness.sources.push(stream)
      return stream
    },
    fetch: harness.fetch,
    retryMs: 5,
  })
  return { store, api: createApi(store, { fetch: harness.fetch }), registry: createRegistry() }
})
vi.mock('../../web/src/sdk/resume.ts', () => ({ covered: () => false }))
vi.mock('@/components/ai/prompt-input', () => ({
  PromptInput: ({
    children,
    onSubmit,
  }: {
    children: ReactNode
    onSubmit: (event: object) => void
  }) => {
    harness.submit = () => onSubmit({ preventDefault() {} })
    return h('form', null, children)
  },
  PromptInputTextarea: (props: {
    id: string
    value: string
    onChange: typeof harness.change
    onKeyDown: typeof harness.keyDown
  }) => {
    harness.change = props.onChange
    harness.keyDown = props.onKeyDown
    return h('textarea', { id: props.id, defaultValue: props.value })
  },
  PromptInputSubmit: ({ mode, onClick }: { mode?: string; onClick?: () => void }) => {
    if (mode === 'stop') harness.stop = onClick
    return h('button', null, mode ?? 'send')
  },
  PromptInputFooter: ({ children }: { children: ReactNode }) => children,
  PromptInputTools: ({ children }: { children: ReactNode }) => children,
}))

import { registry, store } from '../../web/src/sdk/client.ts'
import { ConversationScope } from '../../web/src/sdk/conversation-scope.tsx'
import { Conversation } from '../../web/src/app/primitives.tsx'
import {
  ComposerAttachmentAdapter,
  useComposerAttachments,
} from '../../web/src/sdk/composer-attachments.tsx'
import type {
  ComposerAttachmentController,
  ComposerSubmission,
} from '../../web/src/sdk/composer-attachments.tsx'
import {
  getConversation,
  TranscriptContext,
  useAction,
  useConversation,
  useDoc,
  useTranscript,
  useUltimate,
} from '../../web/src/sdk/hooks.ts'

const counter = docRef<{ n: number }>('test.counter')
const effects: (() => void)[] = []
const storage = new Map<string, string>()
beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  })
  vi.stubGlobal('location', { search: '' })
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }))
  harness.fetch.mockClear()
  harness.sources.length = 0
  harness.effects.length = 0
  storage.clear()
  store.show(undefined)
  store.start()
})
afterEach(() => {
  for (const release of effects.splice(0)) release()
  store.stop()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})
function commitEffects() {
  for (const effect of harness.effects.splice(0)) {
    const release = effect()
    if (release) effects.push(release)
  }
}
const tick = () => vi.advanceTimersByTimeAsync(10)
function source(id: number) {
  return harness.sources.findLast(
    (stream) =>
      !stream.closed &&
      new URL(stream.url, 'http://local').searchParams.get('conversation') === String(id),
  )!
}
function view(id: number, text: string, busy = false): StreamedView {
  return {
    conversation: { id },
    entries: [
      {
        id: id * 10,
        conversationId: id,
        kind: 'pi.user',
        model: [{ role: 'user', content: text, timestamp: 0 }],
      },
    ],
    docs: {
      'pi.agent': { model: { provider: 'faux', modelId: 'faux-1' } },
      'pi.live': busy ? { run: { taskId: 2, inputs: [] } } : {},
      'pi.inbox': { items: [{ id: id * 100, mode: 'steer', content: `queued ${id}` }] },
    },
  } as unknown as StreamedView
}
function Probe() {
  const { id, entries } = useConversation()
  const selected = useConversation((conversation) => conversation.id)
  const transcript = useTranscript()
  const doc = useDoc(counter)
  const ultimate = useUltimate()
  return h(
    'output',
    null,
    JSON.stringify({ id, selected, entries, transcript, doc, ultimate: ultimate.conversationId }),
  )
}
const scoped = (id: number, children: ReactNode) => h(ConversationScope, { id, children })
function renderScopes() {
  return renderToStaticMarkup(h(Fragment, null, scoped(7, h(Probe)), scoped(9, h(Probe)), h(Probe)))
}

it('prepares full scoped drafts before navigation and stays when preservation fails', async () => {
  let controller: ComposerAttachmentController
  await registry.setLoaders({
    '/extensions/navigation/web.tsx': async () => ({
      default: {
        slots: {
          'composer.attachments': () => {
            controller = useComposerAttachments()
            return null
          },
        },
      },
    }),
  })
  effects.push(store.watchConversation(71))
  await tick()
  source(71).send('view', view(71, 'synthetic'))
  renderToStaticMarkup(scoped(71, h(Conversation)))
  const images = [{ data: 'AAAA'.repeat(500_001), mimeType: 'image/png' }]
  const attachments = [
    { id: 'synthetic-file', name: 'notes.txt', size: 12, status: 'ready' as const },
  ]
  controller!.update(() => ({ images, attachments }))
  harness.change!({ target: { value: 'Synthetic draft stays on its origin' } })
  // Ordinary edits autosave too, without calling the Fleet navigation hook.
  expect(preservation).toHaveBeenLastCalledWith([
    expect.objectContaining({
      id: 71,
      text: 'Synthetic draft stays on its origin',
      images,
      attachments,
    }),
  ])
  preservation.mockResolvedValueOnce()
  const navigate = vi.fn<() => void>()
  await prepareInstanceNavigation().then(navigate)
  expect(navigate).toHaveBeenCalledOnce()
  expect(preservation).toHaveBeenLastCalledWith([
    expect.objectContaining({
      id: 71,
      text: 'Synthetic draft stays on its origin',
      images,
      attachments,
    }),
  ])
  navigate.mockClear()
  preservation.mockRejectedValueOnce(new Error('Could not preserve drafts. Stay on this page.'))
  await expect(prepareInstanceNavigation().then(navigate)).rejects.toThrow(
    'Could not preserve drafts',
  )
  expect(navigate).not.toHaveBeenCalled()
  renderToStaticMarkup(scoped(71, h(Conversation)))
  expect(controller!.images).toEqual(images)
  expect(controller!.attachments).toEqual(attachments)
  controller!.update(() => ({ images: [], attachments: [] }))
  harness.change!({ target: { value: '' } })
})

it('keeps this tab’s text through remount, failed send and accepted send despite another tab’s localStorage', async () => {
  effects.push(store.watchConversation(73))
  await tick()
  source(73).send('view', view(73, 'synthetic'))
  renderToStaticMarkup(scoped(73, h(Conversation)))
  commitEffects()
  fillComposer(73, 'A private draft text')
  storage.set('ultimate.draft.73', 'B shared ordinary storage text')
  renderToStaticMarkup(scoped(73, h(Conversation)))
  commitEffects()
  expect(renderToStaticMarkup(scoped(73, h(Conversation)))).toContain('A private draft text')
  fillComposer(73, 'A text before failed send')
  renderToStaticMarkup(scoped(73, h(Conversation)))
  storage.set('ultimate.draft.73', 'B shared ordinary storage text')
  harness.fetch.mockRejectedValueOnce(new Error('Synthetic admission failure'))
  harness.submit!()
  await tick()
  expect(renderToStaticMarkup(scoped(73, h(Conversation)))).toContain('A text before failed send')
  expect(preservation.mock.lastCall![0].find((draft) => draft.id === 73)?.text).toBe(
    'A text before failed send',
  )
  fillComposer(73, 'A text before accepted send')
  renderToStaticMarkup(scoped(73, h(Conversation)))
  storage.set('ultimate.draft.73', 'B shared ordinary storage text')
  harness.submit!()
  await tick()
  const cleared = renderToStaticMarkup(scoped(73, h(Conversation)))
  expect(cleared).not.toContain('A text before accepted send')
  expect(cleared).not.toContain('B shared ordinary storage text')
  expect(storage.get('ultimate.draft.73')).toBe('B shared ordinary storage text')
  expect(preservation.mock.lastCall![0].some((draft) => draft.id === 73)).toBe(false)
})

it('keeps two scoped snapshots, ops, transcripts and documents independent of the shown conversation', async () => {
  harness.sources[0].send('view', view(1, 'shown'))
  renderScopes()
  commitEffects()
  await tick()
  expect(source(7).url).toBe('/api/events?conversation=7&docs=test.counter')
  expect(source(9).url).toBe('/api/events?conversation=9&docs=test.counter')
  source(7).send('view', view(7, 'seven'))
  source(9).send('view', view(9, 'nine'))
  source(7).send('ops', [['a', ['entries', 0, 'model', 0, 'content'], ' updated']])
  source(9).send('ops', [['a', ['entries', 0, 'model', 0, 'content'], ' live']])
  source(7).send('doc', { kind: counter.kind, value: { n: 7 } })
  source(9).send('doc', { kind: counter.kind, value: { n: 9 } })
  source(7).send('docOps', { kind: counter.kind, ops: [['s', ['n'], 8]] })
  const outputs = renderScopes().split('</output>')
  expect(outputs[0]).toContain('seven updated')
  expect(outputs[0]).not.toContain('nine')
  expect(outputs[0]).toContain('&quot;doc&quot;:{&quot;n&quot;:8}')
  expect(outputs[1]).toContain('nine live')
  expect(outputs[1]).not.toContain('seven')
  expect(outputs[1]).toContain('&quot;doc&quot;:{&quot;n&quot;:9}')
  expect(outputs[2]).toContain('shown')
  expect(getConversation().id).toBe(1)

  // A nested scope must not inherit its parent's paged transcript.
  const nested = renderToStaticMarkup(
    h(TranscriptContext, { value: view(7, 'parent history').entries }, scoped(9, h(Probe))),
  )
  expect(nested).toContain('nine live')
  expect(nested).not.toContain('parent history')
  store.show(11)
  await tick()
  expect(source(7).closed).toBe(false)
  expect(source(9).closed).toBe(false)
  expect(renderScopes()).toContain('seven updated')
})

it('shares scopes, reconnects from a snapshot, ignores stale streams, and releases the last view', async () => {
  const release = store.watchConversation(7)
  const again = store.watchConversation(7)
  await tick()
  const first = source(7)
  expect(harness.sources.filter((stream) => stream.url.includes('conversation=7'))).toHaveLength(1)
  first.send('ops', [['s', ['older'], 1]])
  expect(store.getState().viewsOf[7]).toBeUndefined()
  first.send('view', view(7, 'initial'))
  first.drop(true)
  await tick()
  const reopened = source(7)
  expect(reopened).not.toBe(first)
  reopened.send('view', view(7, 'fresh'))
  first.send('view', view(7, 'stale'))
  expect(store.getState().viewsOf[7]?.entries).toEqual(view(7, 'fresh').entries)
  release()
  await tick()
  expect(reopened.closed).toBe(false)
  again()
  await tick()
  expect(reopened.closed).toBe(true)
  expect(store.getState().viewsOf[7]).toBeUndefined()
  reopened.send('view', view(7, 'late'))
  expect(store.getState().viewsOf[7]).toBeUndefined()
})

it('renders <ConversationScope><Conversation/></ConversationScope> and sends, steers, cancels and stops on its id', async () => {
  await registry.setLoaders({
    '/extensions/test/web.tsx': async () => ({
      default: {
        inbox: ({
          core,
          cancel,
        }: {
          core: ReactNode
          cancel: ReactElement<{ onClick: () => void }>
        }) => {
          harness.cancel = cancel.props.onClick
          return core
        },
      },
    }),
  })
  const release = store.watchConversation(17)
  effects.push(release)
  await tick()
  harness.sources[0].send('view', view(1, 'other transcript'))
  source(17).send('view', view(17, 'side transcript'))
  const render = () => renderToStaticMarkup(scoped(17, h(Conversation)))
  let html = render()
  expect(html).toContain('side transcript')
  expect(html).not.toContain('other transcript')
  expect(html).toContain('composer-input-17')
  expect(html).toContain('queued 17')
  harness.cancel!()
  await tick()
  expect(harness.fetch).toHaveBeenLastCalledWith(
    '/api/conversations/17/inbox/1700/cancel',
    expect.anything(),
  )
  harness.change!({ target: { value: 'hello side' } })
  render()
  harness.submit!()
  await tick()
  expect(harness.fetch).toHaveBeenLastCalledWith('/api/conversations/17/submit', expect.anything())
  expect(JSON.parse(harness.fetch.mock.lastCall![1]!.body as string)).toEqual({
    text: 'hello side',
    images: [],
    requestId: expect.any(String),
  })

  source(17).send('view', view(17, 'side transcript', true))
  html = render()
  expect(html).toContain('queued 17')
  harness.change!({ target: { value: 'steer side' } })
  render()
  harness.keyDown!({
    key: 'Enter',
    shiftKey: false,
    altKey: false,
    nativeEvent: {},
    preventDefault() {},
  })
  await tick()
  // A steer behind the queued one withdraws it and sends both as one.
  const calls = harness.fetch.mock.calls.map(([path]) => path)
  expect(calls.at(-2)).toBe('/api/conversations/17/inbox/1700/cancel')
  expect(harness.fetch).toHaveBeenLastCalledWith('/api/conversations/17/submit', expect.anything())
  expect(JSON.parse(harness.fetch.mock.lastCall![1]!.body as string)).toEqual({
    text: 'queued 17\nsteer side',
    whenBusy: 'steer',
    images: [],
    requestId: expect.any(String),
  })
  harness.change!({ target: { value: 'follow side' } })
  render()
  harness.keyDown!({
    key: 'Enter',
    shiftKey: false,
    altKey: true,
    nativeEvent: {},
    preventDefault() {},
  })
  await tick()
  expect(harness.fetch).toHaveBeenLastCalledWith('/api/conversations/17/submit', expect.anything())
  expect(JSON.parse(harness.fetch.mock.lastCall![1]!.body as string)).toEqual({
    text: 'follow side',
    whenBusy: 'followUp',
    images: [],
    requestId: expect.any(String),
  })
  render()
  harness.stop!()
  await tick()
  expect(harness.fetch).toHaveBeenLastCalledWith('/api/conversations/17/abort', expect.anything())
})

it('adds a view to a document-only stream and keeps documents after the scope releases', async () => {
  const releaseDoc = store.watchDocOf(23, counter.kind)
  effects.push(releaseDoc)
  await tick()
  const docs = source(23)
  docs.send('view', view(23, 'ignored'))
  docs.send('doc', { kind: counter.kind, value: { n: 1 } })
  expect(store.getState().viewsOf[23]).toBeUndefined()
  const releaseView = store.watchConversation(23)
  await tick()
  expect(docs.closed).toBe(true)
  const both = source(23)
  both.send('view', view(23, 'now retained'))
  both.send('doc', { kind: counter.kind, value: { n: 2 } })
  releaseView()
  await tick()
  expect(both.closed).toBe(false)
  expect(store.getState().viewsOf[23]).toBeUndefined()
  both.send('docOps', { kind: counter.kind, ops: [['s', ['n'], 3]] })
  expect(store.getState().docsOf[23]?.[counter.kind]).toEqual({ n: 3 })
})

it('keeps uploading and failed attachments in their draft, blocks send, and clears only the accepted draft', async () => {
  const controllers = new Map<number, ComposerAttachmentController>()
  const submit = vi.fn<(input: ComposerSubmission) => Promise<unknown>>()
  submit
    .mockRejectedValueOnce(new Error('Upload submission failed'))
    .mockResolvedValue({ submissionId: 1 })
  await registry.setLoaders({
    '/extensions/attachments/web.tsx': async () => ({
      default: {
        composer: ({ core }: { core: ReactNode }) =>
          h(ComposerAttachmentAdapter, { submit, children: core }),
        slots: {
          'composer.attachments': () => {
            const controller = useComposerAttachments()
            controllers.set(controller.conversationId!, controller)
            return h('output', null, controller.attachments.map((item) => item.name).join(', '))
          },
        },
      },
    }),
  })
  for (const id of [31, 33]) effects.push(store.watchConversation(id))
  await tick()
  for (const id of [31, 33])
    source(id).send('view', {
      ...view(id, 'conversation'),
      docs: { ...view(id, 'conversation').docs, 'pi.inbox': { items: [] } },
    })
  const render = (id: number) => renderToStaticMarkup(scoped(id, h(Conversation)))
  render(31)
  const first = controllers.get(31)!
  first.setAttachments(() => [{ id: 'upload', name: 'notes.txt', size: 12, status: 'uploading' }])
  render(31)
  harness.submit!()
  await tick()
  expect(submit).not.toHaveBeenCalled()
  render(33)
  const second = controllers.get(33)!
  second.setAttachments(() => [{ id: 'other', name: 'other.txt', size: 2, status: 'ready' }])
  // An upload finishing after navigation still updates the first draft, not the new editor.
  first.setAttachments((files) => files.map((file) => ({ ...file, status: 'ready' })))
  expect(render(31)).toContain('notes.txt')
  harness.submit!()
  await tick()
  expect(render(31)).toContain('Upload submission failed')
  expect(controllers.get(31)!.attachments[0].id).toBe('upload')
  const failedId = submit.mock.calls[0][0].requestId
  harness.submit!()
  await tick()
  expect(submit.mock.calls[1][0].requestId).toBe(failedId)
  render(31)
  expect(controllers.get(31)!.attachments).toEqual([])
  // An admitted send removes its unsent storage work, while the other draft remains available.
  expect(preservation.mock.lastCall![0].some((draft) => draft.id === 31)).toBe(false)
  expect(preservation.mock.lastCall![0].some((draft) => draft.id === 33)).toBe(true)
  render(33)
  expect(controllers.get(33)!.attachments[0].id).toBe('other')
})

it('replaces a failed attempt when attachments are removed without editing the text', async () => {
  let controller: ComposerAttachmentController
  const submit = vi
    .fn<(input: ComposerSubmission) => Promise<unknown>>()
    .mockRejectedValueOnce(new Error('Send failed'))
    .mockResolvedValue({ submissionId: 1 })
  await registry.setLoaders({
    '/extensions/removal/web.tsx': async () => ({
      default: {
        composer: ({ core }: { core: ReactNode }) =>
          h(ComposerAttachmentAdapter, { submit, children: core }),
        slots: {
          'composer.attachments': () => {
            controller = useComposerAttachments()
            return null
          },
        },
      },
    }),
  })
  effects.push(store.watchConversation(49))
  await tick()
  const snapshot = view(49, 'conversation')
  source(49).send('view', { ...snapshot, docs: { ...snapshot.docs, 'pi.inbox': { items: [] } } })
  const render = () => renderToStaticMarkup(scoped(49, h(Conversation)))
  render()
  controller!.setAttachments(() => [
    { id: 'removed', name: 'notes.txt', size: 12, status: 'ready' },
  ])
  controller!.setImages(() => [{ data: 'eA==', mimeType: 'image/png' }])
  harness.change!({ target: { value: 'Keep only this text' } })
  render()
  harness.submit!()
  await tick()
  render()
  controller!.setAttachments(() => [])
  controller!.setImages(() => [])
  render()
  harness.submit!()
  await tick()
  const [first, second] = submit.mock.calls.map(([input]) => input)
  expect(second.text).toBe(first.text)
  expect(second.attachments).toEqual([])
  expect(second.images).toEqual([])
  expect(second.requestId).not.toBe(first.requestId)
})

it.each([false, true])(
  'retries the exact uncertain steer without withdrawing its accepted inbox item (merged: %s)',
  async (merged) => {
    const id = merged ? 45 : 43
    let controller: ComposerAttachmentController
    const submit = vi
      .fn<(input: ComposerSubmission) => Promise<unknown>>()
      .mockRejectedValueOnce(new Error('Response lost'))
      .mockResolvedValue({ submissionId: 2 })
    await registry.setLoaders({
      '/extensions/retry/web.tsx': async () => ({
        default: {
          composer: ({ core }: { core: ReactNode }) =>
            h(ComposerAttachmentAdapter, { submit, children: core }),
          slots: {
            'composer.attachments': () => {
              controller = useComposerAttachments()
              return null
            },
          },
        },
      }),
    })
    effects.push(store.watchConversation(id))
    await tick()
    const snapshot = view(id, 'conversation', true)
    source(id).send('view', {
      ...snapshot,
      docs: {
        ...snapshot.docs,
        'pi.inbox': { items: merged ? [{ id: id * 100, mode: 'steer', content: 'prior' }] : [] },
      },
    })
    const render = () => renderToStaticMarkup(scoped(id, h(Conversation)))
    render()
    controller!.setAttachments(() => [{ id: 'file', name: 'notes.txt', size: 12, status: 'ready' }])
    harness.change!({ target: { value: 'new' } })
    render()
    harness.submit!()
    await tick()
    expect(render()).toContain('Response lost')
    const attempt = submit.mock.calls[0][0]
    expect(attempt.text).toBe(merged ? 'prior\nnew' : 'new')
    const canceled = harness.fetch.mock.calls.length
    // The SSE inbox can arrive even when the accepted action response was lost.
    source(id).send('view', {
      ...snapshot,
      docs: {
        ...snapshot.docs,
        'pi.inbox': { items: [{ id: id * 100 + 1, mode: 'steer', content: attempt.text }] },
      },
    })
    render()
    harness.submit!()
    await tick()
    expect(submit.mock.calls[1][0]).toEqual(attempt)
    expect(harness.fetch.mock.calls).toHaveLength(canceled)
    render()
    expect(controller!.attachments).toEqual([])
  },
)

it('lets a recalled six-image draft remove images down to the four-image admission limit', async () => {
  let controller: ComposerAttachmentController
  const submit = vi
    .fn<(input: ComposerSubmission) => Promise<unknown>>()
    .mockResolvedValue({ submissionId: 1 })
  await registry.setLoaders({
    '/extensions/recovery/web.tsx': async () => ({
      default: {
        composer: ({ core }: { core: ReactNode }) =>
          h(ComposerAttachmentAdapter, { submit, children: core }),
        slots: {
          'composer.attachments': () => {
            controller = useComposerAttachments()
            return null
          },
        },
      },
    }),
  })
  effects.push(store.watchConversation(47))
  await tick()
  const snapshot = view(47, 'conversation', true)
  source(47).send('view', {
    ...snapshot,
    docs: {
      ...snapshot.docs,
      'pi.inbox': {
        items: [1, 2].map((id) => ({
          id,
          mode: 'followUp',
          content: [
            { type: 'text', text: `follow ${id}` },
            ...Array.from({ length: 3 }, () => ({
              type: 'image',
              mimeType: 'image/png',
              data: 'eA==',
            })),
          ],
        })),
      },
    },
  })
  const render = () => renderToStaticMarkup(scoped(47, h(Conversation)))
  render()
  harness.keyDown!({
    key: 'ArrowUp',
    nativeEvent: {},
    currentTarget: { value: '', selectionStart: 0 },
    preventDefault() {},
  })
  await tick()
  render()
  expect(controller!.images).toHaveLength(6)
  harness.submit!()
  await tick()
  expect(submit).not.toHaveBeenCalled()
  expect(() => controller!.setImages((images) => images.slice(1))).not.toThrow()
  render()
  expect(controller!.images).toHaveLength(5)
  controller!.setImages((images) => images.slice(1))
  render()
  expect(controller!.images).toHaveLength(4)
  expect(() =>
    controller!.setImages((images) => [...images, { mimeType: 'image/png', data: 'eA==' }]),
  ).toThrow('Attach up to 4 images and files per message.')
  harness.submit!()
  await tick()
  expect(submit).toHaveBeenCalledOnce()
})

function Action() {
  useAction(actionRef<null, unknown>('test', 'scoped'))
  return null
}
it('runs useAction on the scope even before its snapshot arrives', async () => {
  renderToStaticMarkup(scoped(21, h(Action)))
  commitEffects()
  await tick()
  expect(harness.fetch).toHaveBeenCalledWith(
    '/api/extensions/test/actions/scoped',
    expect.objectContaining({ body: JSON.stringify({ args: null, conversationId: 21 }) }),
  )
})

it('shows the restore failure reason and blocks preparation without resaving an incomplete draft', async () => {
  await registry.setLoaders({})
  vi.resetModules()
  const reason = 'Draft images unavailable. Restoration stopped.'
  recovery.has.mockReturnValueOnce(true)
  recovery.restore.mockRejectedValueOnce(new Error(reason))
  preservation.mockClear()
  const isolated = await import('../../web/src/app/composer.tsx')
  renderToStaticMarkup(h(isolated.Composer))
  await tick()
  const markup = renderToStaticMarkup(h(isolated.Composer))
  expect(markup).toContain(reason)
  expect(markup).not.toContain('reload to retry')
  await expect(isolated.prepareInstanceNavigation()).rejects.toThrow(reason)
  expect(preservation).not.toHaveBeenCalled()
  expect(harness.fetch).not.toHaveBeenCalled()
})
