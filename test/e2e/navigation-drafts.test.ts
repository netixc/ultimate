import { readFile } from 'node:fs/promises'
import { stripTypeScriptTypes } from 'node:module'
import { chromium } from 'playwright-core'
import type { Page } from 'playwright-core'
import { expect, it } from 'vitest'
import { browserBinary } from '../../extensions/browser/server.ts'
import type * as Persistence from '../../web/src/app/navigation-drafts.ts'

declare global {
  interface Window {
    navigationDrafts: typeof Persistence
    syntheticDrafts: Persistence.NavigationDraft[]
    syntheticImage?: WeakRef<Persistence.NavigationDraft['images'][number]>
  }
}

async function withPage(
  run: (page: Page, install: (target?: Page) => Promise<void>) => Promise<void>,
) {
  const browser = await chromium.launch({ executablePath: await browserBinary(), headless: true })
  try {
    const context = await browser.newContext()
    const page = await context.newPage()
    // Synthetic origins only. No listening server, live host storage or network requests.
    await context.route('**/*', (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: '<!doctype html><title>Draft storage test</title>',
      }),
    )
    const source = stripTypeScriptTypes(
      await readFile(new URL('../../web/src/app/navigation-drafts.ts', import.meta.url), 'utf8'),
    )
    const install = async (target = page) => {
      await target.addScriptTag({
        type: 'module',
        content: `${source}\nwindow.navigationDrafts = { hasNavigationDrafts, saveNavigationDrafts, restoreNavigationDrafts };`,
      })
      await target.waitForFunction(() => !!window.navigationDrafts)
    }
    await page.goto('http://draft.localhost/')
    await install()
    await run(page, install)
  } finally {
    await browser.close()
  }
}

it('restores text, oversized images and attachment metadata after same-tab switch/back until cleared', async () => {
  await withPage(async (page, install) => {
    await page.evaluate(async () => {
      await window.navigationDrafts.saveNavigationDrafts([
        {
          id: 7,
          text: 'Synthetic unsent draft',
          images: [{ data: 'AAAA'.repeat(500_001), mimeType: 'image/png' }],
          attachments: [{ id: 'synthetic-file', name: 'notes.txt', size: 12, status: 'ready' }],
          requestId: 'synthetic-request',
        },
      ])
      location.assign('http://target.localhost/')
    })
    await page.waitForURL('http://target.localhost/')
    expect(await page.evaluate(() => sessionStorage.length)).toBe(0)
    await page.goBack()
    await install()
    const restored = await page.evaluate(async () => {
      let result: object | undefined
      await window.navigationDrafts.restoreNavigationDrafts((drafts) => {
        const draft = drafts[0]
        result = {
          ...draft,
          images: draft.images.map((image) => ({
            mimeType: image.mimeType,
            length: image.data.length,
            intact: image.data === 'AAAA'.repeat(500_001),
          })),
        }
      })
      return { result, remaining: window.navigationDrafts.hasNavigationDrafts() }
    })
    expect(restored).toEqual({
      remaining: true,
      result: {
        id: 7,
        text: 'Synthetic unsent draft',
        requestId: 'synthetic-request',
        images: [{ mimeType: 'image/png', length: 2_000_004, intact: true }],
        attachments: [{ id: 'synthetic-file', name: 'notes.txt', size: 12, status: 'ready' }],
      },
    })
    await page.reload()
    await install()
    expect(await page.evaluate(() => window.navigationDrafts.hasNavigationDrafts())).toBe(true)
    await page.evaluate(() => window.navigationDrafts.saveNavigationDrafts([]))
    await page.reload()
    await install()
    expect(await page.evaluate(() => window.navigationDrafts.hasNavigationDrafts())).toBe(false)
  })
})

