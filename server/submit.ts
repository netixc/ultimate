import type { Context } from '@earendil-works/chord'
import type { ConversationId, Harness } from '@earendil-works/pi-durable'
import type { SubmitRequest, SubmitResponse } from '../shared/protocol.ts'
import { imageMimeTypes, maxImageBytes, maxImages } from '../shared/protocol.ts'
import { UserInputEvent } from '../shared/events.ts'
import type { Device } from '../shared/events.ts'
import { emit } from './events.ts'
import type { PreparedHost } from './harness.ts'
import { expandSkillCommand } from './skills.ts'

export type SubmitContext = { context: Context; device?: Device }

/** Input validation errors retain their HTTP status on the core submit route. */
export class SubmitError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

/** Admit typed user input through the same path for HTTP and trusted server extensions. */
export async function submitInput(
  host: Pick<PreparedHost, 'projectRoot' | 'skills'>,
  harness: Harness,
  conversationId: number,
  data: SubmitRequest | Record<string, unknown>,
  { context, device }: SubmitContext,
): Promise<SubmitResponse> {
  if (!Number.isSafeInteger(conversationId) || conversationId < 1)
    throw new SubmitError(400, 'Invalid conversation id')
  const conversation = await harness.conversation(conversationId as ConversationId, context)
  if (!conversation) throw new SubmitError(404, 'Unknown conversation')
  if (
    data.requestId !== undefined &&
    (typeof data.requestId !== 'string' || !data.requestId.trim() || data.requestId.length > 128)
  )
    throw new SubmitError(400, 'Invalid requestId')
  if (data.whenBusy !== undefined && data.whenBusy !== 'steer' && data.whenBusy !== 'followUp')
    throw new SubmitError(400, 'Invalid whenBusy')
  if (typeof data.text !== 'string') throw new SubmitError(400, 'Expected text')
  const length = data.text.length
  const images = data.images === undefined ? [] : data.images
  if (!Array.isArray(images)) throw new SubmitError(400, 'Expected images array')
  if (images.length > maxImages) throw new SubmitError(413, `At most ${maxImages} images`)
  const blocks = images.map((image: unknown) => {
    if (!image || typeof image !== 'object') throw new SubmitError(400, 'Invalid image')
    const { data: encoded, mimeType } = image as Record<string, unknown>
    if (
      typeof mimeType !== 'string' ||
      !imageMimeTypes.includes(mimeType) ||
      typeof encoded !== 'string' ||
      !encoded ||
      encoded.length % 4 !== 0 ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)
    )
      throw new SubmitError(400, 'Expected supported image MIME type and base64 data')
    if (Buffer.byteLength(encoded, 'base64') > maxImageBytes)
      throw new SubmitError(413, 'Image exceeds 2 MiB')
    if (Buffer.from(encoded, 'base64').toString('base64') !== encoded)
      throw new SubmitError(400, 'Invalid image base64 data')
    return { type: 'image' as const, data: encoded, mimeType }
  })
  if (!data.text.trim() && !blocks.length) throw new SubmitError(400, 'Expected text or images')
  // `/skill:name args` sends the skill's instructions with the request, as Pi does.
  const expanded = data.text.startsWith('/skill:')
    ? expandSkillCommand(
        data.text,
        host.skills((await conversation.agent(context)).cwd ?? host.projectRoot),
      )
    : data.text
  const content = blocks.length
    ? [...(expanded.trim() ? [{ type: 'text' as const, text: expanded }] : []), ...blocks]
    : expanded
  const submission = await conversation.submit(
    { type: 'input', content, whenBusy: data.whenBusy, requestId: data.requestId },
    context,
  )
  // Pi admits the input in a commit with no hook for steers and follow-ups, so the event commits right
  // after it: a crash in between loses the event, never the input. A retry records another event, not another input.
  const admitted = await submission.status(context)
  await harness.commit(
    (tx) =>
      emit(tx, UserInputEvent, {
        conversation: conversation.id,
        kind:
          admitted.status !== 'queued'
            ? 'prompt'
            : data.whenBusy === 'steer'
              ? 'steer'
              : 'follow-up',
        ...(admitted.entry === undefined
          ? { submission: submission.id }
          : { entry: admitted.entry }),
        length,
        ...device,
      }),
    context,
  )
  return { submissionId: submission.id }
}
