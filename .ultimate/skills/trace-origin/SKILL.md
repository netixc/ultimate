---
name: trace-origin
description: Trace a file, skill, agent definition, memory or setting back to the input that created it (the user's message, a dream decision, a goal, another project's request) and explain why it exists. Use when someone asks where something came from, who asked for it, or why it was added.
---

# Trace where something came from

Everything an agent changes leaves a chain: commit → conversation → its intent and who started it → the input
in the parent that led to it. Follow it to the first human or automatic decision, then report the chain.

## 1. From the file to a conversation

```bash
git log --follow --format='%h %ad %s | conv=%(trailers:key=Ultimate-Conversation,valueonly,separator=)' --date=short -- <path>
```

The oldest commit created it; later ones changed it. A memory has no file: read it with `memory {read: slug}`, and
its `source` (`#conversation/entry`) is the starting point.

## 2. From the conversation to its intent

The conversation may live in an earlier chapter: in codemode, try `ultimate.entries(id)` and then
`ultimate.entries(id, {chapter})` for each chapter name from `ultimate.conversations` errors or the handoff.
Search `ultimate.search('"branch":<id>', {chapter})` for a stored `lineage.branched` entry with `data.branch === id`.
Stored entries differ from the emitted event (`{id, from, at, intent}`): their data has `{branch, at, intent, from?}`.
The fork source is `data.from ?? entry.conversationId`; `data.at` is the fork point in that source, not the requester's
input. The root marker's visible text names the requester separately: `started by #<requester> from #<source>/<at>`.
If it does not name one, find the branch call in stored history; do not assume the fork source requested the work.

## 3. From the intent to the decision

Read the requester's entries around the branch's creation (`ultimate.entries(requester, {before, limit: 40, chapter})`);
page back to its triggering input or recorded decision. Do not use the fork point as the requester's entry boundary.

- an actual user input or question-card answer (`1a. …` lines): quote the request, or name the question and option;
  check provenance, since a branch's agent-supplied prompt can also be stored as `pi.user`;
- a `dream.*` entry or a branch prompt saying "from dream session N": find the proposal and pass report
  (`subagents.report` of the `dream-pass`), then trace any implementation approval to its recorded source;
- an automation trigger or `goal` decision: quote the recorded trigger or reason and its authorized scope;
- a message from another project's @ultimate: follow it to the originating input or recorded automatic decision.

Repeat steps 2–3 through agent requests until you reach the actual user input or recorded automatic decision.
A recommended pick, tally or branch prompt alone is not user approval. A batch or indirect go counts only when its
recorded source covers this work; if that source cannot be found, report the approval as unproven.

## 4. Report

One short chain, newest to oldest, each step with its `#conversation/entry` link or sha, then one plain line:
who decided and why. Distinguish the requester from the fork source and point. If approval was indirect, cite the
recorded batch or delegated go and its scope; never turn a recommended pick into a yes.
