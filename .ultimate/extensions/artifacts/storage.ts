import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, realpath, rename, rm } from 'node:fs/promises'
import { dirname, extname, join, resolve, sep } from 'node:path'
import type {
  Artifact,
  ArtifactAsset,
  ArtifactSnapshot,
  FeedbackBundle,
  FeedbackInput,
  PublishArtifact,
  ArtifactAnchor,
  TextBoundary,
} from './types.ts'

const MiB = 1024 * 1024
const assetMimes: Record<string, string> = {
  '.css': 'text/css',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
}
export const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
export function artifactId(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !/^[a-zA-Z0-9_-]{1,80}$/.test(value) ||
    ['__proto__', 'constructor', 'prototype'].includes(value)
  )
    throw new Error('Invalid artifact id')
  return value
}
function text(value: unknown, name: string, max: number) {
  if (typeof value !== 'string' || !value.trim() || value.length > max)
    throw new Error(`${name} must be non-empty text of at most ${max} characters`)
  return value
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Expected an object')
  return value as Record<string, unknown>
}
export function relativePath(value: unknown) {
  const path = text(value, 'Path', 1024)
  if (
    path.includes('\\') ||
    path.includes(':') ||
    path
      .split('')
      .some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127) ||
    path
      .split('/')
      .some(
        (part) =>
          !part ||
          part.startsWith('.') ||
          /^(?:secrets?|credentials?|id_rsa|id_ed25519)(?:[._-]|$)/i.test(part),
      )
  )
    throw new Error(
      'Paths must be relative POSIX paths without dotfiles, traversal or secret paths',
    )
  return path
}
export function publishInput(value: unknown): PublishArtifact {
  const input = object(value)
  const path = relativePath(input.path)
  if (!['.html', '.htm'].includes(extname(path).toLowerCase()))
    throw new Error('Artifact source must be HTML')
  if (input.assets !== undefined && !Array.isArray(input.assets))
    throw new Error('Expected explicit asset paths')
  const assets = ((input.assets ?? []) as unknown[])
    .map((asset) => {
      const assetPath = relativePath(asset)
      if (!assetMimes[extname(assetPath).toLowerCase()])
        throw new Error(`Unsupported asset extension: ${assetPath}`)
      return assetPath
    })
    .toSorted()
  if (new Set([path, ...assets]).size !== assets.length + 1)
    throw new Error('Duplicate source paths')
  return {
    ...(input.id === undefined ? {} : { id: artifactId(input.id) }),
    title: text(input.title, 'Title', 200),
    path,
    assets,
  }
}
function conversationId(value: unknown) {
  if (!Number.isSafeInteger(value) || (value as number) < 1)
    throw new Error('Expected a recipient conversation id')
  return value as number
}
function boundary(value: unknown): TextBoundary {
  const input = object(value)
  if (
    !Array.isArray(input.path) ||
    input.path.length > 64 ||
    !input.path.every((n) => Number.isSafeInteger(n) && n >= 0 && n <= 100000) ||
    !Number.isSafeInteger(input.offset) ||
    (input.offset as number) < 0 ||
    (input.offset as number) > 10000000
  )
    throw new Error('Invalid text boundary')
  return { path: input.path, offset: input.offset as number }
}
function anchor(value: unknown): ArtifactAnchor {
  const input = object(value)
  const selector = text(input.selector, 'Anchor selector', 2048)
  if (typeof input.text !== 'string' || input.text.length > 2000)
    throw new Error('Target excerpt must be at most 2000 characters')
  if (input.kind === 'element') return { kind: 'element', selector, text: input.text }
  if (input.kind === 'text')
    return {
      kind: 'text',
      selector,
      text: text(input.text, 'Target excerpt', 2000),
      start: boundary(input.start),
      end: boundary(input.end),
    }
  throw new Error('Invalid anchor kind')
}
function imageBytes(base64: unknown) {
  if (
    typeof base64 !== 'string' ||
    base64.length > Math.ceil((10 * MiB) / 3) * 4 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(base64)
  )
    throw new Error('Invalid image base64')
  const bytes = Buffer.from(base64, 'base64')
  if (!bytes.length || bytes.toString('base64') !== base64) throw new Error('Invalid image base64')
  return bytes
}
export function feedbackInput(value: unknown): FeedbackInput {
  const input = object(value)
  if (typeof input.contentHash !== 'string' || !/^[a-f0-9]{64}$/.test(input.contentHash))
    throw new Error('Expected original content hash')
  if (!Array.isArray(input.notes) || input.notes.length > 50)
    throw new Error('At most 50 notes are allowed')
  if (!Array.isArray(input.images) || input.images.length > 4)
    throw new Error('At most 4 images are allowed')
  let total = 0
  const notes = input.notes.map((item) => {
    const note = object(item)
    return {
      id: text(note.id, 'Note id', 128),
      text: text(note.text, 'Note', 4000),
      ...(note.anchor === undefined ? {} : { anchor: anchor(note.anchor) }),
    }
  })
  if (new Set(notes.map((note) => note.id)).size !== notes.length)
    throw new Error('Duplicate note ids')
  const images = input.images.map((item) => {
    const image = object(item)
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(image.mime as string))
      throw new Error('Unsupported reference image MIME')
    total += imageBytes(image.base64).length
    if (total > 10 * MiB) throw new Error('Reference images exceed 10 MiB')
    return {
      name: text(image.name, 'Image name', 200),
      mime: image.mime as FeedbackInput['images'][number]['mime'],
      base64: image.base64 as string,
    }
  })
  if (!notes.length && !images.length) throw new Error('Feedback needs notes or reference images')
  return {
    artifactId: artifactId(input.artifactId),
    requestId: text(input.requestId, 'Request id', 128),
    contentHash: input.contentHash,
    recipientConversation: conversationId(input.recipientConversation),
    notes,
    images,
  }
}

