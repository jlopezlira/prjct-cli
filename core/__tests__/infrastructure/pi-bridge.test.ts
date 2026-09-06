import { describe, expect, it, spyOn } from 'bun:test'
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import { createServer, type Socket } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { hasPiBridge, installPiBridge, uninstallPiBridge } from '../../infrastructure/pi-bridge'
import { PRJCT_HOOKS } from '../../services/settings-installer'
import { sha256 } from '../../utils/hash'

const bridgePath = path.resolve(__dirname, '../../../templates/pi/bridge.mjs')
const bridge = import(bridgePath)
const { generateDaemonShim } = require('../../../scripts/build.js') as {
  generateDaemonShim: () => string
}
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

describe('pi hook transport through the published shim', () => {
  for (const failure of [
    'timeout',
    'retry',
    'disconnect',
    'malformed',
    'empty-object',
    'failed-response',
    'invalid-stdout',
  ]) {
    it(`preserves the payload and hook decision after daemon ${failure}`, async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-hook-shim-'))
      const sockets: Socket[] = []
      const server = createServer((socket) => {
        sockets.push(socket)
        socket.on('error', () => {})
        socket.on('data', () => {
          if (failure === 'retry') socket.end(`${JSON.stringify({ retry: true })}\n`)
          if (failure === 'disconnect') socket.destroy()
          if (failure === 'malformed') socket.end('not-json\n')
          if (failure === 'empty-object') socket.end('{}\n')
          if (failure === 'failed-response') socket.end('{"success":false}\n')
          if (failure === 'invalid-stdout')
            socket.end('{"success":true,"exitCode":0,"stdout":{}}\n')
        })
      })
      try {
        await fs.mkdir(path.join(dir, 'run'))
        await fs.writeFile(path.join(dir, 'prjct.mjs'), generateDaemonShim())
        // Only hook policy is stubbed; Pi, wire IO and stdin recovery are real.
        await fs.writeFile(
          path.join(dir, 'prjct-hooks.mjs'),
          `
          import fs from 'node:fs';
          import path from 'node:path';
          const run = path.join(process.env.PRJCT_CLI_HOME, 'run');
          const spill = fs.readdirSync(run).find(name => name.startsWith('hook-stdin-'));
          const payload = JSON.parse(fs.readFileSync(path.join(run, spill), 'utf8'));
          fs.unlinkSync(path.join(run, spill));
          process.stdout.write(JSON.stringify({ hookSpecificOutput: {
            additionalContext: JSON.stringify(payload), permissionDecision: 'deny'
          }}));
        `
        )
        await new Promise<void>((resolve) =>
          server.listen(path.join(dir, 'run/daemon.sock'), resolve)
        )
        const { runHook } = await bridge
        const payload = { prompt: 'sync "quoted"\nsecond line', cwd: dir, session_id: 'pi-session' }
        const result = await runHook(
          'prompt',
          payload,
          { ...ctx, cwd: dir },
          undefined,
          async (
            _bin: string,
            args: string[],
            options: { env: NodeJS.ProcessEnv; input: string }
          ) => {
            const child = spawn('node', [path.join(dir, 'prjct.mjs'), ...args], {
              cwd: dir,
              env: { ...options.env, PRJCT_CLI_HOME: dir, PRJCT_NO_DAEMON: '0' },
              stdio: ['pipe', 'pipe', 'pipe'],
              timeout: 3000,
            })
            const stdout: Buffer[] = []
            const stderr: Buffer[] = []
            child.stdout.on('data', (chunk) => stdout.push(chunk))
            child.stderr.on('data', (chunk) => stderr.push(chunk))
            child.stdin.end(options.input)
            return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
              child.on('error', reject)
              child.on('close', (code) => {
                if (code !== 0)
                  reject(new Error(`published hook exited ${code}: ${Buffer.concat(stderr)}`))
                else
                  resolve({
                    stdout: Buffer.concat(stdout).toString(),
                    stderr: Buffer.concat(stderr).toString(),
                  })
              })
            })
          }
        )
        expect(JSON.parse(result.hookSpecificOutput.additionalContext)).toEqual(payload)
        expect(result.hookSpecificOutput.permissionDecision).toBe('deny')
      } finally {
        for (const socket of sockets) socket.destroy()
        server.close()
        await fs.rm(dir, { recursive: true, force: true })
      }
    })
  }
})