it('keeps an autosaved valid oversized PNG and draft text through an ordinary reload without navigation preparation', async () => {
  await withPage(async (page, install) => {
    const source = stripTypeScriptTypes(
      await readFile(new URL('../../web/src/app/draft-images.ts', import.meta.url), 'utf8'),
    )
    await page.addScriptTag({
      type: 'module',
      content: `${source}\nwindow.syntheticDraftImages = { storeImages };`,
    })
    await page.waitForFunction(() => 'syntheticDraftImages' in window)
    const before = await page.evaluate(async () => {
      const canvas = document.createElement('canvas')
      canvas.width = 720
      canvas.height = 720
      const context = canvas.getContext('2d')!
      const pixels = context.createImageData(720, 720)
      let seed = 42
      for (let i = 0; i < pixels.data.length; i++) {
        seed = (Math.imul(seed, 1664525) + 1013904223) | 0
        pixels.data[i] = i % 4 === 3 ? 255 : seed >>> 24
      }
      context.putImageData(pixels, 0, 0)
      const image = { data: canvas.toDataURL('image/png').split(',')[1], mimeType: 'image/png' }
      localStorage.setItem('ultimate.draft.7', 'Synthetic unsent text')
      const ordinaryImages = (
        window as unknown as {
          syntheticDraftImages: { storeImages: (key: string, images: object[]) => void }
        }
      ).syntheticDraftImages
      ordinaryImages.storeImages('ultimate.draft.7', [image])
      await window.navigationDrafts.saveNavigationDrafts([
        {
          id: 7,
          text: 'Synthetic unsent text',
          images: [image],
          attachments: [],
          requestId: 'synthetic',
        },
      ])
      const digest = Array.from(
        new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(image.data))),
      )
      return { chars: image.data.length, bytes: atob(image.data).length, digest }
    })
    expect(before.chars).toBeGreaterThan(2_000_000)
    expect(before.bytes).toBeLessThanOrEqual(2 * 1024 * 1024)
    expect(await page.evaluate(() => localStorage.getItem('ultimate.draft.7.images'))).toBeNull()
    await page.reload()
    await install()
    const after = await page.evaluate(async () => {
      let data = ''
      let text = ''
      await window.navigationDrafts.restoreNavigationDrafts((drafts) => {
        text = drafts[0].text
        data = drafts[0].images[0].data
      })
      return {
        text,
        ordinaryText: localStorage.getItem('ultimate.draft.7'),
        chars: data.length,
        bytes: atob(data).length,
        digest: Array.from(
          new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(data))),
        ),
      }
    })
    expect(after).toEqual({
      ...before,
      text: 'Synthetic unsent text',
      ordinaryText: 'Synthetic unsent text',
    })
  })
})

it('recovers durable images and this tab’s newer text after a failed write on a fresh page', async () => {
  await withPage(async (page, install) => {
    await page.evaluate(async () => {
      const draft = {
        id: 7,
        text: 'Durable text',
        images: [{ data: 'AAAA'.repeat(500_001), mimeType: 'image/png' }],
        attachments: [],
        requestId: 'synthetic',
      }
      await window.navigationDrafts.saveNavigationDrafts([draft])
      const put = Object.getOwnPropertyDescriptor(IDBObjectStore.prototype, 'put')!
        .value as IDBObjectStore['put']
      IDBObjectStore.prototype.put = function (value: object, key?: IDBValidKey) {
        if ('drafts' in value) throw new Error('Synthetic failed transaction')
        return put.call(this, value, key)
      }
      const saving = window.navigationDrafts.saveNavigationDrafts([
        { ...draft, text: 'New durable local text' },
      ])
      localStorage.setItem('ultimate.draft.7', 'New durable local text')
      try {
        await saving
      } catch {
        /* Expected injected storage failure. */
      }
    })
    await page.reload()
    await install()
    expect(
      await page.evaluate(async () => {
        let restored: object | undefined
        await window.navigationDrafts.restoreNavigationDrafts((drafts) => {
          restored = {
            text: drafts[0].text,
            image: drafts[0].images[0].data.slice(0, 4),
            chars: drafts[0].images[0].data.length,
          }
        })
        return { restored, ordinaryText: localStorage.getItem('ultimate.draft.7') }
      }),
    ).toEqual({
      restored: { text: 'New durable local text', image: 'AAAA', chars: 2_000_004 },
      ordinaryText: 'New durable local text',
    })
  })
})

