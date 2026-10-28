import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, test } from 'vitest'
import {
  addCheckout,
  removeCheckout,
  treeName,
  treePath,
} from '../../extensions/workspaces/tree.ts'

const run = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
function repository() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'tree-')))
  const source = join(root, 'source')
  execFileSync('git', ['init', '-q', '-b', 'main', source])
  run(
    source,
    '-c',
    'user.name=t',
    '-c',
    'user.email=t@t',
    'commit',
    '-q',
    '--allow-empty',
    '-m',
    'first',
  )
  return { root, source, base: run(source, 'rev-parse', 'HEAD') }
}

test('a configured path names checkouts, expands ~, resolves symlinks and must be absolute', async () => {
  expect(treeName('ultimate/abc123-7')).toBe('ult-abc123-7')
  expect(await treePath({ isolates: { worktree: { path: '~/trees/{name}/src' } } }, 'ult-1')).toBe(
    join(realpathSync(homedir()), 'trees/ult-1/src'),
  )
  expect(await treePath({}, 'ult-1')).toBeUndefined()
  const { root } = repository()
  symlinkSync(root, join(root, 'link'))
  expect(await treePath({ isolates: { worktree: { path: join(root, 'link/{name}') } } }, 'a')).toBe(
    join(root, 'a'),
  )
  await expect(treePath({ isolates: { worktree: { path: 'trees/{name}' } } }, 'a')).rejects.toThrow(
    'must be absolute',
  )
  await expect(
    treePath({ isolates: { worktree: { path: join(root, 'code') } } }, 'a'),
  ).rejects.toThrow('must contain {name}')
  await expect(treePath({ isolates: { worktree: { path: 1 } } }, 'a')).rejects.toThrow(
    'isolates.worktree.path must be a string',
  )
})

test('a path alone keeps git worktree add and remove', async () => {
  const { root, source, base } = repository()
  const settings = { isolates: { worktree: { path: join(root, 'trees/{name}') } } }
  const path = (await treePath(settings, 'ult-1'))!
  await addCheckout(settings, source, path, 'ult-1', ['-b', 'ultimate/x-1', base])
  expect(run(path, 'symbolic-ref', '--short', 'HEAD')).toBe('ultimate/x-1')
  await removeCheckout(settings, source, path, 'ult-1')
  expect(run(source, 'worktree', 'list', '--porcelain')).not.toContain(path)
})

test('configured add and remove commands get {name} and {path} as shell words, and must do their part', async () => {
  const { root, source, base } = repository()
  const settings = {
    isolates: {
      worktree: {
        path: join(root, "it's here/{name}"),
        add: 'git worktree add --detach {path} HEAD',
        remove: 'git worktree remove {path}',
      },
    },
  }
  const path = (await treePath(settings, 'ult-2'))!
  await addCheckout(settings, source, path, 'ult-2', ['-b', 'ultimate/x-2', base])
  expect(run(path, 'symbolic-ref', '--short', 'HEAD')).toBe('ultimate/x-2')
  await expect(
    removeCheckout({ isolates: { worktree: { remove: 'true' } } }, source, path, 'ult-2'),
  ).rejects.toThrow('isolates.worktree.remove left')
  await removeCheckout(settings, source, path, 'ult-2')
  expect(run(source, 'worktree', 'list', '--porcelain')).not.toContain(path)
  await expect(
    addCheckout({ isolates: { worktree: { add: 'exit 3' } } }, source, join(root, 'n'), 'n', [
      '--detach',
      base,
    ]),
  ).rejects.toThrow('isolates.worktree.add failed')
  await expect(
    addCheckout({ isolates: { worktree: { add: 'true' } } }, source, join(root, 'm'), 'm', [
      '--detach',
      base,
    ]),
  ).rejects.toThrow('isolates.worktree.add left no worktree')
})

