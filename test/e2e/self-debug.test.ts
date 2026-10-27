import { execFileSync, spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { sourceCopy, cleanEnv, until, temp, removeTemp } from '../helpers.ts'

it('terminates an isolated instance after its owner is SIGKILLed', async () => {
  const home = await temp('ultimate-owner-test-')
  const ultimateRoot = await sourceCopy(home)
  const resultPath = join(home, 'instance.json')
  const environmentPath = join(home, 'environment.json')
  const environmentKeys = [
    'ULTIMATE_SUPERVISED',
    'ULTIMATE_PUBLIC_URL',
    'ULTIMATE_GENERATION',
    'ULTIMATE_PREVIOUS_BUILD',
    'ULTIMATE_HOME',
    'ULTIMATE_PORT',
    'ULTIMATE_NO_OPEN',
    'ULTIMATE_INSTANCE_OWNER',
    'ANTHROPIC_API_KEY',
    'HTTPS_PROXY',
    'NODE_EXTRA_CA_CERTS',
    'ULTIMATE_CHROMIUM',
  ]
  // Read the actual child's environment from inside that child, without Linux-only /proc or ps's lossy formatting.
  const probe = join(ultimateRoot, 'extensions/environment-probe')
  await mkdir(probe)
  await writeFile(
    join(probe, 'server.ts'),
    `import { writeFile } from 'node:fs/promises'
export default function environmentProbe(host) {
  host.onOpen(async () => {
    if (process.env.ULTIMATE_INSTANCE_OWNER)
      await writeFile(${JSON.stringify(environmentPath)}, JSON.stringify(Object.fromEntries(
        ${JSON.stringify(environmentKeys)}.map(key => [key, process.env[key]])
      )))
  })
  return { name: 'environment-probe' }
}
`,
  )
  // Faux previews publish on Tailscale; keep this one off the machine's real tailnet.
  await mkdir(join(home, '.ultimate'), { recursive: true })
  await writeFile(
    join(home, '.ultimate/settings.json'),
    JSON.stringify({ extensions: { disable: ['tailscale'] } }),
  )
  const code = `
    import {createServer} from './server/main.ts';
    import {context} from './server/harness.ts';
    import {fauxAssistantMessage,fauxProvider,fauxToolCall} from '@earendil-works/pi-ai/providers/faux';
    import {writeFile} from 'node:fs/promises';
    const server = await createServer({ultimateRoot:process.cwd(),projectRoot:process.cwd(),userHome:${JSON.stringify(home)},home:${JSON.stringify(home)},faux:fauxProvider(),port:0});
    server.host.faux.setResponses([fauxAssistantMessage([fauxToolCall('instance',{action:'start'})],{stopReason:'toolUse'}),fauxAssistantMessage('Complete')]);
    await (await server.root.submit({type:'input',content:'start'},context)).wait(context);
    const view = await server.root.viewState(context);
    const result = view.value.entries.findLast(e => e.kind === 'pi.tool-result').model[0];
    await writeFile(${JSON.stringify(resultPath)}, result.content.find(p => p.type === 'text').text);
  `
  const owner = spawn(process.execPath, ['--input-type=module', '-e', code], {
    cwd: ultimateRoot,
    env: {
      ...cleanEnv({ HOME: home }),
      ULTIMATE_HOME: home,
      ULTIMATE_PORT: '12345',
      ULTIMATE_PUBLIC_URL: 'http://parent.invalid',
      ULTIMATE_GENERATION: '99',
      ANTHROPIC_API_KEY: 'instance-test-key',
      HTTPS_PROXY: 'http://proxy.invalid:8080',
      NODE_EXTRA_CA_CERTS: '/etc/ssl/certs/ca-certificates.crt',
      ULTIMATE_CHROMIUM: '/instance-test/chromium',
      ULTIMATE_SUPERVISED: '1',
      ULTIMATE_PREVIOUS_BUILD: 'null',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  owner.stderr.on('data', (chunk) => {
    output += chunk
  })
  let instance: { pid: number; home: string; url: string } | undefined
  try {
    await until(async () => {
      try {
        instance = JSON.parse(await readFile(resultPath, 'utf8'))
      } catch {
        /* booting */
      }
      if (owner.exitCode !== null) throw new Error(output)
      return !!instance
    }, 60000)
    expect(instance?.pid).toBeGreaterThan(0)
    const port = Number(new URL(instance!.url).port)
    expect(port).toBeGreaterThan(0)
    expect(port).toBeLessThanOrEqual(65535)
    const env = JSON.parse(await readFile(environmentPath, 'utf8'))
    expect(env).not.toHaveProperty('ULTIMATE_SUPERVISED')
    expect(env).not.toHaveProperty('ULTIMATE_PUBLIC_URL')
    expect(env).not.toHaveProperty('ULTIMATE_GENERATION')
    expect(env).not.toHaveProperty('ULTIMATE_PREVIOUS_BUILD')
    expect(env).toMatchObject({
      ULTIMATE_HOME: instance!.home,
      ULTIMATE_PORT: '0',
      ULTIMATE_NO_OPEN: '1',
      ULTIMATE_INSTANCE_OWNER: String(owner.pid),
      ANTHROPIC_API_KEY: 'instance-test-key',
      HTTPS_PROXY: 'http://proxy.invalid:8080',
      NODE_EXTRA_CA_CERTS: '/etc/ssl/certs/ca-certificates.crt',
      ULTIMATE_CHROMIUM: '/instance-test/chromium',
    })
    const exited = once(owner, 'exit')
    owner.kill('SIGKILL')
    await exited
    await until(async () => {
      try {
        return execFileSync('ps', ['-o', 'stat=', '-p', String(instance!.pid)], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        })
          .trim()
          .startsWith('Z')
      } catch (error) {
        // ps exits 1 once the process is gone; other failures must fail the test.
        if ((error as { status: number }).status === 1) return true
        throw error
      }
    }, 5000)
  } finally {
    if (owner.exitCode === null && owner.signalCode === null) {
      const exited = once(owner, 'exit')
      owner.kill('SIGKILL')
      await exited
    }
    if (instance) {
      try {
        process.kill(instance.pid, 'SIGKILL')
      } catch {
        /* already exited */
      }
      await removeTemp(instance.home)
    }
    await removeTemp(home)
  }
}, 90000)
