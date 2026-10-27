/** Browser upload actions. File bytes and labels are sealed and available only to user actions. */
import { actionRef } from '../../../shared/extension-api.ts'
import type { SubmitRequest } from '../../../shared/protocol.ts'

export type UploadedFile = { id: string; name: string; size: number }
/** `{ token: client UUID, name, data: base64 }` → a server-generated durable file reference. */
export const UploadAction = actionRef<{ token: string; name: string; data: string }, UploadedFile>(
  'uploads',
  'upload',
)
/** Abandon an unsent reference; bytes remain available to copied drafts for the abandonment window. */
export const RemoveAction = actionRef<{ id: string }, { removed: boolean }>('uploads', 'remove')
/** Resolve file markers, pin bytes, then use the host's ordinary input admission path. */
export const SendAction = actionRef<
  SubmitRequest & { files: string[]; requestId: string },
  { submissionId: number }
>('uploads', 'send')
