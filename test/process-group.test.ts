import { expect, it, vi } from 'vitest'
import { groupAlive } from '../lib/process-group.ts'

it('keeps an inaccessible group alive until the kernel confirms it is gone', () => {
  const kill = vi
    .spyOn(process, 'kill')
    .mockImplementationOnce(() => {
      throw Object.assign(new Error('kill EPERM'), { code: 'EPERM' })
    })
    .mockImplementationOnce(() => {
      throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' })
    })
  try {
    expect(groupAlive(123)).toBe(true)
    expect(groupAlive(123)).toBe(false)
    expect(kill.mock.calls).toEqual([
      [-123, 0],
      [-123, 0],
    ])
  } finally {
    kill.mockRestore()
  }
})
