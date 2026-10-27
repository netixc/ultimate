# Local HTML artifacts

A shared backend retains the current local HTML artifact and saves human review feedback before admitting its wake message.

## Publishing and reading

`artifact_publish({id?,title,path,assets?})` publishes from the tool caller's conversation. The `publish` action accepts the same `PublishArtifact`; its owner always comes from `ctx.conversationId`, not JSON. Only that owner can republish an existing id. Reuse the id for revisions. The tool returns `Artifact` in `details` for a reviewer-owned renderer. No live server, history, variants or workflow engine is involved.

The service token is `ArtifactsApi` in `api.ts`. Its trusted server methods are `publish(input, ownerConversation, ctx)`, `list(ctx)`, `read(id, ctx)`, `feedback(input, ctx)`, `feedbackList(artifactId, ctx)` and `feedbackRead(artifactId, id, ctx)`. Context is a Chord `Context`. Server adapters must derive the publish owner from their authenticated action/tool context. Feedback-creating proxy actions must be **user-only and sealed**, as the common feedback action is: agents may not impersonate human feedback through privileged typed-input admission.

Actions and typed refs in `refs.ts`:

- `publish(PublishArtifact)` → `Artifact`.
- `list(null)` → `Artifact[]` without reading source workspaces.
- `read({id})` → `ArtifactSnapshot`, refreshing from the source where available.
- `feedback(FeedbackInput)` → `FeedbackBundle`, saved before any wake or acknowledgement. **User-only and sealed** (image bytes do not enter the action trace).
- `feedbackList({artifactId})` → newest **50** `FeedbackSummary` records, retrying outstanding delivery. These contain original notes and image name/MIME metadata only, **never base64 image bytes**, so repeated polling does not hydrate up to 50 image bundles.
- `feedbackRead({artifactId,id})` → one full `FeedbackBundle`, including exact retained reference images, read on demand. The bundle must belong to the named artifact. `feedback(input)` still returns its single full saved bundle.

An owner's current workspace is resolved inside a harness transaction from the Workspaces API's admitted index, or the owner's configured cwd when no workspace was assigned. A workspace in any state except `ready`, or a concluded/missing owner, fails closed. A removed workspace never falls back to the project checkout. Admission and source identity are checked again before updating the registry. A source that disappears, is removed, or cannot be refreshed leaves the last retained snapshot readable, with `sourceError`.

## Retention and confinement

The root conversation document `artifacts.registry` holds artifact metadata, feedback input hashes, owner identity and delivery receipts. Feedback image bytes are **not** duplicated in this document. They are hydrated from retained files only for the single-bundle `feedback`/`feedbackRead` results and pending wake messages; `feedbackList` returns metadata directly.

Retained files are private instance data under `host.home/artifacts/<id>/`, never the repository:

- `<contentHash>/<published HTML path>` and explicitly named asset paths contain the current immutable snapshot.
- `feedback/<feedbackId>/bundle.json` contains the complete original feedback input, saved creation time and initial route. It is immutable; its initial `state: saved` is not the live receipt. The registry, `feedbackList` and `feedbackRead` are authoritative for actual route and delivery state.
- `feedback/<feedbackId>/image-N.{png,jpg,webp}` retains reference image bytes for an agent's image-reading tool. The wake text names these paths, original note ids, human target excerpts, owner, original recipient, hash and request id.

Each folder is completely written in a temporary sibling, with every file synced to disk, then renamed before the registry points at it. An interrupted save can leave an unreferenced folder; retries compare its input rather than reusing different bytes. The old snapshot is pruned only after the new registry value commits; pruning failure is a notice, not data loss. This provides filesystem/process-restart retention and file flushes, not a guarantee against hardware power loss or filesystem-directory loss.

Source paths must be strict relative POSIX paths. Empty/dot components, dotfiles, traversal, backslashes, control characters, secret/credential/key path names, symlink descendants and non-regular files are refused. The trusted admitted workspace root is canonicalized. HTML/HTM is at most 2 MiB; a complete bundle is at most 10 MiB. Only explicit CSS, PNG, JPEG, WebP, GIF, SVG, WOFF and WOFF2 assets are admitted, with MIME determined by extension. Script, JSON and environment files are not assets. No directory copy or implicit dependency discovery occurs. HTML is retained raw; rendering extensions own isolation and passive-content sanitation.

Reads use `O_NOFOLLOW`, a regular-file handle, bounded reads, and before/after device/inode/size/time checks for all source files and their path components. The bundle is committed only after the final checks. These checks detect ordinary edits, cleanup and symlink substitution; Node has no portable `openat` interface, so they are **not** an OS sandbox against a hostile local process swapping ancestor directories out and back between checks. The private host state directory and admitted workspace root are trusted. A filename/extension allowlist also cannot identify secrets deliberately embedded in otherwise valid HTML/CSS/images; publishers must not include them.

## Feedback delivery

There are at most 50 notes (4000 characters each), four PNG/JPEG/WebP references totalling 10 MiB, 128-character note/request ids, and bounded target selectors, excerpts and text boundaries. Empty element excerpts are allowed for image/icon targets; text selections require a nonempty quote. The original content hash may differ from the current artifact: feedback about a viewed older snapshot must remain attributable. Original recipient/hash/ids and all images are retained, never silently replaced by the latest artifact.

`requestId` is scoped to `artifactId`. Identical retries return the saved bundle and one transport receipt; differing normalized payloads fail clearly, including after a save interrupted before the registry commit. The actual route is persisted before each first admission and fixed once admission has a receipt. Missing or concluded recipients initially route to the actual standing `@ultimate` resolved by the Subagents API, not a hard-coded conversation number. Active recipients are addressed directly.

Delivery uses existing trusted `host.submit(routedTo, {text, requestId: 'artifacts:<feedbackId>', whenBusy: 'followUp'}, {context})`, the same validated typed-input admission path as the UI. No message sender is impersonated; reviewing an artifact owned by `@ultimate` works without a self-message. Pi owns durable task admission and the conversation-scoped idempotent receipt, saved here as `submissionId`. `state: delivered` means **admitted/queued**, not that an agent read or answered it. Reviewers should label it “Queued”, not “Received”. Errors leave feedback `saved` with `deliveryError`; opening the host and later actions/reads retry the saved input without a polling engine. A lost acknowledgement after input admission reuses the same submission receipt.

Recovery first checks Pi's `submissionByRequest` for the saved route and stable request id. An existing admission is acknowledged without calling `host.submit` again, so recovering a lost acknowledgement neither changes its route nor reopens a subsequently concluded conversation. Only when there is definitively no admission receipt may a concluded/missing destination be rerouted to the resolved standing `@ultimate`; the new route is saved before admission. Original recipient and payload remain unchanged. There is a narrow current-route snapshot race if a conversation concludes exactly between that fresh check and admission: the existing Conversations `beforeInput` hook resumes any conversation receiving input. Recovery does not knowingly resubmit admitted input or reroute an uncertain admitted batch.
