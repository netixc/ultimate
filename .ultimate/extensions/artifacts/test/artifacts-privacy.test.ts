import { writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { configure } from '@earendil-works/pi-durable'
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import { expect, it } from 'vitest'
import { context } from '../../../../server/harness.ts'
import type { Artifact, FeedbackBundle, LayoutState } from '../types.ts'
import { fauxServer, post, temp } from '../../../../test/helpers.ts'

it('keeps human artifact feedback and measurements out of the complete action trace tree', async () => {
  const home = await temp('ultimate-artifacts-privacy-')
  const server = await fauxServer({ ultimateRoot: resolve('.'), home, userHome: home })
  try {
    expect(server.extensions.info().filter((entry) => entry.name === 'native-artifacts')).toEqual(
      [],
    )
    expect(
      server.extensions.info().find((entry) => entry.name === 'artifacts')?.server?.error,
    ).toBeUndefined()
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
    await writeFile(join(server.host.projectRoot, 'privacy.html'), '<h1>Static review</h1>')
    const published = await post(server, '/api/extensions/artifacts/actions/publish', {
      conversationId: owner.id,
      args: { id: 'privacy-proof', title: 'Privacy proof', path: 'privacy.html' },
    })
    expect(published.status).toBe(200)
    const artifact = published.data.result as Artifact
    const call = async (action: string, args: unknown) => {
      const response = await post(server, `/api/extensions/artifacts/actions/${action}`, {
        conversationId: owner.id,
        args,
      })
      expect(response.status).toBe(200)
      return response.data.result
    }
    const selector = '#SYNTHETIC_PRIVATE_SELECTOR'
    const measured = (await call('layoutPass', {
      artifactId: artifact.id,
      contentHash: artifact.contentHash,
      viewport: { width: 390, height: 844 },
      complete: true,
      findings: [{ rule: 'clipped-control', selector, axis: 'horizontal', overflowPx: 21 }],
    })) as LayoutState
    expect(measured.issues).toHaveLength(1)
    await call('layoutDismiss', {
      artifactId: artifact.id,
      issueId: measured.issues[0].id,
      contentHash: artifact.contentHash,
    })
    const note = 'SYNTHETIC_PRIVATE_NOTE'
    const image = Buffer.from('SYNTHETIC_PRIVATE_IMAGE').toString('base64')
    server.host.faux!.setResponses([
      fauxAssistantMessage('Review queued.'),
      fauxAssistantMessage('Review queued.'),
    ])
    for (const action of ['feedback', 'reviewFeedback']) {
      const bundle = (await call(action, {
        artifactId: artifact.id,
        requestId: `privacy-${action}`,
        contentHash: artifact.contentHash,
        recipientConversation: owner.id,
        notes: [{ id: 'private-note', text: note, layoutIssueIds: [measured.issues[0].id] }],
        images: [{ name: 'reference.png', mime: 'image/png', base64: image }],
      })) as FeedbackBundle
      expect(bundle.state).toBe('delivered')
      expect(bundle.images[0].base64).toBe(image)
      const saved = await call('feedbackRead', { artifactId: artifact.id, id: bundle.id })
      expect(saved.images[0].base64).toBe(image)
    }
    const protectedActions = ['feedback', 'reviewFeedback', 'layoutPass', 'layoutDismiss']
    await server.harness.waitForIdle(context)
    server.host.faux!.setResponses([
      fauxAssistantMessage(
        [
          fauxToolCall('codemode', {
            code: `const errors = []; for (const action of ${JSON.stringify(protectedActions)}) { try { await ultimate.action('artifacts', action, {}); } catch (error) { errors.push(error.message); } } return errors;`,
          }),
        ],
        { stopReason: 'toolUse' },
      ),
      fauxAssistantMessage('Permission checks complete.'),
    ])
    await server.root.submit(
      { type: 'input', content: 'Check artifact action permissions.' },
      context,
    )
    await server.harness.waitForIdle(context)
    const view = await server.root.viewState(context)
    try {
      const entry = view.value.entries.findLast((item) => item.kind === 'pi.tool-result')!
      const result = entry.model![0]
      expect(result).toMatchObject({
        role: 'toolResult',
        details: {
          value: protectedActions.map((action) => `artifacts/${action} is a user-only action`),
        },
      })
    } finally {
      view.dispose()
    }
    const actionNames = [...protectedActions, 'feedbackRead'].map((action) => `artifacts/${action}`)
    const actions = server.extensions.trace
      .query({})
      .filter((row) => row.kind === 'action' && actionNames.includes(row.name))
    expect(actions).toHaveLength(6)
    for (const row of actions) {
      expect(row.ok).toBe(true)
      expect(row.args).toBeUndefined()
      expect(row.result).toBeUndefined()
      const tree = server.extensions.trace.tree(row.trace)
      expect(tree.length).toBeGreaterThan(0)
      const serialized = JSON.stringify(tree)
      for (const value of [note, image, selector]) expect(serialized).not.toContain(value)
      expect(serialized).not.toContain('artifacts.feedback')
      expect(serialized).not.toContain('artifacts.layoutPass')
    }
  } finally {
    await server.close()
  }
})
