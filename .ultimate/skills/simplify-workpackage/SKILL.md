---
name: simplify-workpackage
description: Simplify a named, completed Ultimate workpackage only when explicitly invoked for an immutable commit range and a coherent neighboring scope. Use for a requested post-workpackage simplification pass, never as automatic cleanup or a full-repository audit.
---

# Simplify one workpackage

Make the completed work easier to understand and maintain, without losing its intent or silently deleting
functionality. This is an optional project workflow, not a new default review round. The coordinator owns the
scope, decisions and final verdict; reuse the existing reviewer and lander, not a new agent or tool.
When invoked in @ultimate, send the bounded task to a coordinator branch rather than editing product code there.
Paths below are relative to the repository root.

## Establish the boundary

Start with the named workpackage, its acceptance criteria and an immutable full-SHA `base..head` range.
Identify the changed files and the coherent neighboring callers, contracts and tests needed to understand them.
If the range or scope is missing or ambiguous, ask before proceeding. Do not substitute the current branch tip,
expand into a repository-wide cleanup, or treat unrelated defects as permission to fix them.

Read `AGENTS.md`, relevant project memories and local guidance. Read each affected file fully before editing,
not just the diff. Trace callers, invariants, tests, public APIs and persisted or protocol contracts, including
unchanged code that makes the design safe. Establish what behavior must remain and what decisions were deliberate.

Follow the coordinator's normal assessment and implementation-go rules. If the invocation already authorizes
implementation, do not ask for the same go again; it still does not authorize significant removals below.
For larger refactors, features or experiments, follow the project's GitHub policy and use a PR before main
integration. Small approved fixes and documentation may go directly to main under the standing authorization.

## Find the direct design

Optimize for a coherent, maintainable design, not the smallest diff or fewest lines. Ask whether a reader can
follow the work without carrying needless indirection or state in their head. Favor existing layers, installed
dependencies and platform features over new machinery.

Look for trivial wrappers that obscure their only operation, real duplication that belongs at an existing layer,
and flexibility with no actual consumer or contract. Reduce excess state, booleans and branching; use TypeScript
to make invalid states unrepresentable where it genuinely simplifies callers. Question defensive checks inside
trusted code when no boundary or invariant requires them, but prove that premise before changing validation.

Keep comments that explain intent, constraints or non-obvious invariants. Remove comments that merely restate
the code. Do not replace a small local problem with a generic framework, clever compression or a new abstraction
that is harder to follow. A longer direct implementation can be simpler than a shorter indirect one.

## Ask before significant removals

Before each significant or potentially intentional removal, present a decision through @ultimate and wait for
explicit approval. Separate decisions when their tradeoffs differ; do not hide several behavior changes behind
one cleanup approval. For each, explain:

- What would change and why it appears unnecessary, citing the code or contract.
- Effects on behavior, compatibility, extensibility, validation and failure handling, including what is lost.
- The simpler replacement, your recommendation and the option to keep the current design.

Significant includes a user-visible workflow; public API, persisted format, protocol or backward compatibility;
validation, authorization, security, recovery, retry, fallback or error handling; a deliberate or multi-consumer
abstraction or extension point; tested or documented functionality; and anything whose purpose or invariant is
uncertain. If unsure, ask. Never delete something merely because a local search finds no callers: check public,
generated, plugin and compatibility roles first.

After implementation go, routine, proven behavior-preserving cleanup needs no individual removal approval:
a single-use trivial helper, a branch proven unreachable by types, or newly introduced duplication can be cleaned
up within the agreed scope. This exception is not permission to remove a deliberate contract or failure path.
Record the invariants that make the cleanup equivalent, and stop if the evidence contradicts them.

## Implement and verify

Make the smallest coherent set of changes that realizes the approved design. Do not weaken tests to make a
simplification pass; update them only for equivalent structure or explicitly approved behavior. Preserve the
project's test policy: committed coverage for core behavior and actual regressions, other edge cases proven once.
Leave unrelated cleanup out and report discoveries rather than broadening the workpackage.

Run the repository's required checks and relevant tests, and verify visible changes using the existing UI skills.
Inspect the final diff for remaining complexity, duplication, indirection, defensive branches and accidental
behavior changes. Green checks are necessary, not sufficient: explain why the design is simpler and why its
invariants still hold.

Use the existing independent review flow where the coordinator workflow calls for it. Give `agents/reviewer.md`
an immutable full-SHA `base..head` range for this pass and its acceptance criteria; it leads the configured team,
including the read-only `.ultimate/agents/reviewer-simplicity.md`. Do not add another routine simplicity round,
turn that reviewer into an editor, or accept its verdict in place of the coordinator's judgment. Resolve findings
within scope and reverify changed work.

Commit the verified result and use actual `workspace submit` with the divergence string. Verify the effective
project lander checks and push configuration as described in `skills/integrate-ultimate/SKILL.md`; a file on disk
alone is not proof. Inspect the real landing/check/push receipts and confirm the remote branch SHA equals the
landed SHA, or contains it if the remote advanced. Do not call manual tests plus a push a lander, bypass failed
gates, or report a local-only landing as checked-and-pushed delivery. Already-authorized routine steps need no
new permission; real scope, removal, UI approval and safety boundaries remain unchanged.

## Report the outcome

Summarize what became simpler, the invariants relied on and any significant removals left untouched because
they lacked approval. Name approved behavior changes separately from behavior-preserving cleanup. Give actual
validation results and limits, review evidence where applicable, the landed SHA and check/push/remote evidence.
State divergence from the requested workpackage, or `None` when it matches. If delivery failed, say where and
what remains; never substitute green checks for a design argument or a completed delivery receipt.
