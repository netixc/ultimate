# Artifacts source checkout

The Artifacts project extension is maintained in [its source repository](https://github.com/netixc/ultimate-artifacts)
and pinned as a submodule at `.ultimate/extensions/artifacts`. It still uses this checkout's SDK, dependencies and
harness. There is one project registration, not a built-in backend plus a second plugin. Its README, development
notes, deferred roadmap and all nine synthetic test suites live in that repository.

## Worktrees and checks

Worktree setup keeps its existing command, `pnpm install --frozen-lockfile --prefer-offline`.
The host package's `pnpm:devPreinstall` hook runs exactly:

```sh
git submodule update --init -- .ultimate/extensions/artifacts
```

This matters on the first conversion: the lander reads setup settings from the still-old live host, but installs
the **merged checkout's** package. Its existing install command therefore initializes the merged pin without
changing or activating the live source. Publish the source pin before submitting that gate. Do not use
`--ignore-scripts` for this setup; a missing source then fails checks rather than silently dropping tests.
`optimisticRepeatInstall: false` prevents pnpm's warm-cache shortcut from skipping this hook. Neither dependency
versions nor the frozen lockfile change.

The submodule uses existing Git authentication. Access to the public host does not grant access to private source;
request repository read access through the normal Git workflow if initialization fails. Do not add a PAT to source,
settings or workflow files, silently skip tests, or substitute an empty/copy backend. Without the source,
`pnpm check` and test configuration loading fail explicitly. Host checks discover its five unit/HTTP/privacy suites
and four e2e suites; the existing TypeScript includes cover its code and tests. There are no extra dependencies or
private package installs.

To update, verify/review/publish a source commit first, check it out in the submodule, then commit the new gitlink in
a host feature branch. Run `pnpm check` and the artifact suites there, plus the normal merged-result gate. Do not use
`git submodule update --remote`: the host owns the exact pin. The source's standalone CI pins an earlier, published
host preparation SHA with no submodule, avoiding circular unpublished pins. Keep that host commit reachable.
The full bootstrap publication order is in the submodule's `docs/development.md`.

Worktree removal uses the existing project `isolates.worktree.remove` hook. The repository-specific script refuses
modified/untracked source (including nested changes hidden by Git ignore settings), a different nested HEAD,
ignored local files inside the source, or local branches/tags/reflog history absent from fetched `origin` refs.
Only a validated initialized submodule uses one `git worktree remove --force`, because Git refuses ordinary removal
for that layout even when clean; a locked worktree remains protected. Parent ignored build/install files retain
ordinary Git removal semantics. Workspaces owns the source queue and busy checks; never run removal on an active
editor or an unrelated checkout.

The old live host also lacks this remove hook on the first conversion. Keep an initialized first-gate checkout if
a failure/abandonment occurs before the host advances; do not force its cleanup. After integration the new hook can
release it, or deliberately invoke the reviewed script from the verified branch against that registered, idle
checkout. Passing checks do not authorize removal of existing unrelated worktrees or retained instance data.

## Live activation is a separate step

A lander/updater fast-forward changes the gitlink, **not** the live submodule checkout. Never report activation from
the host SHA alone. Do not initialize another project's extension or alter a mobile registration that did not have
Artifacts installed.

For the first conversion, arrange a draft-safe window **before** advancing the live host: finish or deliberately
discard unsent review notes/images, inspect both host and extension source changes, and record the current host SHA,
source pin (if any), facet registration and health. Do not force checkout, reset, clean, or deinitialize dirty source.
Preserve any local source edits outside the checkout before continuing. Retained data is not source and must stay in
the existing instance home.

After the checked host feature has landed, in that host checkout:

```sh
git status --short
git ls-tree HEAD -- .ultimate/extensions/artifacts
git submodule update --init -- .ultimate/extensions/artifacts
git submodule status -- .ultimate/extensions/artifacts
git -C .ultimate/extensions/artifacts status --short
```

Require a clean nested checkout at exactly the gitlink SHA (no `-`, `+` or `U` prefix from submodule status).
Then perform a controlled browser reload, reopen **Artifacts**, and verify one ready project `artifacts`
server/web registration, one Artifacts surface, no extension load errors and a healthy connection. Use a disposable
preview for synthetic publication/feedback and trace-privacy tests; do not probe actual private feedback. No core
change/restart or data migration is needed. Registry/layout identities, owners, content hashes, submission receipts,
shared operation queue and retained file bytes remain unchanged. Preserve unrelated preview homes and source files.

## Recovery and rollback

On clone/auth failure, leave the pin unchanged, resolve ordinary repository access and rerun the same init command.
On a wrong pin, inspect nested status before updating; never discard source edits. Recheck the exact pin and facets.
If checks or initialization fail, do not reload into or declare the new version active.

For later pin updates, make a normal reviewed host commit restoring the previous known-good gitlink, land it through
the usual gate, then repeat the explicit submodule update and draft-safe reload. Keep the published source commit
available. Do not rewrite host/source history or change the instance home.

Undoing the **initial extraction** is different: prepare and verify a normal revert of the conversion in an isolate;
it restores the embedded source/test files from the preparation commit. In a draft-safe maintenance window, preserve
and move the initialized nested checkout outside the live host before applying that verified revert, so its `.git`
and local files cannot collide with restored host-owned files. Do not use forced submodule deinitialization or
recursive cleaning. Apply the checked revert through the normal integration path, reload and verify the same single
registration. The retained instance data requires no rollback or migration in either case.
