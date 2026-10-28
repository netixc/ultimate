Review published local HTML inside Ultimate, queue notes on elements or selected text, and explicitly send a feedback batch with reference images to the maker.

## Review

Open **Artifacts** in the surface switcher, or **Open review** on an `artifact_publish` card. The artifact is on the left; a real SDK **Conversation** is on the right. Its transcript is the complete destination conversation and may include unrelated work. The top bar holds **Issues**, **Annotate**, **Hide sidebar / Show sidebar**, and quiet artifact details. On phones the conversation becomes a bottom sheet, leaving part of the artifact visible; it starts hidden.

With **Annotate** on, hovering marks a target without opening an editor. Click an element or release a native text selection to open a compact anchored note card. The card follows the target after scrolling and stays within the visible viewport, including the software keyboard's visual viewport. Native keyboard selection is supported; physical long-press selection handles still need device verification. Turning Annotate off restores normal artifact interaction without discarding an open note. Hiding the conversation or clicking another target never replaces the unfinished editor.

The note card offers **Attach image**, **Cancel**, and **Queue**. Queue adds an ordinary unsent draft; it never sends or wakes the maker. Cancel discards just that unfinished note and its images. Queued notes remain editable in the right panel. Each note can have its own reference images, and general feedback can have general references. All pickers share the same limit: **four** decoded PNG, JPEG or WebP images totaling **8 MiB** across the batch. Encoded JSON size is checked before freezing a request.

**Send to Agent**, in the right-side composer, is the only admission action. It calls the durable Feedback action, not ordinary SDK chat submission. The composer replacement is scoped by local React context; other Ultimate conversations keep their normal composer. The review conversation also uses `ComposerRedirect` to reject ordinary admission if the SDK ever falls back to its default composer. Enter and Ctrl+Enter do not send the review batch. **Send to conversation** is editable and changes the real transcript shown in the panel.

**Receipts** opens saved feedback and actual delivery routes. It polls summaries only while open. Image bytes load only when a batch's details are explicitly expanded; closing details releases them. It shows the latest 50 batches without deleting older feedback. Receipts distinguish **Saved · delivery pending** from **Queued to inbox**, show the submission ID and actual reroute, and never claim the maker has read or fixed anything.

**Artifact details** contains the maker, original revision, local path and static-review policy. Authored scripts and network access are blocked. The opaque-origin viewer and annotation bridge live in `sandbox.ts`, `bridge.ts` and `viewer.tsx`; HTML is never inserted into Ultimate's trusted DOM.

## Measured layout issues

The Issues count comes from stored findings, never sample data. The bridge checks two families only: material page horizontal overflow and clipped/unreachable controls. Each finding carries its actual content-frame viewport, revision, rule, selector, axis and measured overflow. Incomplete checks remain visibly incomplete; zero findings is not a full layout or accessibility review. When fixed or absolutely positioned descendants cross a clipping ancestor, the check stays incomplete rather than guessing whether that ancestor clips them. Transforms or zoom at or above clipping/scrolling regions, non-default overflow clip margins, viewport-propagated root/body overflow, and overflow styling on inline or non-box ancestors also stay incomplete; their geometry is not used to invent defects.

**Reveal** only highlights and scrolls to the selector. **Dismiss** dismisses an observation for the displayed revision. **Select all** and individual selection are tab-local. **Queue selected fixes** creates one ordinary draft note containing `layoutIssueIds`; it does not send or mark issues fixed. A batch can reference at most 50 unique issues. The backend attaches immutable observation context to admitted feedback. Only a complete newer-content measurement at the same exact viewport can resolve an issue automatically.

## Drafts, refresh and delivery

Unsent work stays only in this browser tab's memory, including across surface switches and sidebar visibility changes. Only artifact selection uses shared shell UI state. A reload/close warning protects nonempty drafts but is not a durable-save guarantee.

Reads poll every two seconds while visible, sending the latest fetched hash, including a pending update. Unchanged responses carry metadata and source status, never HTML/assets, and never replace the iframe. Actual selection gestures, open review overlays and unfinished feedback defer new snapshots. Finish or remove drafts and close overlays to apply the latest revision automatically. Annotate being on does not itself block refresh. Each batch retains one original revision.

A send retains its exact request ID and payload until delivery is confirmed. An uncertain error keeps that stable batch for retry. A definitive HTTP 413 or the backend's pre-persistence `rejected: 'too-large'` result clears only the frozen request, preserving draft content so the user can correct it and send a fresh batch. Successful admission clears only submitted notes, images and unchanged general feedback; concurrent edits remain drafts. Concluded or unavailable destinations route through @ultimate, and receipts show the actual route.

## Native action contract

The shared backend owns validation, snapshots, storage and delivery. `server.ts` adapts:

- `list(null)` → `Artifact[]`.
- `read({ id, parentOrigin, knownHash? })` → `NativeDocument` or `{ unchanged: true, artifact, sourceError? }`.
- `feedback(FeedbackInput)` → one durable `FeedbackBundle`, or `{ rejected: 'too-large', message }` before persistence/admission; browser-only.
- `feedbackList({ artifactId })` → newest 50 `FeedbackSummary` records, without image bytes.
- `feedbackRead({ artifactId, id })` → one full batch for explicitly expanded receipt details.
- `layoutRead({ artifactId })` → `LayoutState`.
- `layoutPass(LayoutPassInput)` → measured `LayoutState`; browser-only.
- `layoutDismiss({ artifactId, issueId, contentHash })` → `LayoutState`; browser-only.

Frontend refs, local composer context and tab-local drafts live in `ui.tsx`. Artifact/feedback/layout types and the image-byte limit come from `../artifacts/types.ts`.
