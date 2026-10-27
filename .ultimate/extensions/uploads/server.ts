/** User-only, sealed byte transfer and admission through the host's existing submit path. */
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { defineExtension } from '@earendil-works/pi-durable'
import type { ConversationId } from '@earendil-works/pi-durable'
import type { ExtensionHost } from '../../../server/extensions.ts'
import type { SubmitRequest } from '../../../shared/protocol.ts'
import { implementAction } from '../../../lib/actions.ts'
import { UploadAction, RemoveAction, SendAction } from './refs.ts'
import { composeFileReferences, fileReferenceIds } from './format.ts'
import { UploadStorage, UploadError, decodeBytes, isUploadId, maxFileBytes } from './storage.ts'
import type { Pending } from './storage.ts'

export const userActions = ['upload', 'remove', 'send']
export const sealedActions = ['upload', 'remove', 'send']
const submissionReceipt = (host: ExtensionHost, pending: Pending) =>
  host
    .harness()
    .commit(
      (tx) =>
        tx.submissionByRequest(
          pending.conversationId as ConversationId,
          `uploads:${pending.requestId}`,
        ),
      BACKGROUND_CONTEXT,
    )
const receiptLookup = (host: ExtensionHost) => async (pending: Pending) =>
  !!(await submissionReceipt(host, pending))

function uploadQueue(host: ExtensionHost) {
  return host.resource('uploads.lock', () => {
    const queue = { tail: Promise.resolve(), stopped: false }
    host.onRelease(async () => {
      queue.stopped = true
      await queue.tail
    })
    host.onOpen(async () => {
      queue.stopped = false
    })
    return queue
  })
}

function locked<T>(host: ExtensionHost, work: (storage: UploadStorage) => Promise<T>): Promise<T> {
  const queue = uploadQueue(host)
  if (queue.stopped)
    return Promise.reject(
      new UploadError('Uploads are paused while the host restarts. Retry shortly.'),
    )
  const operation = queue.tail.then(() => work(new UploadStorage(host.home)))
  queue.tail = operation.then(
    () => {},
    () => {
      // The caller receives the sanitized failure; subsequent actions must still be able to retry.
    },
  )
  return operation
}

// Preserve controlled user-facing errors; unexpected errors must not leak paths, labels or bytes into logs.
function safeError(host: ExtensionHost, error: unknown) {
  if (error instanceof UploadError) return error
  const code = (error as NodeJS.ErrnoException | null)?.code
  host.notice(
    `Upload operation failed (code: ${typeof code === 'string' && /^[A-Z0-9_]{1,40}$/.test(code) ? code : 'UNKNOWN'})`,
  )
  return new Error('Upload storage is unavailable. Retry or check the host storage.')
}

export const actions = {
  upload: implementAction(UploadAction, async (args, { host }) => {
    if (
      !args ||
      typeof args !== 'object' ||
      Array.isArray(args) ||
      !isUploadId(args.token) ||
      typeof args.name !== 'string' ||
      args.name.length > 4096
    )
      throw new Error('Invalid upload request')
    const token = args.token,
      name = args.name,
      bytes = decodeBytes(args.data, maxFileBytes)
    return locked(host, async (storage) => {
      try {
        return await storage.upload(token, name, bytes, host.chapter.name, receiptLookup(host))
      } catch (error) {
        throw safeError(host, error)
      }
    })
  }),
  remove: implementAction(RemoveAction, async (args, { host }) => {
    if (!args || typeof args !== 'object' || Array.isArray(args) || !isUploadId(args.id))
      throw new Error('Invalid upload reference')
    const id = args.id
    return locked(host, async (storage) => {
      try {
        return await storage.abandon(id, host.chapter.name, receiptLookup(host))
      } catch (error) {
        throw safeError(host, error)
      }
    })
  }),
  send: implementAction(SendAction, async (args, { host, conversationId, device }) => {
    if (
      !conversationId ||
      !args ||
      typeof args !== 'object' ||
      Array.isArray(args) ||
      typeof args.text !== 'string' ||
      !isUploadId(args.requestId) ||
      !Array.isArray(args.files) ||
      !args.files.every(isUploadId) ||
      (args.whenBusy !== undefined && args.whenBusy !== 'steer' && args.whenBusy !== 'followUp') ||
      (args.images !== undefined && !Array.isArray(args.images))
    )
      throw new Error('Invalid upload send request')
    const ids = [...new Set([...args.files, ...fileReferenceIds(args.text)])]
    const images = args.images as SubmitRequest['images']
    if (ids.length + (images?.length ?? 0) > 4)
      throw new Error('At most four attachments are allowed')
    let imageBytes = 0
    for (const image of images ?? []) {
      if (!image || typeof image !== 'object') throw new Error('Invalid image attachment')
      imageBytes += decodeBytes(image.data, 2 * 1024 * 1024).length
    }
    const text = args.text,
      requestId = args.requestId,
      whenBusy = args.whenBusy
    return locked(host, async (storage) => {
      try {
        await storage.cleanup(host.chapter.name, receiptLookup(host))
        // Pin only after validation; unlike beforeInput, host.submit is the queue admission boundary.
        const index = await storage.index()
        const total = ids.reduce((sum, id) => {
          const file = index.files.find((candidate) => candidate.id === id)
          if (!file)
            throw new UploadError('Attachment is missing or expired. Attach the file again.')
          return sum + file.size
        }, imageBytes)
        if (total > 10 * 1024 * 1024)
          throw new UploadError(
            'Attachments exceed 10 MiB combined. Remove an attachment or choose smaller files.',
          )
        const pending = { requestId, conversationId, chapter: host.chapter.name }
        const refs = await storage.pin(ids, pending)
        try {
          return await host.submit(
            conversationId,
            {
              text: composeFileReferences(text, refs),
              images,
              whenBusy,
              requestId: `uploads:${requestId}`,
            },
            { context: BACKGROUND_CONTEXT, device },
          )
        } catch (error) {
          // Admission may have committed before the host's event helper failed. Return that accepted receipt.
          const receipt =
            host.chapter.name === pending.chapter && (await submissionReceipt(host, pending))
          if (receipt) return { submissionId: receipt.id }
          throw error
        } finally {
          try {
            await storage.recover(host.chapter.name, receiptLookup(host))
          } catch {
            // The on-disk pending marker still pins bytes; retry recovery at the next action/open, not admission.
            host.notice('Upload retention update failed; pending references remain protected')
          }
        }
      } catch (error) {
        throw safeError(host, error)
      }
    })
  }),
}

export default (host: ExtensionHost) => {
  // Process-scoped hooks precede facet cleanup and survive replacement while an old action is still running.
  uploadQueue(host)
  host.onOpen(async () => {
    try {
      await locked(host, (storage) => storage.cleanup(host.chapter.name, receiptLookup(host)))
    } catch (error) {
      host.notice(safeError(host, error).message)
    }
  })
  return defineExtension({ name: 'uploads' })
}
