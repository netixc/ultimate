import { writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { configure } from '@earendil-works/pi-durable'
import { fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux'
import { expect, it } from 'vitest'
import { context } from '../../../../server/harness.ts'
import { FEEDBACK_IMAGE_MAX_BYTES } from '../types.ts'
import type { Artifact, FeedbackBundle } from '../types.ts'
import { fauxServer, post, temp } from '../../../../test/helpers.ts'

it('saves the largest accepted reference image through the real action endpoint', async () => {
  const home = await temp('ultimate-artifacts-http-')
  const server = await fauxServer({ ultimateRoot: resolve('.'), home, userHome: home })
  try {
    const owner = await server.harness.createConversation(
      { ownership: { kind: 'ownerless' } },
      context,
    )
    const agent = await server.root.agent(context)
    await server.harness.commit(
      (tx) =>
        configure(tx, owner.id, { model: agent.model, tools: [], cwd: server.host.projectRoot }),
      context,
    )
    await writeFile(join(server.host.projectRoot, 'reference-proof.html'), '<h1>Review</h1>')
    const publish = await post(server, '/api/extensions/artifacts/actions/publish', {
      conversationId: owner.id,
      args: { id: 'http-proof', title: 'HTTP proof', path: 'reference-proof.html' },
    })
    expect(publish.status).toBe(200)
    const artifact = publish.data.result as Artifact
    const bytes = Buffer.alloc(FEEDBACK_IMAGE_MAX_BYTES)
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jf1sAAAAASUVORK5CYII=',
      'base64',
    ).copy(bytes)
    const request = {
      conversationId: owner.id,
      args: {
        artifactId: artifact.id,
        requestId: 'largest-http-reference',
        contentHash: artifact.contentHash,
        recipientConversation: owner.id,
        notes: [{ id: 'note', text: 'Review this reference.' }],
        images: [{ name: 'reference.png', mime: 'image/png', base64: bytes.toString('base64') }],
      },
    }
    server.host.faux!.setResponses([fauxAssistantMessage('Reference received.')])
    const result = await post(server, '/api/extensions/artifacts/actions/reviewFeedback', request)
    expect(result.status).toBe(200)
    const bundle = result.data.result as FeedbackBundle
    expect(bundle.state).toBe('delivered')
    expect(bundle.submissionId).toBeTypeOf('number')
    expect(Buffer.from(bundle.images[0].base64, 'base64').equals(bytes)).toBe(true)
    const saved = await post(server, '/api/extensions/artifacts/actions/feedbackRead', {
      conversationId: owner.id,
      args: { artifactId: artifact.id, id: bundle.id },
    })
    expect(saved.status).toBe(200)
    expect(saved.data.result.id).toBe(bundle.id)
    expect(saved.data.result.images[0].base64).toBe(bundle.images[0].base64)
  } finally {
    await server.close()
  }
})