it('forks copied session pointers so divergent edits and clear cannot change the other live tab’s draft', async () => {
  await withPage(async (page, install) => {
    await page.evaluate(() =>
      window.navigationDrafts.saveNavigationDrafts([
        {
          id: 7,
          text: 'A original',
          images: [{ data: 'AAAA'.repeat(500_001), mimeType: 'image/png' }],
          attachments: [],
          requestId: 'synthetic',
        },
      ]),
    )
    const popup = page.waitForEvent('popup')
    await page.evaluate(() => {
      window.open('http://draft.localhost/', '_blank')
    })
    const duplicate = await popup
    await duplicate.waitForLoadState()
    await install(duplicate)
    await duplicate.evaluate(async () => {
      await window.navigationDrafts.restoreNavigationDrafts((saved) => {
        window.syntheticDrafts = saved
      })
      await window.navigationDrafts.saveNavigationDrafts(window.syntheticDrafts)
    })
    await page.evaluate(async () => {
      await window.navigationDrafts.saveNavigationDrafts([
        {
          id: 7,
          text: 'A changed image',
          images: [{ data: 'AQEB'.repeat(500_001), mimeType: 'image/png' }],
          attachments: [],
          requestId: 'synthetic',
        },
      ])
      localStorage.setItem('ultimate.draft.7', 'A changed image')
    })
    await duplicate.evaluate(async () => {
      // The composer still holds X from its initial hydration, not the shared record A just overwrote.
      window.syntheticDrafts = window.syntheticDrafts.map((draft) => ({
        ...draft,
        text: 'B text edit',
      }))
      await window.navigationDrafts.saveNavigationDrafts(window.syntheticDrafts)
      localStorage.setItem('ultimate.draft.7', 'B text edit')
    })
    // Reproduce the text-only path with B's cached X array, rather than a new array forcing another image write.
    await duplicate.reload()
    await install(duplicate)
    const restored = await duplicate.evaluate(async () => {
      let result: object | undefined
      await window.navigationDrafts.restoreNavigationDrafts((drafts) => {
        result = { text: drafts[0].text, image: drafts[0].images[0].data.slice(0, 4) }
      })
      return result
    })
    expect(restored).toEqual({ text: 'B text edit', image: 'AAAA' })
    await duplicate.evaluate(() => window.navigationDrafts.saveNavigationDrafts([]))
    await page.reload()
    await install()
    expect(
      await page.evaluate(async () => {
        let result: object | undefined
        await window.navigationDrafts.restoreNavigationDrafts((drafts) => {
          result = { text: drafts[0].text, image: drafts[0].images[0].data.slice(0, 4) }
        })
        return result
      }),
    ).toEqual({ text: 'A changed image', image: 'AQEB' })
  })
})

