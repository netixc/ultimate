# Artifact review: follow-up plan

This is a roadmap, not authorization to implement the deferred features. The current scope is static local HTML,
element/text annotations, general feedback and reference images, live updates, durable retention and feedback
admission, and authenticated access from the user's devices. The user chose to park version A (a separate Lavish
tab) and finish version B (native review), kept on a separate branch for testing. Any future alternative should reuse
the artifact backend rather than introduce a second registry.

## First: finish the common foundation

Prove registration and explicit-asset retention survive worktree removal; record the owner, editable recipient and
content hash; durably admit feedback with idempotent receipts. A receipt means received, not fixed. Preserve the
original note and reviewed content identity when the current target is stale. Security and recovery are acceptance
criteria, not deferred polish. No hosted uploads are part of this plan.

## 1. Rich static feedback

- **Editable Mermaid diagrams:** keep Mermaid source authoritative; send a bounded scene-change summary with an
  optional image/scene attachment, rather than silently replacing source from a drawing. Lavish already provides
  this as an opt-in; native review would need a separate editor integration.
- **Interactive answers:** agent-authored choices enqueue one explicit answer through the existing feedback
  admission path. Validate the payload outside the artifact; never let HTML choose its agent or run commands.
- **Layout findings and change highlights:** keep detection passive until the user selects a repair request.
  Distinguish an agent-declared change legend from independently verified fixes or automatic visual diffs.

**Milestone:** one real review loop for each chosen capability, including a stale revision and an explicit receipt.
**Depends on:** the common foundation and a separately reviewed script/network policy. Native review must not enable
all artifact scripts just to support one structured control.
**Risks:** large scene payloads, forged controls, ambiguous source-to-scene edits, and false-positive layout claims.
**Open choices:** which of these three capabilities is useful first; whether diagram editing is required or diagram
annotations suffice; whether findings are advisory only or become selected repair requests.

## 2. Historical revisions and design variants

Add immutable content-and-asset snapshots only if users need to reopen prior versions. Scope feedback to a snapshot,
retain the submitted original even when its target disappears, and show whether the current artifact differs.
Variants are named artifact alternatives with an explicit selection; do not infer a winner from comments.

**Milestone:** reopen two versions with their own notes, then compare two named variants and submit one explicit
selection. Retention and deletion must leave feedback understandable rather than silently repointing it.
**Depends on:** content identity, bounded storage and explicit retention/deletion policy.
**Risks:** private data accumulation, duplicated large assets, stale anchors, and confusing source history with
browser state. A saved HTML snapshot does not reproduce a logged-in or interacted-with DOM.
**Open choices:** saved versions versus side-by-side comparison first; storage/retention limits; whether selection
only records a preference or also authorizes the agent to apply it.

## 3. Live app and devserver review

Treat live apps as a different target type, not as HTML files or Ultimate instances. Reuse an already running app
when possible; any managed process needs explicit ownership, workspace/port identity and shutdown behavior. Keep
review controls separate from app interaction. Do not copy browser logins or proxy arbitrary URLs by default.

**Milestone:** review one known local app with routing and HMR, preserving unsent feedback through a refresh; prove
that a stopped server is shown honestly and that another process on the same port is never stopped or trusted.
**Depends on:** an approved injection/instrumentation strategy and an authenticated remote access boundary for that
app. Static-file sandbox assumptions do not automatically apply to apps with backends and login state.
**Risks:** backend mutations, cookies/secrets, CSP conflicts, third-party frames, network exposure, and selectors
becoming stale under HMR or app interaction.
**Open choices:** view-only plus screenshots versus DOM annotations; existing devservers only versus managed starts;
which app and login model to support first.

## Explicit exclusions

No background rollout of these milestones, no hosted sharing, no arbitrary URL proxy, no new workflow engine, and
no claim that a feedback acknowledgment proves a request was resolved. Each milestone needs its own scope decision,
acceptance criteria and verification before implementation.
