import { describe, expect, it } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { installPiBridge } from '../../infrastructure/pi-bridge'

const bridgePath = path.resolve(__dirname, '../../../templates/pi/bridge.mjs')
const bridge = import(bridgePath)
const ctx = {
  cwd: '/project',
  model: { provider: 'test-provider', id: 'test-model' },
  thinkingLevel: 'high',
  sessionManager: { getSessionId: () => 'pi-session', getSessionFile: () => undefined },
}
const completed = [
  {
    type: 'message_end',
    message: {
      role: 'assistant',
      stopReason: 'stop',
      content: [{ type: 'text', text: 'Real findings' }],
    },
  },
  { type: 'agent_end' },
]
  .map((event) => JSON.stringify(event))
  .join('\n')

describe('pi bridge transport', () => {
  it('passes all verbs and hostile arguments as argv, never shell text', async () => {
    const { runCli } = await bridge
    const args = ['remember', 'context', '$(touch /tmp/never); "quote"', '--md']
    const result = await runCli(
      args,
      ctx,
      undefined,
      async (bin: string, argv: string[], options: { cwd: string; env: NodeJS.ProcessEnv }) => {
        expect(bin).toBe('prjct')
        expect(argv).toEqual(args)
        expect(options.cwd).toBe(ctx.cwd)
        expect(options.env.PRJCT_AGENT_RUNTIME).toBe('pi')
        return { stdout: 'stored', stderr: '' }
      }
    )
    expect(result.content[0].text).toBe('stored')
  })
  it('does not retry failed mutations', async () => {
    const { runCli } = await bridge
    const calls: string[] = []
    await expect(
      runCli(['ship'], ctx, undefined, async () => {
        calls.push('called')
        throw new Error('quality gate blocked')
      })
    ).rejects.toThrow('quality gate blocked')
    expect(calls).toHaveLength(1)
  })
  it('inherits the model, thinking and isolation; read-only is the default contract', async () => {
    const { childArgs } = await bridge
    const args = childArgs(ctx, '/tmp/task.txt', true)
    expect(args).toContain('test-model')
    expect(args).toContain('test-provider')
    expect(args).toContain('high')
    expect(args).toContain('--no-session')
    expect(args).toContain('--no-extensions')
    expect(args).toContain('--no-context-files')
    expect(args).toContain('read,grep,find,ls')
    expect(args).not.toContain('--continue')
    expect(args).not.toContain('--approve')
  })
  it('uses live session metadata rather than a parent session', async () => {
    const { sessionEnv } = await bridge
    expect(sessionEnv(ctx).PI_SESSION_ID).toBe('pi-session')
    expect(sessionEnv(ctx).PI_SESSION_FILE).toBeUndefined()
  })
  it('returns real reports, not ledger approval', async () => {
    const { runAgent } = await bridge
    const signal = new AbortController().signal
    const result = await runAgent(
      'Review bounded files',
      true,
      ctx,
      signal,
      async (_bin: string, argv: string[], options: { signal: AbortSignal }) => {
        expect(options.signal).toBe(signal)
        const promptFile = argv.at(-1)!.slice(1)
        expect(await fs.readFile(promptFile, 'utf8')).toContain('Review bounded files')
        return { stdout: completed }
      }
    )
    expect(result.content[0].text).toBe('Real findings')
    expect(result.details.independent).toBe(true)
  })
  it('rejects missing completion, provider errors and malformed streams', async () => {
    const { parseChildOutput } = await bridge
    expect(() => parseChildOutput('')).toThrow()
    expect(() => parseChildOutput('not json')).toThrow()
    expect(() => parseChildOutput(completed.replace('"stop"', '"error"'))).toThrow()
    expect(() => parseChildOutput(completed.split('\n')[0])).toThrow()
    expect(parseChildOutput(completed).text).toBe('Real findings')
  })
})

describe('pi bridge installer', () => {
  it('installs idempotently and preserves customizations and symlinks', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-bridge-test-'))
    try {
      await installPiBridge(home)
      const index = path.join(home, 'extensions', 'prjct', 'index.ts')
      const first = await fs.readFile(index, 'utf8')
      await installPiBridge(home)
      expect(await fs.readFile(index, 'utf8')).toBe(first)
      await fs.writeFile(index, 'custom')
      await expect(installPiBridge(home)).rejects.toThrow('customized')
      expect(await fs.readFile(index, 'utf8')).toBe('custom')
      await fs.unlink(index)
      const target = path.join(home, 'target')
      await fs.writeFile(target, 'user file')
      await fs.symlink(target, index)
      await expect(installPiBridge(home)).rejects.toThrow('non-regular')
      expect(await fs.readFile(target, 'utf8')).toBe('user file')
    } finally {
      await fs.rm(home, { recursive: true, force: true })
    }
  })
})