test('a failed add clears its half-made checkout, so the command can run again', async () => {
  const { root, source, base } = repository()
  const path = join(root, 'half')
  // The command registers the worktree and then fails, as an interrupted copy would.
  const settings = {
    isolates: { worktree: { add: 'git worktree add --detach {path} HEAD && exit 4' } },
  }
  await expect(
    addCheckout(settings, source, path, 'half', ['-b', 'ultimate/x-3', base]),
  ).rejects.toThrow('isolates.worktree.add failed')
  expect(existsSync(path)).toBe(false)
  expect(run(source, 'worktree', 'list', '--porcelain')).not.toContain(path)
  const fixed = { isolates: { worktree: { add: 'git worktree add --detach {path} HEAD' } } }
  await addCheckout(fixed, source, path, 'half', ['-b', 'ultimate/x-3', base])
  expect(run(path, 'symbolic-ref', '--short', 'HEAD')).toBe('ultimate/x-3')
})

test('the artifact removal hook releases a clean submodule but preserves dirty source and unpublished history', async () => {
  const { root, source } = repository()
  const extension = repository().source
  run(extension, 'config', 'maintenance.auto', 'false')
  writeFileSync(join(extension, 'source.txt'), 'published source')
  run(extension, 'add', '.')
  run(extension, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'source')
  run(
    source,
    '-c',
    'protocol.file.allow=always',
    'submodule',
    'add',
    '-q',
    '--name',
    'artifacts',
    extension,
    '.ultimate/extensions/artifacts',
  )
  run(source, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qam', 'pin source')
  const settings = {
    isolates: {
      worktree: { remove: `node '${resolve('scripts/remove-artifacts-worktree.ts')}' {path}` },
    },
  }
  const path = join(root, 'tree')
  const prepare = async () => {
    await addCheckout({}, source, path, 'tree', ['--detach', 'HEAD'])
    run(path, '-c', 'protocol.file.allow=always', 'submodule', 'update', '--init')
  }
  await prepare()
  await expect(removeCheckout({}, source, path, 'tree')).rejects.toThrow('submodules')
  await removeCheckout(settings, source, path, 'tree')
  expect(existsSync(path)).toBe(false)
  expect(run(source, 'worktree', 'list', '--porcelain')).not.toContain(path)

  await prepare()
  const nested = join(path, '.ultimate/extensions/artifacts')
  // Even a user-configured ignore must not hide source changes from the removal hook.
  run(path, 'config', 'submodule.artifacts.ignore', 'all')
  writeFileSync(join(nested, 'source.txt'), 'unsaved source')
  await expect(removeCheckout(settings, source, path, 'tree')).rejects.toThrow(
    'modified or untracked source',
  )
  expect(existsSync(join(nested, 'source.txt'))).toBe(true)
  run(nested, 'checkout', '--', 'source.txt')
  const pin = run(nested, 'rev-parse', 'HEAD')
  run(nested, 'checkout', '-qb', 'unpublished')
  writeFileSync(join(nested, 'local.txt'), 'unpublished source')
  run(nested, 'add', '.')
  run(nested, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'local work')
  const unpublished = run(nested, 'rev-parse', 'HEAD')
  run(nested, 'checkout', '--detach', pin)
  expect(run(nested, 'status', '--porcelain')).toBe('')
  await expect(removeCheckout(settings, source, path, 'tree')).rejects.toThrow(
    'local history not preserved',
  )
  expect(run(nested, 'rev-parse', 'unpublished')).toBe(unpublished)
  expect(existsSync(path)).toBe(true)
})

test('the remove command never runs on a checkout with modified or untracked files', async () => {
  const { root, source, base } = repository()
  const log = join(root, 'removed')
  const settings = {
    isolates: {
      worktree: {
        path: join(root, '{name}'),
        remove: `echo ran > '${log}' && git worktree remove --force {path}`,
      },
    },
  }
  const path = (await treePath(settings, 'ult-4'))!
  await addCheckout(settings, source, path, 'ult-4', ['-b', 'ultimate/x-4', base])
  writeFileSync(join(path, 'work.txt'), 'unsaved')
  await expect(removeCheckout(settings, source, path, 'ult-4')).rejects.toThrow(
    'contains modified or untracked files',
  )
  expect(existsSync(log)).toBe(false)
  expect(existsSync(join(path, 'work.txt'))).toBe(true)
})
