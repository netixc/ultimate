import type { ComposerAttachmentState, ComposerImage } from '../sdk/composer-attachments.tsx'

export type NavigationDraft = ComposerAttachmentState & {
  id: number | string
  text: string
  requestId: string
}

type DraftHeader = Omit<NavigationDraft, 'images'> & { imageIds: string[] }
type Pointer = { token: string; drafts: DraftHeader[] }
type Header = { token: string; drafts: (DraftHeader & { imageToken?: string })[] }
type SavedImages = { token: string; images: ComposerImage[]; ids: string[] }
type Restored = { drafts: NavigationDraft[]; images: Map<NavigationDraft['id'], SavedImages> }
const database = 'ultimate.navigation-drafts'
const pointer = 'ultimate.navigation-drafts'
let source: Pointer | undefined
let owner: string | undefined
let leased: string | undefined
let ownership: Promise<void> | undefined
let desired: DraftHeader[] = []
let pointerSafe = true
let writes = Promise.resolve()
let savedImages = new Map<NavigationDraft['id'], SavedImages>()
const imageIds = new WeakMap<ComposerImage, string>()

function warnBeforeUnload(event: BeforeUnloadEvent) {
  event.preventDefault()
  event.returnValue = ''
}

function updateUnloadWarning() {
  const unsafe =
    desired.length > 0 &&
    (!pointerSafe ||
      desired.some((draft) =>
        draft.imageIds.some((id) => !savedImages.get(draft.id)?.ids.includes(id)),
      ))
  if (unsafe) window.addEventListener('beforeunload', warnBeforeUnload)
  else window.removeEventListener('beforeunload', warnBeforeUnload)
}

function publishPointer() {
  pointerSafe = false
  if (desired.length)
    sessionStorage.setItem(
      pointer,
      JSON.stringify({ token: owner ?? source!.token, drafts: desired } satisfies Pointer),
    )
  else sessionStorage.removeItem(pointer)
  pointerSafe = true
  updateUnloadWarning()
}

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    let blocked = false
    const request = indexedDB.open(database, 1)
    request.addEventListener('upgradeneeded', () =>
      request.result.createObjectStore('backups', { keyPath: 'token' }),
    )
    request.addEventListener('success', () => {
      if (blocked) request.result.close()
      else resolve(request.result)
    })
    request.addEventListener('error', () => reject(request.error))
    request.addEventListener('blocked', () => {
      blocked = true
      reject(new Error('Draft storage is blocked by another page.'))
    })
  })
}

async function transaction(
  run: (store: IDBObjectStore, fail: (failure: Error) => void) => void,
): Promise<void> {
  const db = await open()
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('backups', 'readwrite', { durability: 'strict' })
      tx.addEventListener('complete', () => resolve())
      tx.addEventListener('abort', () =>
        reject(tx.error ?? new Error('Draft storage transaction was aborted.')),
      )
      tx.addEventListener('error', () => reject(tx.error))
      try {
        run(tx.objectStore('backups'), (failure) => {
          tx.abort()
          reject(failure)
        })
      } catch (failure) {
        tx.abort()
        reject(failure)
      }
    })
  } finally {
    db.close()
  }
}

function storedPointer(): Pointer | undefined {
  const value = sessionStorage.getItem(pointer)
  return value ? (JSON.parse(value) as Pointer) : undefined
}

export function hasNavigationDrafts(): boolean {
  // Non-browser renderers have no session storage and no navigation to restore.
  if (typeof sessionStorage === 'undefined') return false
  try {
    return sessionStorage.getItem(pointer) !== null
  } catch {
    // Restoration must fail closed when browser storage is inaccessible, rather than enable an empty send.
    return true
  }
}

/** Hold a document-lifetime lease. The browser releases it on reload; copied sessionStorage does not copy it. */
function lease(token: string): Promise<boolean> {
  if (!navigator.locks)
    return Promise.reject(new Error('Draft storage requires the browser Web Locks API.'))
  return new Promise((resolve, reject) => {
    void navigator.locks
      .request(`ultimate.drafts.${token}`, { ifAvailable: true }, (lock) => {
        if (!lock) {
          resolve(false)
          return Promise.resolve()
        }
        resolve(true)
        return new Promise<void>(() => {
          // Keep ownership until this document is destroyed, not until an individual storage operation finishes.
        })
      })
      .catch(reject)
  })
}

