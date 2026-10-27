/** Private host-wide byte storage. Call only while holding the uploads host.resource lock. */
import { constants } from 'node:fs'
import { lstat, mkdir, open, readdir, rename, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { uploadIdPattern } from './format.ts'
import type { UploadedFile } from './refs.ts'

export const maxFileBytes = 5 * 1024 * 1024
export const maxTotalBytes = 250 * 1024 * 1024
export const maxStoredFiles = 1024
export const abandonmentMs = 24 * 60 * 60 * 1000
const uuid = new RegExp(`^${uploadIdPattern}$`)
export const isUploadId = (value: unknown): value is string =>
  typeof value === 'string' && uuid.test(value)
const generated = new RegExp(`^(${uploadIdPattern})\\.(bin|tmp)$`)
export class UploadError extends Error {}
const invalid = () =>
  new UploadError(
    'Upload storage is unavailable. Check the host storage permissions and integrity.',
  )
export type Pending = { requestId: string; conversationId: number; chapter: string }
type Stored = UploadedFile & {
  token: string
  hash: string
  updated: number
  retained: boolean
  pending?: Pending
}
type Index = { files: Stored[] }
export type ReceiptLookup = (pending: Pending) => Promise<boolean>
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT'
export function cleanLabel(value: string) {
  return value.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, '').slice(0, 200) || 'file'
}
export function decodeBytes(data: unknown, limit: number): Buffer {
  if (typeof data !== 'string')
    throw new UploadError('Invalid attachment encoding. Attach the file again.')
  if (data.length > Math.ceil(limit / 3) * 4)
    throw new UploadError(`Attachment exceeds ${limit / 1024 / 1024} MiB. Choose a smaller file.`)
  if (data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data))
    throw new UploadError('Invalid attachment encoding. Attach the file again.')
  const bytes = Buffer.from(data, 'base64')
  if (bytes.length > limit)
    throw new UploadError(`Attachment exceeds ${limit / 1024 / 1024} MiB. Choose a smaller file.`)
  if (bytes.toString('base64') !== data)
    throw new UploadError('Invalid attachment encoding. Attach the file again.')
  return bytes
}