describe('pi native lifecycle', () => {
  it('routes native calls to canonical hooks, blocks denied edits, and stamps only successful reads', async () => {
    const { registerLifecycle } = await bridge
    const handlers = new Map<
      string,
      (event: Record<string, unknown>, context: typeof ctx) => Promise<unknown>
    >()
    const calls: Array<{ sub: string; input: Record<string, unknown> }> = []
    const messages: unknown[] = []
    registerLifecycle(
      {
        on: (
          name: string,
          handler: (event: Record<string, unknown>, context: typeof ctx) => Promise<unknown>
        ) => handlers.set(name, handler),
        sendMessage: (message: unknown) => messages.push(message),
      },
      PRJCT_HOOKS,
      async (sub: string, input: Record<string, unknown>) => {
        calls.push({ sub, input })
        if (sub === 'pre-edit')
          return {
            hookSpecificOutput: {
              permissionDecision: 'deny',
              permissionDecisionReason: 'Read this source first',
            },
          }
        return { hookSpecificOutput: { additionalContext: 'Prior project decision' } }
      }
    )

    const start = await handlers.get('before_agent_start')!({ prompt: 'fix parser' }, ctx)
    expect(start).toMatchObject({ message: { content: 'Prior project decision' } })
    expect(calls.at(-1)).toMatchObject({
      sub: 'prompt',
      input: { prompt: 'fix parser', session_id: 'pi-session' },
    })
    const edit = await handlers.get('tool_call')!(
      { toolName: 'edit', input: { path: 'parser.ts', newText: 'x' } },
      ctx
    )
    expect(edit).toEqual({ block: true, reason: 'Read this source first' })
    expect(calls.at(-1)).toMatchObject({
      sub: 'pre-edit',
      input: { tool_name: 'Edit', tool_input: { path: 'parser.ts' } },
    })
    const before = calls.length
    await handlers.get('tool_result')!(
      { toolName: 'read', input: { path: 'parser.ts' }, isError: true },
      ctx
    )
    expect(calls).toHaveLength(before)
    await handlers.get('tool_result')!(
      { toolName: 'read', input: { path: 'parser.ts' }, isError: false },
      ctx
    )
    expect(calls.at(-1)?.sub).toBe('post-read')
    await handlers.get('tool_call')!({ toolName: 'grep', input: { pattern: 'parser' } }, ctx)
    expect(calls.at(-1)?.sub).toBe('pre-search')
    await handlers.get('agent_end')!({}, ctx)
    expect(calls.at(-1)?.sub).toBe('stop')
    expect(messages.length).toBeGreaterThan(0)
    expect(calls.some((call) => call.sub === 'ship')).toBe(false)
  })
})

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
    expect(args).toContain('--extension')
    expect(args).not.toContain('prjct_agent')
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
      async (
        _bin: string,
        argv: string[],
        options: { signal: AbortSignal; env: NodeJS.ProcessEnv }
      ) => {
        expect(options.signal).toBe(signal)
        expect(options.env.PI_SESSION_ID).toBeUndefined()
        expect(options.env.CODEX_SESSION_ID).toBeUndefined()
        expect(options.env.PRJCT_AGENT_RUNTIME).toBe('pi')
        expect(options.env.PRJCT_PI_DELEGATE).toBe('1')
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
  it('uninstalls only managed hooks, preserving customized bundles and the skill', async () => {
    const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-uninstall-'))
    const extension = path.join(agentDir, 'extensions', 'prjct')
    try {
      await installPiBridge(agentDir, { content: 'managed skill', acceptsExisting: () => false })
      const index = path.join(extension, 'index.ts')
      const original = await fs.readFile(index, 'utf8')
      await fs.writeFile(index, 'custom extension')
      await expect(uninstallPiBridge(agentDir)).rejects.toThrow('customized')
      expect(await fs.readFile(index, 'utf8')).toBe('custom extension')
      expect(await fs.stat(path.join(extension, 'bridge.mjs'))).toBeDefined()
      await fs.writeFile(index, original)
      await uninstallPiBridge(agentDir)
      expect(await hasPiBridge(agentDir)).toBe(false)
      expect(await fs.readFile(path.join(agentDir, 'skills', 'prjct', 'SKILL.md'), 'utf8')).toBe(
        'managed skill'
      )
      await uninstallPiBridge(agentDir)
    } finally {
      await fs.rm(agentDir, { recursive: true, force: true })
    }
  })

  it('installs canonical lifecycle configuration and recovers an interrupted upgrade', async () => {
    const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-retry-'))
    const extension = path.join(agentDir, 'extensions', 'prjct')
    const rename = fs.rename.bind(fs)
    try {
      await installPiBridge(agentDir)
      const hookConfig = JSON.parse(await fs.readFile(path.join(extension, 'hooks.json'), 'utf8'))
      expect(hookConfig).toEqual(PRJCT_HOOKS)
      const receiptPath = path.join(extension, 'managed.json')
      const receipt = JSON.parse(await fs.readFile(receiptPath, 'utf8'))
      for (const file of ['index.ts', 'bridge.mjs']) {
        await fs.writeFile(path.join(extension, file), `old managed ${file}`)
        receipt[file] = sha256(`old managed ${file}`)
      }
      await fs.writeFile(receiptPath, JSON.stringify(receipt))
      const failure = spyOn(fs, 'rename').mockImplementation(async (from, to) => {
        if (String(to) === path.join(extension, 'bridge.mjs'))
          throw new Error('simulated disk failure')
        return rename(from, to)
      })
      try {
        await expect(installPiBridge(agentDir)).rejects.toThrow('simulated disk failure')
      } finally {
        failure.mockRestore()
      }
      await installPiBridge(agentDir)
      expect(await fs.readFile(path.join(extension, 'bridge.mjs'), 'utf8')).toContain(
        'registerLifecycle'
      )
      expect(await fs.readFile(path.join(extension, 'index.ts'), 'utf8')).toContain(
        'registerLifecycle(pi, hooks)'
      )
    } finally {
      await fs.rm(agentDir, { recursive: true, force: true })
    }
  })

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
