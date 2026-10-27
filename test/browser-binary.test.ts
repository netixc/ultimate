import { access, readdir } from 'node:fs/promises'
import { chromium } from 'playwright-core'
import { expect, it, vi } from 'vitest'
import { browserBinary } from '../extensions/browser/server.ts'

vi.mock('node:fs/promises', async (original) => ({
  ...(await original<typeof import('node:fs/promises')>()),
  access: vi.fn<typeof access>(),
  readdir: vi.fn<typeof readdir>(),
}))

it('discovers Playwright Chromium at its native macOS executable path without an override', async () => {
  const native =
    '/browser-cache/chromium-1243/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'
  const executable = vi.spyOn(chromium, 'executablePath').mockReturnValue(native)
  vi.mocked(readdir).mockResolvedValue([])
  vi.mocked(access).mockImplementation(async (path) => {
    if (path !== native) throw Object.assign(new Error('not installed'), { code: 'ENOENT' })
  })
  try {
    expect(await browserBinary()).toBe(native)
    expect(access).toHaveBeenCalledWith(native)
  } finally {
    executable.mockRestore()
  }
})