/** Read the last committed image payloads and apply this tab's latest small header, including partial removals. */
async function readJournal(from: Pointer, token: string): Promise<Restored> {
  const result: Restored = { drafts: [], images: new Map() }
  await transaction((store, fail) => {
    const request = store.get(from.token)
    request.addEventListener('success', () => {
      const header = request.result as Header | undefined
      const copied: Header['drafts'] = []
      let remaining = from.drafts.length
      const finish = () => {
        if (!remaining && token !== from.token)
          store.put({ token, drafts: copied } satisfies Header)
      }
      const loaded = (draft: DraftHeader, saved?: SavedImages) => {
        if (draft.imageIds.some((id) => !saved?.ids.includes(id))) {
          fail(new Error('Draft images unavailable. Restoration stopped.'))
          return false
        }
        if (saved) saved.images.forEach((image, index) => imageIds.set(image, saved.ids[index]))
        const images =
          saved &&
          draft.imageIds.length === saved.ids.length &&
          draft.imageIds.every((id, index) => id === saved.ids[index])
            ? saved.images
            : draft.imageIds.map((id) => saved!.images[saved!.ids.indexOf(id)])
        const { imageIds: _ids, ...fields } = draft
        result.drafts.push({ ...fields, images })
        if (token !== from.token) {
          if (images.length) {
            const privateImages = {
              token: `${token}:${JSON.stringify(draft.id)}`,
              images,
              ids: images.map((image) => imageIds.get(image)!),
            }
            store.put(privateImages)
            result.images.set(draft.id, privateImages)
            copied.push({ ...draft, imageToken: privateImages.token })
          } else copied.push(draft)
        } else if (saved) result.images.set(draft.id, saved)
        remaining--
        return true
      }
      for (const draft of from.drafts) {
        const imageToken = header?.drafts.find((saved) => saved.id === draft.id)?.imageToken
        if (!imageToken) {
          if (!loaded(draft)) return
          continue
        }
        const imageRequest = store.get(imageToken)
        imageRequest.addEventListener('success', () => {
          if (loaded(draft, imageRequest.result as SavedImages | undefined)) finish()
        })
      }
      finish()
    })
  })
  return result
}

function ownJournal(restore?: (drafts: NavigationDraft[]) => void): Promise<void> {
  ownership ??= (async () => {
    if (!leased) {
      let token = source!.token
      if (!(await lease(token))) {
        token = crypto.randomUUID()
        if (!(await lease(token)))
          throw new Error('Could not acquire private draft storage ownership.')
      }
      leased = token
    }
    // A duplicate gets private image bytes before it can write or delete anything; the original stays untouched.
    const restored =
      owner && !restore
        ? undefined
        : await readJournal(owner ? { token: owner, drafts: desired } : source!, leased)
    if (restored) {
      owner = leased
      savedImages = restored.images
    }
    publishPointer()
    if (restored) restore?.(restored.drafts)
  })().catch((failure: unknown) => {
    ownership = undefined
    throw failure
  })
  return ownership
}

/**
 * Small headers are tab-local and synchronous, so failed IDB writes cannot undo text or partial clears. Image bytes
 * stay in IDB and unchanged arrays are not cloned on typing. Await this promise before instance navigation.
 */
export function saveNavigationDrafts(drafts: NavigationDraft[]): Promise<void> {
  desired = drafts.map(({ images, ...draft }) => ({
    ...draft,
    imageIds: images.map((image) => {
      if (!imageIds.has(image)) imageIds.set(image, crypto.randomUUID())
      return imageIds.get(image)!
    }),
  }))
  const headers = desired
  try {
    source ??= storedPointer() ?? { token: crypto.randomUUID(), drafts: [] }
    publishPointer()
  } catch (failure) {
    pointerSafe = false
    updateUnloadWarning()
    return Promise.reject(
      new Error('Could not preserve drafts. Stay on this page and try again.', { cause: failure }),
    )
  }
  const saving = writes
    .catch(() => {
      // A complete newer snapshot can retry a failed write; the last committed payloads remain recoverable meanwhile.
    })
    .then(async () => {
      await ownJournal()
      const images = new Map<NavigationDraft['id'], SavedImages>()
      await transaction((store) => {
        const stored: Header['drafts'] = drafts.map((draft, index) => {
          if (!draft.images.length) return headers[index]
          let saved = savedImages.get(draft.id)
          if (!saved || saved.images !== draft.images) {
            saved = {
              token: `${owner!}:${JSON.stringify(draft.id)}`,
              images: draft.images,
              ids: headers[index].imageIds,
            }
            store.put(saved)
          }
          images.set(draft.id, saved)
          return { ...headers[index], imageToken: saved.token }
        })
        for (const [id, saved] of savedImages) if (!images.has(id)) store.delete(saved.token)
        if (stored.length) store.put({ token: owner!, drafts: stored } satisfies Header)
        else store.delete(owner!)
      })
      savedImages = images
      updateUnloadWarning()
    })
    .catch((failure: unknown) => {
      updateUnloadWarning()
      throw new Error('Could not preserve drafts. Stay on this page and try again.', {
        cause: failure,
      })
    })
  writes = saving
  return saving
}

/** Restore this tab, never another tab's global localStorage text. A missing/older IDB header is recoverable. */
export async function restoreNavigationDrafts(
  restore: (drafts: NavigationDraft[]) => void,
): Promise<void> {
  source ??= storedPointer()
  if (!source) return
  desired = source.drafts
  const first = !ownership
  await ownJournal(first ? restore : undefined)
  if (!first) {
    const restored = await readJournal({ token: owner!, drafts: desired }, owner!)
    savedImages = restored.images
    restore(restored.drafts)
  }
  updateUnloadWarning()
}