it.each(['replace', 'clear'] as const)(
  'rejects an obsolete copied pointer after the original tab %s without changing either journal or pointer',
  async (action) => {
    await withPage(async (page, install) => {
      const snapshot = (target = page) =>
        target.evaluate(async () => {
          const db = await new Promise<IDBDatabase>((resolve, reject) => {
            const request = indexedDB.open('ultimate.navigation-drafts', 1)
            request.addEventListener('success', () => resolve(request.result))
            request.addEventListener('error', () => reject(request.error))
          })
          const records = await new Promise<{ token: string }[]>((resolve, reject) => {
            const request = db.transaction('backups').objectStore('backups').getAll()
            request.addEventListener('success', () => resolve(request.result))
            request.addEventListener('error', () => reject(request.error))
          })
          db.close()
          const hash = await crypto.subtle.digest(
            'SHA-256',
            new TextEncoder().encode(JSON.stringify(records)),
          )
          return {
            tokens: records.map((record) => record.token),
            hash: Array.from(new Uint8Array(hash), (byte) =>
              byte.toString(16).padStart(2, '0'),
            ).join(''),
          }
        })
      await page.evaluate(async () => {
        window.syntheticDrafts = [
          {
            id: 6,
            text: 'Unaffected synthetic draft',
            images: [{ data: 'AgIC'.repeat(500_001), mimeType: 'image/png' }],
            attachments: [],
            requestId: 'unaffected',
          },
          {
            id: 7,
            text: 'Synthetic original',
            images: [{ data: 'AAAA'.repeat(500_001), mimeType: 'image/png' }],
            attachments: [],
            requestId: 'synthetic',
          },
        ]
        await window.navigationDrafts.saveNavigationDrafts(window.syntheticDrafts)
      })
      const popup = page.waitForEvent('popup')
      await page.evaluate(() => {
        window.open('http://draft.localhost/', '_blank')
      })
      const duplicate = await popup
      await duplicate.waitForLoadState()
      const originalPointer = await duplicate.evaluate(() =>
        sessionStorage.getItem('ultimate.navigation-drafts'),
      )
      // B has copied X's pointer, but does not run draft code until after A replaces or clears X.
      await page.evaluate(async (mode) => {
        window.syntheticDrafts = window.syntheticDrafts.flatMap((draft) =>
          draft.id !== 7
            ? [draft]
            : mode === 'clear'
              ? []
              : [
                  {
                    ...draft,
                    text: 'Synthetic changed',
                    images: [{ data: 'AQEB'.repeat(500_001), mimeType: 'image/png' }],
                  },
                ],
        )
        await window.navigationDrafts.saveNavigationDrafts(window.syntheticDrafts)
      }, action)
      const sourcePointer = await page.evaluate(() =>
        sessionStorage.getItem('ultimate.navigation-drafts'),
      )
      const sourceJournal = await snapshot()
      expect(sourceJournal.tokens).toHaveLength(action === 'clear' ? 2 : 3)
      // A late copy must also fail when the original owner has closed and its old lease is available.
      if (action === 'replace') await page.close()
      const errors: string[] = []
      duplicate.on('pageerror', (error) => errors.push(error.message))
      await install(duplicate)
      const result = await duplicate.evaluate(async () => {
        let restored = false
        let resaved = false
        let error: string | undefined
        try {
          await window.navigationDrafts
            .restoreNavigationDrafts((drafts) => {
              restored = true
              window.syntheticDrafts = drafts
            })
            .then(async () => {
              resaved = true
              await window.navigationDrafts.saveNavigationDrafts(window.syntheticDrafts)
            })
        } catch (failure) {
          error = (failure as Error).message
        }
        return {
          restored,
          resaved,
          error,
          pointer: sessionStorage.getItem('ultimate.navigation-drafts'),
        }
      })
      expect(result).toEqual({
        restored: false,
        resaved: false,
        error: 'Draft images unavailable. Restoration stopped.',
        pointer: originalPointer,
      })
      expect(await snapshot(duplicate)).toEqual(sourceJournal)
      const liveSourcePointers = page.isClosed()
        ? []
        : [await page.evaluate(() => sessionStorage.getItem('ultimate.navigation-drafts'))]
      expect(liveSourcePointers).toEqual(action === 'replace' ? [] : [sourcePointer])
      expect(errors).toEqual([])
    })
  },
)

