Review published local HTML inside Ultimate, annotate elements or selected text naturally, and send feedback with reference images to the maker.

## Review

Open **Artifacts** in the surface switcher, or **Open review** on an `artifact_publish` card. The artifact takes the available screen; there is no permanent feedback column, metadata slab, or separate element/text mode.

Click an element or drag over text to open the same compact note dialog. Native keyboard text selection also captures a text target. On a phone, native selection handles are supported by the bridge, but physical long-press behavior needs device verification. Closing the dialog keeps the unfinished note; **Feedback → Continue selected note** returns to it. **Add note** puts it in the tab's unsent drafts; **Discard** removes that unfinished note.

**Feedback** opens the composer only when requested: review notes, write general feedback, attach reference images, and send the batch. Destination is editable under **To…**. Up to four decoded PNG, JPEG or WebP reference images may total **8 MiB**. This leaves headroom for base64 and notes inside the existing HTTP request limit. Reference-image limits share the backend's `FEEDBACK_IMAGE_MAX_BYTES` constant.

**History** opens saved feedback and proper delivery receipts. It polls summaries only while open. Full image bytes load only when a batch's details are explicitly expanded; closing details releases them. History shows the latest 50 batches without deleting older feedback. Receipts from another revision say **Earlier revision · recheck targets**, not that a target has definitely changed.

**Artifact details** holds maker, original revision, local path, editable destination and static-review policy. Authored scripts and network access are blocked. The opaque-origin viewer and annotation bridge live in `sandbox.ts`, `bridge.ts` and `viewer.tsx`; HTML is never inserted into Ultimate's trusted DOM.

## Drafts, refresh and delivery

Unsent work stays only in this browser tab's memory, including across surface switches and dialog dismissal. Only artifact selection uses shared shell UI state. A reload/close warning protects nonempty drafts, but is not a durable-save guarantee.

Reads poll every two seconds while visible, sending the latest fetched hash, including a pending update. Unchanged responses carry only metadata and source status, never HTML/assets, and never replace the iframe. Actual selection gestures, open dialogs and unfinished feedback defer new snapshots. Finish or remove drafts and close the dialog to apply the latest revision automatically. Default annotation mode itself never blocks refresh. Each batch retains one original revision.

A send retains its exact request ID and payload until delivery is confirmed. An uncertain error keeps that stable batch for retry. A definitive HTTP 413 clears only the frozen request, preserving all draft content so the user can correct it and send a fresh batch. Successful admission clears only the submitted notes, images and unchanged general feedback; concurrent edits remain drafts. Receipts say **Saved · delivery pending** or **Queued to inbox** with a submission receipt, never that the maker has read or implemented the feedback. Concluded or unavailable destinations route through @ultimate.

## Native action contract

The shared backend owns validation, snapshots, storage and delivery. `server.ts` adapts:

- `list(null)` → `Artifact[]`.
- `read({ id, parentOrigin, knownHash? })` → `NativeDocument` or `{ unchanged: true, artifact, sourceError? }`.
- `feedback(FeedbackInput)` → one durable `FeedbackBundle`; browser-only.
- `feedbackList({ artifactId })` → newest 50 `FeedbackSummary` records, without image bytes.
- `feedbackRead({ artifactId, id })` → one full batch, only for explicitly expanded history details.

Frontend refs and tab-local drafts live in `ui.tsx`. Artifact/feedback types and the image-byte limit come from `../artifacts/types.ts`.
