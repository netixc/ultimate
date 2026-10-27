import { createElement } from 'react'
import type { ComponentType, ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, expect, it, vi } from 'vitest'
import type {
  ComposerAttachment,
  ComposerImage,
  ComposerSubmission,
} from '../../web/src/sdk/composer-attachments.tsx'

const harness = vi.hoisted(() => ({
  action: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  draft: {
    conversationId: 7,
    images: [] as ComposerImage[],
    attachments: [] as ComposerAttachment[],
    disabled: false,
  },
  submit: undefined as
    | undefined
    | ((input: ComposerSubmission, fallback: () => Promise<unknown>) => Promise<unknown>),
  user: undefined as undefined | { text: string; actionText: string },
}))
vi.mock('@/sdk', () => ({
  api: { action: harness.action },
  cn: (...names: unknown[]) => names.filter(Boolean).join(' '),
  defineWebExtension: (facet: unknown) => facet,
  errorMessage: (failure: unknown) =>
    failure instanceof Error ? failure.message : String(failure),
  formatBytes: (bytes: number) => `${bytes} B`,
  useComposerAttachments: () => harness.draft,
  ComposerAttachmentAdapter: ({
    submit,
    children,
  }: {
    submit: typeof harness.submit
    children: ReactNode
  }) => {
    harness.submit = submit
    return children
  },
  UserView: ({
    text,
    actionText,
    children,
  }: {
    text: string
    actionText: string
    children: ReactNode
  }) => {
    harness.user = { text, actionText }
    return createElement('div', null, text, children)
  },
}))
vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: ReactNode }) => children,
  TooltipTrigger: ({ children }: { children: ReactNode }) => children,
  TooltipContent: () => null,
}))

import { chooseFiles } from '../../.ultimate/extensions/uploads/client.tsx'
import { composeFileReferences } from '../../.ultimate/extensions/uploads/format.ts'
import facet from '../../.ultimate/extensions/uploads/web.tsx'

beforeEach(() => {
  harness.action.mockReset()
  harness.draft.images = []
  harness.draft.attachments = []
  harness.user = undefined
})

it('reserves a mixed native-picker selection before reading, then shows images and durable file chips', async () => {
  let current = { images: [] as ComposerImage[], attachments: [] as ComposerAttachment[] }
  const error = vi.fn<(message: string | undefined) => void>()
  const id = '34cac816-a6e7-41ad-8718-7416d5af064c'
  harness.action.mockResolvedValue({ id, name: 'notes.txt', size: 5 })
  const image = new File([new Uint8Array([137, 80, 78, 71])], 'photo.png', { type: 'image/png' })
  const file = new File(['hello'], 'notes.txt', { type: 'text/plain' })
  const done = chooseFiles(
    {
      conversationId: 7,
      update: (change) => {
        current = change(current)
      },
      setError: error,
    },
    [image, file],
  )
  expect(current.attachments.map((item) => item.status)).toEqual(['uploading', 'uploading'])
  expect(harness.action).not.toHaveBeenCalled()
  await done
  expect(current.images).toEqual([{ data: 'iVBORw==', mimeType: 'image/png' }])
  expect(current.attachments).toEqual([{ id, name: 'notes.txt', size: 5, status: 'ready' }])
  expect(harness.action).toHaveBeenCalledWith(
    expect.objectContaining({ extension: 'uploads', name: 'upload' }),
    { token: expect.any(String), name: 'notes.txt', data: 'aGVsbG8=' },
    { conversationId: 7 },
  )
  expect(error).toHaveBeenLastCalledWith(undefined)

  harness.draft.attachments = current.attachments
  const slots = facet.slots as { 'composer.attachments': ComponentType[] }
  const html = renderToStaticMarkup(createElement(slots['composer.attachments'][0]))
  expect(html).toContain('notes.txt')
  expect(html).toContain('5 B')
  expect(html).toContain('Remove notes.txt')
  expect(html).toContain('data-upload="ready"')
})

it('uses the upload send action for file references, but leaves ordinary submissions to the composer', async () => {
  renderToStaticMarkup(createElement(facet.composer!, { core: null }))
  const fallback = vi.fn<() => Promise<{ submissionId: number }>>(async () => ({ submissionId: 4 }))
  const input: ComposerSubmission = {
    text: 'hello',
    images: [],
    attachments: [],
    conversationId: 7,
    requestId: 'request-1',
  }
  await harness.submit!(input, fallback)
  expect(fallback).toHaveBeenCalledOnce()
  const reference = '[[ultimate-upload:34cac816-a6e7-41ad-8718-7416d5af064c]]'
  await harness.submit!({ ...input, text: reference }, fallback)
  expect(harness.action).toHaveBeenCalledWith(
    expect.objectContaining({ extension: 'uploads', name: 'send' }),
    { text: reference, images: [], files: [], requestId: 'request-1', whenBusy: undefined },
    { conversationId: 7 },
  )
  await expect(
    harness.submit!(
      {
        ...input,
        attachments: [{ id: 'pending', name: 'notes.txt', size: 5, status: 'uploading' }],
      },
      fallback,
    ),
  ).rejects.toThrow('Wait for uploads to finish')
})

it('shows sent file names without transport paths, retaining full references for copy and recall', () => {
  const text = composeFileReferences('Read these notes', [
    {
      id: '34cac816-a6e7-41ad-8718-7416d5af064c',
      name: 'notes.txt',
      size: 5,
      path: '/host/uploads/notes.txt',
    },
  ])
  const Renderer = facet.entries!['pi.user'] as ComponentType<{ entry: unknown; core: ReactNode }>
  const html = renderToStaticMarkup(
    createElement(Renderer, {
      entry: { model: [{ role: 'user', content: text }] },
      core: 'fallback',
    }),
  )
  expect(html).toContain('notes.txt')
  expect(html).not.toContain('/host/uploads')
  expect(html).not.toContain('ultimate-upload:')
  expect(harness.user).toEqual({ text: 'Read these notes', actionText: text })
})