it('does not resurrect partially cleared text, images or attachments after a failed write and reload', async () => {
  await withPage(async (page, install) => {
    await page.evaluate(async () => {
      const draft = {
        id: 7,
        text: 'Clear this text',
        images: [
          { data: 'AAAA'.repeat(500_001), mimeType: 'image/png' },
          { data: 'AQEB'.repeat(500_001), mimeType: 'image/png' },
        ],
        attachments: [
          { id: 'synthetic-file', name: 'notes.txt', size: 12, status: 'ready' as const },
        ],
        requestId: 'synthetic',
      }
      await window.navigationDrafts.saveNavigationDrafts([draft])
      const put = Object.getOwnPropertyDescriptor(IDBObjectStore.prototype, 'put')!
        .value as IDBObjectStore['put']
      IDBObjectStore.prototype.put = function (value: object, key?: IDBValidKey) {
        if ('drafts' in value) throw new Error('Synthetic failed clear transaction')
        return put.call(this, value, key)
      }
      try {
        await window.navigationDrafts.saveNavigationDrafts([
          { ...draft, text: '', images: [draft.images[1]], attachments: [] },
        ])
      } catch {
        /* Expected injected storage failure; the small header must still suppress explicit removals. */
      }
    })
    await page.reload()
    await install()
    expect(
      await page.evaluate(async () => {
        let result: object | undefined
        await window.navigationDrafts.restoreNavigationDrafts((drafts) => {
          result = {
            text: drafts[0].text,
            images: drafts[0].images.map((image) => image.data.slice(0, 4)),
            attachments: drafts[0].attachments,
          }
        })
        return result
      }),
    ).toEqual({ text: '', images: ['AQEB'], attachments: [] })
    await page.evaluate(async () => {
      IDBObjectStore.prototype.delete = () => {
        throw new Error('Synthetic failed delete')
      }
      try {
        await window.navigationDrafts.saveNavigationDrafts([])
      } catch {
        /* Explicit clear/send still invalidates this tab's restore pointer synchronously. */
      }
    })
    await page.reload()
    await install()
    expect(await page.evaluate(() => window.navigationDrafts.hasNavigationDrafts())).toBe(false)
  })
})

it('warns natively only for unpreserved pending or failed work and removes the warning on save or clear', async () => {
  await withPage(async (page) => {
    expect(
      await page.evaluate(async () => {
        const warns = () => {
          const event = new Event('beforeunload', { cancelable: true })
          dispatchEvent(event)
          return event.defaultPrevented
        }
        const draft = {
          id: 7,
          text: 'Synthetic draft',
          images: [{ data: 'AAAA'.repeat(500_001), mimeType: 'image/png' }],
          attachments: [],
          requestId: 'synthetic',
        }
        const saving = window.navigationDrafts.saveNavigationDrafts([draft])
        const pending = warns()
        await saving
        const saved = warns()
        const repeat = window.navigationDrafts.saveNavigationDrafts([draft])
        const alreadyDurable = warns()
        await repeat
        const put = Object.getOwnPropertyDescriptor(IDBObjectStore.prototype, 'put')!
          .value as IDBObjectStore['put']
        IDBObjectStore.prototype.put = function (value: object, key?: IDBValidKey) {
          if ('images' in value) throw new Error('Synthetic failed image transaction')
          return put.call(this, value, key)
        }
        try {
          await window.navigationDrafts.saveNavigationDrafts([
            { ...draft, images: [{ data: 'AQEB'.repeat(500_001), mimeType: 'image/png' }] },
          ])
        } catch {
          /* Keep the native warning while the replacement image has no durable bytes. */
        }
        return { pending, saved, alreadyDurable, failed: warns() }
      }),
    ).toEqual({ pending: true, saved: false, alreadyDurable: false, failed: true })
    await page.evaluate(() => {
      document.body.textContent = 'Synthetic draft storage fixture'
    })
    await page.locator('body').click()
    const dialogWait = page.waitForEvent('dialog')
    const reload = page.evaluate(() => location.reload())
    const dialog = await dialogWait
    expect(dialog.type()).toBe('beforeunload')
    await dialog.dismiss()
    await reload
    expect(await page.evaluate(() => !!window.navigationDrafts)).toBe(true)
    expect(
      await page.evaluate(async () => {
        const cleared = window.navigationDrafts.saveNavigationDrafts([])
        const event = new Event('beforeunload', { cancelable: true })
        dispatchEvent(event)
        await cleared
        return event.defaultPrevented
      }),
    ).toBe(false)
    await page.reload()
  })
})

