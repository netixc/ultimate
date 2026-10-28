import { expect, it } from 'vitest'
import { decodeFrameMessage } from '../.ultimate/extensions/native-artifacts/bridge.ts'

it('decodes bounded target geometry and genuine layout observations without accepting artifact identity', () => {
  const rect = { x: 12, y: -8, width: 200, height: 30 }
  const anchor = { kind: 'element', selector: '#target', text: 'Target' }
  const target = { channel: 'frame', type: 'target', anchor, rect }
  expect(decodeFrameMessage(target, 'frame')).toEqual({ type: 'target', anchor, rect })
  expect(decodeFrameMessage({ ...target, rect: { ...rect, x: Infinity } }, 'frame')).toBeUndefined()
  expect(decodeFrameMessage({ ...target, rect: { ...rect, width: -1 } }, 'frame')).toBeUndefined()
  expect(decodeFrameMessage(target, 'other')).toBeUndefined()
  const pass = {
    viewport: { width: 640, height: 420 },
    complete: true,
    findings: [
      { rule: 'clipped-control', selector: '#target', axis: 'horizontal', overflowPx: 20 },
    ],
  }
  const message = { channel: 'frame', type: 'diagnostics', pass }
  expect(decodeFrameMessage(message, 'frame')).toEqual({ type: 'diagnostics', pass })
  expect(
    decodeFrameMessage({ ...message, pass: { ...pass, artifactId: 'forged' } }, 'frame'),
  ).toBeUndefined()
  expect(
    decodeFrameMessage(
      { ...message, pass: { ...pass, complete: false, error: 'Scan limit reached' } },
      'frame',
    ),
  ).toMatchObject({ type: 'diagnostics', pass: { complete: false, error: 'Scan limit reached' } })
  expect(
    decodeFrameMessage(
      { ...message, pass: { ...pass, findings: Array(101).fill(pass.findings[0]) } },
      'frame',
    ),
  ).toBeUndefined()
})