export class UploadStorage {
  readonly root: string
  constructor(home: string) {
    this.root = join(home, 'uploads')
  }
  async directory() {
    const parent = await lstat(join(this.root, '..'))
    if (!parent.isDirectory() || parent.isSymbolicLink()) throw invalid()
    await mkdir(this.root, { mode: 0o700 }).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    })
    const stat = await lstat(this.root)
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o700)
      throw invalid()
  }
  path(id: string) {
    if (!isUploadId(id)) throw new Error('Invalid upload reference')
    return join(this.root, `${id}.bin`)
  }
  async regular(path: string) {
    const stat = await lstat(path)
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.nlink !== 1 ||
      (stat.mode & 0o777) !== 0o600
    )
      throw invalid()
    return stat
  }
  async read(path: string, max: number) {
    const stat = await this.regular(path)
    if (stat.size > max) throw invalid()
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const opened = await file.stat()
      if (opened.ino !== stat.ino || opened.dev !== stat.dev) throw invalid()
      return await file.readFile()
    } finally {
      await file.close()
    }
  }
  async index(): Promise<Index> {
    await this.directory()
    let data: unknown
    try {
      data = JSON.parse(
        (await this.read(join(this.root, 'index.json'), 2 * 1024 * 1024)).toString('utf8'),
      )
    } catch (error) {
      if (missing(error)) return { files: [] }
      // JSON parse errors can quote file contents; filesystem errors reach the sanitized action boundary.
      if (error instanceof SyntaxError) throw invalid()
      throw error
    }
    if (
      !data ||
      typeof data !== 'object' ||
      !('files' in data) ||
      !Array.isArray(data.files) ||
      data.files.length > maxStoredFiles
    )
      throw invalid()
    const files = data.files as Stored[]
    const ids = new Set<string>(),
      tokens = new Set<string>()
    for (const file of files) {
      if (
        !file ||
        !isUploadId(file.id) ||
        !isUploadId(file.token) ||
        ids.has(file.id) ||
        tokens.has(file.token) ||
        typeof file.name !== 'string' ||
        cleanLabel(file.name) !== file.name ||
        !Number.isSafeInteger(file.size) ||
        file.size < 0 ||
        file.size > maxFileBytes ||
        !/^[a-f0-9]{64}$/.test(file.hash) ||
        !Number.isFinite(file.updated) ||
        typeof file.retained !== 'boolean'
      )
        throw invalid()
      if (
        file.pending &&
        (!isUploadId(file.pending.requestId) ||
          !Number.isSafeInteger(file.pending.conversationId) ||
          file.pending.conversationId < 1 ||
          typeof file.pending.chapter !== 'string')
      )
        throw invalid()
      ids.add(file.id)
      tokens.add(file.token)
    }
    return { files }
  }
  async write(index: Index) {
    await this.directory()
    const path = join(this.root, 'index.json')
    try {
      await this.regular(path)
    } catch (error) {
      if (!missing(error)) throw error
    }
    const temp = join(this.root, `${randomUUID()}.tmp`)
    const file = await open(
      temp,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    )
    try {
      await file.writeFile(JSON.stringify(index))
      await file.sync()
    } finally {
      await file.close()
    }
    await rename(temp, path)
    const dir = await open(
      this.root,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    )
    try {
      await dir.sync()
    } finally {
      await dir.close()
    }
  }
  async recover(chapter: string, receipt: ReceiptLookup) {
    const index = await this.index()
    let changed = false
    for (const file of index.files) {
      if (!file.pending) continue
      if (file.pending.chapter !== chapter || (await receipt(file.pending))) file.retained = true
      delete file.pending
      // A definitely unadmitted attempt receives a fresh draft window for retries.
      file.updated = Date.now()
      changed = true
    }
    if (changed) await this.write(index)
    return index
  }
  async cleanup(chapter: string, receipt: ReceiptLookup) {
    const index = await this.recover(chapter, receipt)
    const now = Date.now()
    const keep: Stored[] = [],
      expired: Stored[] = []
    for (const file of index.files) {
      const stat = await this.regular(this.path(file.id))
      if (stat.size !== file.size) throw invalid()
      if (!file.retained && !file.pending && now - file.updated > abandonmentMs) expired.push(file)
      else keep.push(file)
    }
    // Forget metadata before unlinking: a crash leaves only a counted orphan, never a dangling index entry.
    if (expired.length) {
      index.files = keep
      await this.write(index)
      for (const file of expired) await unlink(this.path(file.id))
    }
    const known = new Set(index.files.map((file) => `${file.id}.bin`))
    let bytes = 0,
      count = 0
    for (const name of await readdir(this.root)) {
      if (name === 'index.json') {
        await this.regular(join(this.root, name))
        continue
      }
      if (!generated.test(name)) throw invalid()
      const path = join(this.root, name),
        stat = await this.regular(path)
      if (!known.has(name) && (name.endsWith('.tmp') || now - stat.mtimeMs > abandonmentMs))
        await unlink(path)
      else {
        bytes += stat.size
        count++
      }
    }
    return { index, bytes, count }
  }
  async upload(
    token: string,
    name: string,
    bytes: Buffer,
    chapter: string,
    receipt: ReceiptLookup,
  ): Promise<UploadedFile> {
    const { index, bytes: used, count } = await this.cleanup(chapter, receipt)
    // Include the exact original label in retry identity without persisting its unsanitized text.
    const label = cleanLabel(name)
    const hash = createHash('sha256').update(JSON.stringify(name)).update(bytes).digest('hex')
    const existing = index.files.find((file) => file.token === token)
    if (existing) {
      if (existing.hash !== hash || existing.name !== label || existing.size !== bytes.length)
        throw new UploadError('Upload retry changed bytes or name. Attach it again as a new file.')
      if (
        createHash('sha256')
          .update(JSON.stringify(name))
          .update(await this.read(this.path(existing.id), maxFileBytes))
          .digest('hex') !== hash
      )
        throw invalid()
      existing.updated = Date.now()
      await this.write(index)
      return { id: existing.id, name: label, size: existing.size }
    }
    if (used + bytes.length > maxTotalBytes || count >= maxStoredFiles)
      throw new UploadError(
        'Upload storage is full (250 MiB or 1,024 files). Sent files are kept; free host storage explicitly before uploading more.',
      )
    const id = randomUUID(),
      path = this.path(id)
    const file = await open(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    )
    try {
      await file.writeFile(bytes)
      await file.sync()
    } finally {
      await file.close()
    }
    index.files.push({
      id,
      name: label,
      size: bytes.length,
      token,
      hash,
      updated: Date.now(),
      retained: false,
    })
    await this.write(index)
    return { id, name: label, size: bytes.length }
  }
  async abandon(id: string, chapter: string, receipt: ReceiptLookup) {
    const { index } = await this.cleanup(chapter, receipt)
    const file = index.files.find((candidate) => candidate.id === id)
    if (!file || file.retained || file.pending) return { removed: false }
    file.updated = Date.now()
    await this.write(index)
    return { removed: true }
  }
  async pin(ids: string[], pending: Pending) {
    const index = await this.index()
    const refs = []
    for (const id of ids) {
      const file = index.files.find((candidate) => candidate.id === id)
      if (!file) throw new UploadError('Attachment is missing or expired. Attach the file again.')
      if ((await this.regular(this.path(id))).size !== file.size) throw invalid()
      if (!file.retained) file.pending = pending
      refs.push({ id, name: file.name, size: file.size, path: this.path(id) })
    }
    await this.write(index)
    return refs
  }
}
