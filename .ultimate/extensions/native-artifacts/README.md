Review published local HTML inside Ultimate, attach notes to elements or selected text, and send feedback with reference images to the maker.

## Review

Open **Artifacts** in the surface switcher, or **Open review** on an `artifact_publish` card. The current document shows its maker, content revision and feedback destination. There is no version browser or variant selector.

The artifact is a static review, not a live app: authored scripts and network requests are blocked. The opaque-origin viewer and annotation bridge are implemented in `sandbox.ts`, `bridge.ts` and `viewer.tsx`; HTML is never inserted into Ultimate's trusted DOM.

- **Pick element** intercepts activation and captures an element for a note.
- **Select text** preserves browser selection. Select text first, then use **Note selected text**. On a phone, use native long-press and selection handles; capture before opening the editor.
- **Add note** adds to the tab's unsent **Drafts**, not to durable storage.
- General feedback and up to four PNG, JPEG or WebP reference images (10 MiB total) join the same batch.
- **Send feedback** uses the shared artifact service. A positive conversation number overrides the published destination; concluded or unavailable destinations route through @ultimate.

On desktop the artifact and feedback are side by side; the conversation can be opened in the native dock. Narrow windows use a full-width artifact/feedback switch. Artifact selection and narrow-view navigation use shell UI state. Unsent work stays only in this browser tab's memory, including across surface switches. A reload/close warning protects nonempty drafts; it is not a durable-save guarantee.

## Refresh and delivery

The UI polls the native adapters every two seconds while visible. Reads send the latest fetched hash, including a pending update, so unchanged polls return only metadata and source status rather than HTML or assets. Identical content hashes never replace the displayed iframe. A newer revision waits while annotation mode, an unfinished note or any unsent batch is active. Finish or remove drafts and exit annotation mode to let the latest revision apply automatically. This keeps every batch on one original revision.

A send retains its exact request ID and payload until delivery is confirmed. Retrying an uncertain send cannot silently change its recipient or content. New edits remain drafts; a delivered acknowledgement clears only the submitted notes, images and unchanged general feedback. Durable history shows the original revision, actual route, and either **Saved · delivery pending** or **Queued to inbox**, with the durable submission receipt. Neither state claims that the maker has read or implemented the feedback.

## Native action contract

The shared backend owns validation, snapshots, storage and delivery. `server.ts` adapts:

- `list(null)` → `Artifact[]`.
- `read({ id, parentOrigin, knownHash? })` → `NativeDocument` containing a passive `srcdoc`, random bridge channel, artifact and optional retained-source error; or `{ unchanged: true, artifact, sourceError? }` when the latest fetched hash still matches.
- `feedback(FeedbackInput)` → durable `FeedbackBundle`; browser-only.
- `feedbackList({ artifactId })` → durable batch summaries including delivery state and image metadata, never image bytes.
- `feedbackRead({ artifactId, id })` → one full batch, loaded only while its history details are explicitly open. Closing details releases the loaded images; image bytes are never polled.

Frontend action refs and tab-local drafts live in `ui.tsx`. Artifact and feedback types are imported type-only from `../artifacts/types.ts`.