/** Check every descendant and the final file without following symlinks; verify identities after the read. */
async function sourceFile(root: string, path: string, limit: number) {
  const parts = path.split('/')
  const checked: { path: string; dev: number; ino: number }[] = []
  let current = root
  for (const [index, part] of parts.entries()) {
    current = join(current, part)
    const stat = await lstat(current)
    if (stat.isSymbolicLink() || (index < parts.length - 1 ? !stat.isDirectory() : !stat.isFile()))
      throw new Error('Source paths must contain only real directories and regular files')
    checked.push({ path: current, dev: stat.dev, ino: stat.ino })
  }
  const handle = await open(
    current,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  )
  try {
    const before = await handle.stat()
    const last = checked.at(-1)!
    if (
      !before.isFile() ||
      before.ino !== last.ino ||
      before.dev !== last.dev ||
      before.size > limit
    )
      throw new Error('Source changed or exceeds artifact size limit')
    // Bounded reads also protect against a file growing after stat.
    const bytes = Buffer.alloc(Math.min(before.size + 1, limit + 1))
    let length = 0
    while (length < bytes.length) {
      const read = await handle.read(bytes, length, bytes.length - length, null)
      if (!read.bytesRead) break
      length += read.bytesRead
    }
    const after = await handle.stat()
    if (
      length !== before.size ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs
    )
      throw new Error('Source changed while being read')
    for (const entry of checked) {
      const stat = await lstat(entry.path)
      if (stat.isSymbolicLink() || stat.dev !== entry.dev || stat.ino !== entry.ino)
        throw new Error('Source path changed while being read')
    }
    return { bytes: bytes.subarray(0, length), stat: after, checked }
  } finally {
    await handle.close()
  }
}