it('releases restored image objects after their owned draft is cleared', async () => {
  await withPage(async (page, install) => {
    await page.evaluate(() =>
      window.navigationDrafts.saveNavigationDrafts([
        {
          id: 7,
          text: 'Synthetic draft',
          images: [{ data: 'AAAA'.repeat(500_001), mimeType: 'image/png' }],
          attachments: [],
          requestId: 'synthetic',
        },
      ]),
    )
    await page.reload()
    await install()
    await page.evaluate(async () => {
      await window.navigationDrafts.restoreNavigationDrafts((drafts) => {
        window.syntheticImage = new WeakRef(drafts[0].images[0])
      })
      await window.navigationDrafts.saveNavigationDrafts([])
    })
    const cdp = await page.context().newCDPSession(page)
    await cdp.send('HeapProfiler.collectGarbage')
    const retainedAfterClear = await page.evaluate(
      () => window.syntheticImage!.deref() !== undefined,
    )
    expect(retainedAfterClear).toBe(false)
  })
})

it('retries a complete owned write after the second pointer publication fails', async () => {
  await withPage(async (page, install) => {
    expect(
      await page.evaluate(async () => {
        const set = Object.getOwnPropertyDescriptor(Storage.prototype, 'setItem')!
          .value as Storage['setItem']
        let calls = 0
        Storage.prototype.setItem = function (key, value) {
          if (key === 'ultimate.navigation-drafts' && ++calls === 2)
            throw new Error('Synthetic second pointer failure')
          set.call(this, key, value)
        }
        const draft = {
          id: 7,
          text: 'Synthetic pending image',
          images: [{ data: 'AAAA'.repeat(500_001), mimeType: 'image/png' }],
          attachments: [],
          requestId: 'synthetic',
        }
        let initial: string | undefined
        try {
          await window.navigationDrafts.saveNavigationDrafts([draft])
        } catch (failure) {
          initial = ((failure as Error).cause as Error).message
        }
        const failed = new Event('beforeunload', { cancelable: true })
        dispatchEvent(failed)
        await window.navigationDrafts.saveNavigationDrafts([draft])
        const saved = new Event('beforeunload', { cancelable: true })
        dispatchEvent(saved)
        return { initial, failed: failed.defaultPrevented, saved: saved.defaultPrevented }
      }),
    ).toEqual({ initial: 'Synthetic second pointer failure', failed: true, saved: false })
    await page.reload()
    await install()
    expect(
      await page.evaluate(async () => {
        let result: object | undefined
        await window.navigationDrafts.restoreNavigationDrafts((drafts) => {
          result = {
            text: drafts[0].text,
            imageMatches: drafts[0].images[0].data === 'AAAA'.repeat(500_001),
          }
        })
        return result
      }),
    ).toEqual({ text: 'Synthetic pending image', imageMatches: true })
  })
})

it('rejects a storage failure before navigation instead of falling back to lossy localStorage', async () => {
  await withPage(async (page) => {
    const error = await page.evaluate(async () => {
      Object.defineProperty(window, 'indexedDB', {
        value: {
          open() {
            throw new Error('Synthetic disk failure')
          },
        },
      })
      try {
        await window.navigationDrafts.saveNavigationDrafts([
          {
            id: 7,
            text: 'Synthetic draft',
            images: [{ data: 'AAAA'.repeat(500_001), mimeType: 'image/png' }],
            attachments: [],
            requestId: 'synthetic-request',
          },
        ])
        location.assign('http://target.localhost/')
        return undefined
      } catch (failure) {
        return (failure as Error).message
      }
    })
    expect(error).toBe('Could not preserve drafts. Stay on this page and try again.')
    expect(page.url()).toBe('http://draft.localhost/')
  })
})
