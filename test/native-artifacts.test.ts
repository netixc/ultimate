import { crc32 } from 'node:zlib'
import { expect, it } from 'vitest'
import { parse } from 'parse5'
import type { DefaultTreeAdapterMap } from 'parse5'
import { buildDocument } from '../.ultimate/extensions/native-artifacts/sandbox.ts'
import {
  decodeAnchor,
  decodeFrameMessage,
} from '../.ultimate/extensions/native-artifacts/bridge.ts'
import type { ArtifactSnapshot } from '../.ultimate/extensions/artifacts/types.ts'
import { actions } from '../.ultimate/extensions/native-artifacts/server.ts'
import type { ActionContext } from '../server/actions.ts'

function nativeSnapshot(html: string): ArtifactSnapshot {
  return {
    artifact: {
      id: 'native-demo',
      title: 'Static artifact',
      ownerConversation: 1,
      recipientConversation: 1,
      source: {
        workspace: '/workspace',
        path: 'pages/index.html',
        assets: ['pages/site.css', 'pages/pixel.png'],
      },
      contentHash: 'snapshot-hash',
      updatedAt: 1,
    },
    html,
    assets: [
      {
        path: 'pages/pixel.png',
        mime: 'image/png',
        base64:
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9XcAAAAASUVORK5CYII=',
      },
      {
        path: 'pages/site.css',
        mime: 'text/css',
        base64: Buffer.from('p { background-image: url(./pixel.png); color: red }').toString(
          'base64',
        ),
      },
    ],
  }
}

it('regenerates static HTML with only retained assets, first-head CSP and one private nonce bridge', () => {
  const snapshot = nativeSnapshot(
    `<!doctype html><html lang="en"><head><link rel="stylesheet" href="site.css"><style>body{background:image-set("data:image/svg+xml,authored" 1x)}</style></head><body><h1>Review me</h1><img src="pixel.png"><img src="not-retained.png"><script nonce="authored">window.authored = true</script></body></html>`,
  )
  const first = buildDocument(snapshot, 'https://review.example')
  const second = buildDocument(snapshot, 'https://review.example')
  expect(first.channel).not.toBe(second.channel)
  expect(first.srcdoc).not.toBe(second.srcdoc)
  const tree = parse(first.srcdoc)
  const elements: DefaultTreeAdapterMap['element'][] = []
  const visit = (node: DefaultTreeAdapterMap['node']) => {
    if ('tagName' in node) elements.push(node)
    if ('childNodes' in node) node.childNodes.forEach(visit)
  }
  visit(tree)
  const head = elements.find((n) => n.tagName === 'head')!
  expect(head.childNodes[0]).toMatchObject({
    tagName: 'meta',
    attrs: [
      { name: 'http-equiv', value: 'Content-Security-Policy' },
      { name: 'content', value: expect.stringContaining("default-src 'none'") },
    ],
  })
  const scripts = elements.filter((n) => n.tagName === 'script')
  expect(scripts).toHaveLength(1)
  expect(scripts[0].attrs).toEqual([
    { name: 'nonce', value: expect.not.stringMatching('authored') },
  ])
  expect(first.srcdoc).toContain(
    "connect-src 'none'; form-action 'none'; base-uri 'none'; object-src 'none'; frame-src 'none'",
  )
  expect(first.srcdoc).toContain('data:image/png;base64,')
  expect(first.srcdoc).toContain('background-image: url("data:image/png;base64,')
  expect(first.srcdoc).not.toContain('not-retained.png')
  expect(first.srcdoc).not.toContain('data:image/svg+xml,authored')
  expect(first.srcdoc).not.toContain('window.authored')
  expect(first.srcdoc).toContain('<h1>Review me</h1>')
})

it('retains a valid 6 MiB PNG accepted by the publisher', () => {
  const snapshot = nativeSnapshot('<img src="pixel.png">')
  const png = Buffer.from(snapshot.assets[0].base64, 'base64')
  const text = Buffer.alloc(6 * 1024 * 1024 - png.length - 12, 'a')
  text.write('padding\0')
  const header = Buffer.alloc(8)
  header.writeUInt32BE(text.length)
  header.write('tEXt', 4)
  const checksum = Buffer.alloc(4)
  checksum.writeUInt32BE(crc32(Buffer.concat([header.subarray(4), text])))
  const bytes = Buffer.concat([png.subarray(0, -12), header, text, checksum, png.subarray(-12)])
  expect(bytes.length).toBe(6 * 1024 * 1024)
  snapshot.artifact.source.assets = ['pages/pixel.png']
  snapshot.assets = [
    { path: 'pages/pixel.png', mime: 'image/png', base64: bytes.toString('base64') },
  ]
  const document = buildDocument(snapshot, 'https://review.example')
  expect(document.srcdoc).toContain(`src="data:image/png;base64,${snapshot.assets[0].base64}"`)
})

it('refreshes unchanged content without retransferring HTML, assets or the annotation channel', async () => {
  const snapshot = nativeSnapshot('<p>Current content</p>')
  snapshot.artifact.contentHash = 'a'.repeat(64)
  const context = {
    host: { need: () => ({ read: async () => snapshot }) },
  } as unknown as ActionContext
  const full = await actions.read(
    { id: 'native-demo', parentOrigin: 'https://review.example' },
    context,
  )
  expect(full).toHaveProperty('srcdoc', expect.stringContaining('Current content'))
  expect(full).toHaveProperty('channel')
  const unchanged = await actions.read(
    {
      id: 'native-demo',
      parentOrigin: 'https://review.example',
      knownHash: snapshot.artifact.contentHash,
    },
    context,
  )
  expect(unchanged).toEqual({
    unchanged: true,
    artifact: snapshot.artifact,
    sourceError: undefined,
  })
  expect(unchanged).not.toHaveProperty('srcdoc')
  expect(unchanged).not.toHaveProperty('channel')
})

it('decodes only bounded anchor, status and interaction payloads', () => {
  const anchor = {
    kind: 'text',
    selector: 'p',
    text: 'quote',
    start: { path: [0], offset: 0 },
    end: { path: [0], offset: 5 },
  }
  expect(
    decodeFrameMessage({ channel: 'test', type: 'interaction', active: true }, 'test'),
  ).toEqual({ type: 'interaction', active: true })
  expect(
    decodeFrameMessage({ channel: 'test', type: 'interaction', active: 'true' }, 'test'),
  ).toBeUndefined()
  expect(decodeAnchor(anchor)).toEqual(anchor)
  expect(decodeAnchor({ ...anchor, text: 'x'.repeat(2001) })).toBeUndefined()
  expect(decodeAnchor({ ...anchor, text: ' \n\t ' })).toBeUndefined()
  expect(decodeAnchor({ ...anchor, text: ' quote ' })?.text).toBe(' quote ')
  expect(decodeAnchor({ ...anchor, start: { path: [-1], offset: 0 } })).toBeUndefined()
  expect(decodeFrameMessage({ channel: 'other', type: 'target', anchor }, 'test')).toBeUndefined()
  expect(
    decodeFrameMessage(
      { channel: 'test', type: 'statuses', statuses: ['same', 'changed', 'missing'] },
      'test',
    ),
  ).toEqual({ type: 'statuses', statuses: ['same', 'changed', 'missing'] })
  expect(
    decodeFrameMessage({ channel: 'test', type: 'statuses', statuses: ['maybe'] }, 'test'),
  ).toBeUndefined()
})