export class ArtifactStorage {
  home: string
  constructor(home: string) {
    this.home = join(home, 'artifacts')
  }
  artifactPath(id: string) {
    return join(this.home, artifactId(id))
  }
  snapshotPath(artifact: Artifact) {
    return join(this.artifactPath(artifact.id), artifact.contentHash)
  }
  feedbackPath(artifact: string, id: string) {
    if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('Invalid feedback id')
    return join(this.artifactPath(artifact), 'feedback', id)
  }
  imagePaths(bundle: Pick<FeedbackBundle, 'id' | 'artifactId'> & { images: { mime: string }[] }) {
    return bundle.images.map((image, index) =>
      join(
        this.feedbackPath(bundle.artifactId, bundle.id),
        `image-${index + 1}${image.mime === 'image/jpeg' ? '.jpg' : image.mime === 'image/webp' ? '.webp' : '.png'}`,
      ),
    )
  }
  async capture(workspace: string, input: PublishArtifact) {
    const root = await realpath(workspace)
    const htmlFile = await sourceFile(root, input.path, 2 * MiB)
    const html = htmlFile.bytes
    const files = [htmlFile]
    let total = html.length
    const assets: ArtifactAsset[] = []
    for (const path of input.assets ?? []) {
      const file = await sourceFile(root, path, 10 * MiB - total)
      files.push(file)
      const bytes = file.bytes
      total += bytes.length
      if (total > 10 * MiB) throw new Error('Artifact bundle exceeds 10 MiB')
      assets.push({
        path,
        mime: assetMimes[extname(path).toLowerCase()],
        base64: bytes.toString('base64'),
      })
    }
    for (const file of files) {
      for (const entry of file.checked) {
        const stat = await lstat(entry.path)
        if (stat.isSymbolicLink() || stat.ino !== entry.ino || stat.dev !== entry.dev)
          throw new Error('Source path changed during capture')
      }
      const stat = await lstat(file.checked.at(-1)!.path)
      if (
        stat.size !== file.stat.size ||
        stat.mtimeMs !== file.stat.mtimeMs ||
        stat.ctimeMs !== file.stat.ctimeMs
      )
        throw new Error('Source changed during capture')
    }
    const decoded = new TextDecoder('utf-8', { fatal: true }).decode(html)
    const contentHash = digest(
      JSON.stringify({ path: input.path, html: html.toString('base64'), assets }),
    )
    return { html: decoded, assets, contentHash }
  }
  async saveSnapshot(snapshot: ArtifactSnapshot) {
    const target = this.snapshotPath(snapshot.artifact)
    await this.immutableFolder(target, async (folder) => {
      await this.put(folder, snapshot.artifact.source.path, snapshot.html)
      for (const asset of snapshot.assets)
        await this.put(folder, asset.path, Buffer.from(asset.base64, 'base64'))
    })
    const saved = await this.readSnapshot(snapshot.artifact)
    if (
      saved.html !== snapshot.html ||
      JSON.stringify(saved.assets) !== JSON.stringify(snapshot.assets)
    )
      throw new Error('Retained snapshot integrity conflict')
  }
  async readSnapshot(artifact: Artifact): Promise<ArtifactSnapshot> {
    const folder = this.snapshotPath(artifact)
    await this.directory(folder)
    return {
      artifact,
      html: (await sourceFile(folder, artifact.source.path, 2 * MiB)).bytes.toString('utf8'),
      assets: await Promise.all(
        artifact.source.assets.map(async (path) => ({
          path,
          mime: assetMimes[extname(path).toLowerCase()],
          base64: (await sourceFile(folder, path, 10 * MiB)).bytes.toString('base64'),
        })),
      ),
    }
  }
  async saveFeedback(bundle: FeedbackBundle) {
    const paths = this.imagePaths(bundle)
    const target = this.feedbackPath(bundle.artifactId, bundle.id)
    await this.immutableFolder(target, async (folder) => {
      await this.writeSynced(join(folder, 'bundle.json'), JSON.stringify(bundle, null, 2))
      for (const [index, image] of bundle.images.entries())
        await this.writeSynced(
          join(folder, paths[index].split(sep).at(-1)!),
          Buffer.from(image.base64, 'base64'),
        )
    })
    const saved = await this.readFeedback(bundle.artifactId, bundle.id)
    if (
      digest(JSON.stringify(feedbackInput(saved))) !== digest(JSON.stringify(feedbackInput(bundle)))
    )
      throw new Error('Feedback requestId conflicts with a different retained payload')
    return saved
  }
  async readFeedback(artifact: string, id: string): Promise<FeedbackBundle> {
    const target = this.feedbackPath(artifact, id)
    await this.directory(target)
    const saved = JSON.parse(
      (await sourceFile(target, 'bundle.json', 15 * MiB)).bytes.toString('utf8'),
    ) as FeedbackBundle
    feedbackInput(saved)
    if (saved.id !== id || saved.artifactId !== artifact)
      throw new Error('Retained feedback identity conflict')
    for (const [index, path] of this.imagePaths(saved).entries()) {
      if (
        !(await sourceFile(target, path.split(sep).at(-1)!, 10 * MiB)).bytes.equals(
          Buffer.from(saved.images[index].base64, 'base64'),
        )
      )
        throw new Error('Retained feedback image integrity conflict')
    }
    return saved
  }
  private async put(folder: string, path: string, bytes: string | Buffer) {
    const target = resolve(folder, relativePath(path))
    if (!target.startsWith(folder + sep)) throw new Error('Invalid retained path')
    await mkdir(dirname(target), { recursive: true, mode: 0o700 })
    await this.writeSynced(target, bytes)
  }
  private async writeSynced(path: string, bytes: string | Buffer) {
    const file = await open(path, 'wx', 0o600)
    try {
      await file.writeFile(bytes)
      await file.sync()
    } finally {
      await file.close()
    }
  }
  private async immutableFolder(target: string, write: (folder: string) => Promise<void>) {
    await mkdir(dirname(target), { recursive: true, mode: 0o700 })
    const existing = await lstat(target).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined
      throw error
    })
    if (existing) {
      await this.directory(target)
      return
    }
    const folder = `${target}.tmp-${randomUUID()}`
    await mkdir(folder, { mode: 0o700 })
    try {
      await write(folder)
      await rename(folder, target)
    } finally {
      await rm(folder, { recursive: true, force: true })
    }
  }
  private async directory(path: string) {
    const stat = await lstat(path)
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error('Retained storage must be a real directory')
  }
  async prune(artifact: Artifact) {
    await rm(this.snapshotPath(artifact), { recursive: true, force: true })
  }
}
