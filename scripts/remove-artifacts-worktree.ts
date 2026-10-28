// Project worktree removal: Git requires --force for initialized submodules, even when clean.
// Keep ordinary dirty-tree protection and refuse nested history absent from origin's fetched refs.
import { execFileSync } from 'node:child_process'
import { existsSync, realpathSync } from 'node:fs'
import { join, resolve } from 'node:path'

const path = process.argv[2]
if (!path) throw new Error('Expected the worktree path')
const tree = realpathSync(resolve(path))
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
const clean = (cwd: string) => {
  if (git(cwd, 'status', '--porcelain', '--untracked-files=all', '--ignore-submodules=none'))
    throw new Error(`Refusing to remove modified or untracked source: ${cwd}`)
}

clean(tree)
const source = join(tree, '.ultimate/extensions/artifacts')
const initialized = existsSync(join(source, '.git'))
if (initialized) {
  if (realpathSync(git(source, 'rev-parse', '--show-toplevel')) !== realpathSync(source))
    throw new Error('Artifact source is not its own Git checkout')
  clean(source)
  if (git(source, 'ls-files', '--others', '--ignored', '--exclude-standard'))
    throw new Error('Artifact source has ignored local files; preserve them before removal')
  const pin = git(tree, 'rev-parse', 'HEAD:.ultimate/extensions/artifacts')
  if (git(source, 'rev-parse', 'HEAD') !== pin)
    throw new Error('Artifact checkout differs from the committed pin')
  if (git(source, 'rev-list', '--all', '--reflog', '--not', '--remotes=origin'))
    throw new Error('Artifact source has local history not preserved by origin refs')
}
// Parent ignored build/install files retain ordinary worktree-removal semantics; nested ignored files are kept.
// The source queue and busy checks belong to workspaces; do not remove an actively edited checkout.
// One --force permits a validated submodule, but deliberately does not override a worktree lock.
git(process.cwd(), 'worktree', 'remove', ...(initialized ? ['--force'] : []), tree)
