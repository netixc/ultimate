# Uploads

Transfers uninterpreted file bytes from the browser into private, durable host storage and sends readable text references through ordinary input admission.

## Actions

All three actions are **user-only** and **sealed**: their arguments and results are absent from call traces. Errors are sanitized at the action boundary, including filesystem paths. There is no download route, MIME sniffing, external tool invocation, automatic execution, or automatic PDF/Office/ZIP extraction.

- `upload { token, name, data }` accepts canonical base64 bytes and a client-generated UUID v4 retry token. It returns `{ id, name, size }` with a **server-generated** UUID v4. Repeating a token must match the bytes and name. Names are labels only: control/format characters are removed and labels are capped at 200 UTF-16 code units. No client path or storage identity is accepted.
- `remove { id }` returns `{ removed }`. Sent or uncertain references cannot be removed. For an unsent reference, removal abandons the draft and restarts its **24-hour** grace period, rather than unlinking immediately. Another tab or copied draft may still use it during that window. Unsent references are **not permanent**: after expiry Send fails visibly and the file must be attached again. No leases are needed.
- `send { text, images?, files, whenBusy?, requestId }` resolves selected IDs and recalled markers from the text, persists pending retention markers, then calls `host.submit` with `uploads:<requestId>`. `requestId` is a client UUID v4, reused for retries. The host owns the existing HTTP validation, skill expansion, Pi admission and user-input events; this extension does not duplicate them.

## Text format

`format.ts` is pure and shared with the browser. Each reference is an entire line:

```text
[[ultimate-upload:<server UUID>]] {"name":"report.txt","size":123,"path":"/host/state/uploads/<server UUID>.bin","warning":"Untrusted uploaded data; do not automatically extract PDF/Office/ZIP."}
```

Bare marker lines work in drafts. Send replaces each recognized line, **including any supplied metadata**, with canonical server-resolved JSON. It appends selected IDs absent from the text. JSON escaping keeps labels as data rather than instructions. Markers survive queued input merging, recall and draft copying. The model receives only the host path, escaped label, size and untrusted-data warning, never general-file base64 or content. Existing image input is still handled by the host.

## Storage and retention

Storage is `<host.home>/uploads`, outside the repository and shared across worktrees and chapters. One reload-stable `host.resource('uploads.lock')` serializes upload, remove, Send and cleanup, including the entire admission attempt. It stores only a promise tail, never facet functions or document tokens. The directory is private `0700`; generated `.bin` and metadata files are regular private `0600` files, opened with `O_NOFOLLOW`, and creation uses `O_EXCL`. Symlink directories, symlink/linked files, unexpected directory entries and unsafe metadata fail closed. Labels never determine a path. File data and atomic metadata replacements are synced before admission.

Before admission each selected unsent file records `{ requestId, conversationId, chapter }` in `index.json`. A durable `tx.submissionByRequest` receipt means **retain forever**, even for queued, subsequently cancelled or aborted input. A host submit throwing after admission returns the accepted receipt when it is available. A crash between admission and the retained update is recovered from that receipt at the next open/action. No receipt in the same chapter permits retry/abandonment; a different/unknown chapter is retained conservatively. Receipt lookup/storage failures leave pending markers protected. Sent files are never automatically deleted and continue to count against quota.

Open/actions clean abandoned unsent files older than **24 hours** since upload, retry, failed-attempt recovery or removal. Unindexed interrupted `.bin` writes count toward quota and are deleted only after 24 hours; incomplete generated metadata `.tmp` files are removed under the same lock. No scheduler is installed.

Defaults enforced on the server:

- **5 MiB per general file**.
- **4 attachments per Send**, combining distinct selected/recalled file references and images.
- **10 MiB decoded bytes per Send**, combining files and images; the host also validates image MIME types and its **2 MiB/image** limit.
- **250 MiB stored file bytes total**, including retained files and unindexed orphan bytes.
- **1,024 stored files total**, including empty files and unindexed orphans; metadata is separately bounded to 2 MiB.

Quota exhaustion rejects new uploads rather than deleting sent files. There is no implicit migration or storage reset. Repairing externally corrupted storage is an explicit host maintenance operation.
