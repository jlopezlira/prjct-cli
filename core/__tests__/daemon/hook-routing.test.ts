/**
 * Daemon hook-routing contract.
 *
 * Hooks can run two ways now: the cold process path (reads process.stdin,
 * writes process.stdout, awaits afterEmit) and the warm daemon path (input
 * injected via HookIo, output captured to a sink, afterEmit detached). The
 * client writes the daemon's captured output RAW, so the two paths MUST emit
 * byte-identical JSON for the same input — otherwise daemon-served hooks
 * would silently inject different context than cold ones.
 *
 * These tests pin: (1) byte-parity between the two modes, (2) fail-soft in
 * io mode (a throwing build still emits `{}`), (3) afterEmit is detached (not
 * awaited) in io mode, and (4) the registry exposes every installed hook.
 */

import { describe, expect, spyOn, test } from 'bun:test'
import { type HookIo, type RunHookOptions, runHook } from '../../hooks/_runner'
import { HOOK_RUNNERS } from '../../hooks/registry'

/** Capture process.stdout while running the cold path with stdin forced to
 *  TTY (so readStdinSafe returns `{}` immediately — no hang). */
async function coldOutput(opts: RunHookOptions<unknown>): Promise<string> {
  const writes: string[] = []
  const spy = spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => {
    writes.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8'))
    return true
  }) as typeof process.stdout.write)
  const originalIsTTY = process.stdin.isTTY
  Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true })
  try {
    await runHook(opts)
  } finally {
    Object.defineProperty(process.stdin, 'isTTY', { value: originalIsTTY, configurable: true })
    spy.mockRestore()
  }
  return writes.join('')
}

/** Run the warm (daemon) path with an injected input, capturing the sink. */
async function warmOutput(
  opts: RunHookOptions<unknown>,
  input: unknown
): Promise<{ out: string; pendingAfterEmit: number }> {
  const chunks: string[] = []
  const pending: Array<() => Promise<void>> = []
  const io: HookIo = {
    input,
    sink: (chunk) => {
      chunks.push(chunk)
    },
    detachAfterEmit: (fn) => {
      pending.push(fn)
    },
  }
  await runHook(opts, io)
  return { out: chunks.join(''), pendingAfterEmit: pending.length }
}

describe('hook routing — process/daemon parity', () => {
  test('both modes emit byte-identical JSON for the same (empty) input', async () => {
    const opts: RunHookOptions<{ x?: number }> = {
      event: 'UserPromptSubmit',
      build: async (input) => `value:${input?.x ?? 'none'}`,
    }
    const cold = await coldOutput(opts as RunHookOptions<unknown>)
    // Cold path reads `{}` from the forced-TTY stdin, so input.x is undefined.
    const { out: warm } = await warmOutput(opts as RunHookOptions<unknown>, {})
    expect(warm).toBe(cold)
    expect(warm.endsWith('\n')).toBe(true)
    expect(() => JSON.parse(warm.trim())).not.toThrow()
  })

  test('io mode threads the injected input into build (daemon stdin forwarding)', async () => {
    const opts: RunHookOptions<{ prompt?: string }> = {
      event: 'UserPromptSubmit',
      build: async (input) => (input?.prompt ? `got:${input.prompt}` : null),
    }
    const { out } = await warmOutput(opts as RunHookOptions<unknown>, { prompt: 'hello' })
    expect(out).toContain('got:hello')
  })

  test('io mode is fail-soft — a throwing build still emits {}', async () => {
    const opts: RunHookOptions<unknown> = {
      event: 'Stop',
      build: async () => {
        throw new Error('boom')
      },
    }
    const { out } = await warmOutput(opts, {})
    expect(out).toBe('{}\n')
  })

  test('io mode DETACHES afterEmit (does not await it before returning)', async () => {
    const afterEmitCalls: true[] = []
    const opts: RunHookOptions<unknown> = {
      event: 'Stop',
      afterEmit: async () => {
        afterEmitCalls.push(true)
      },
    }
    const { pendingAfterEmit } = await warmOutput(opts, {})
    // runHook returned WITHOUT running afterEmit — it was handed to the
    // detach sink for the daemon to schedule out-of-band.
    expect(pendingAfterEmit).toBe(1)
    expect(afterEmitCalls).toHaveLength(0)
  })

  test('afterEmit-only workers skip build and schedule only the side-effect', async () => {
    const calls: string[] = []
    const pending: Array<() => Promise<void>> = []
    const opts: RunHookOptions<unknown> = {
      event: 'Stop',
      build: async () => {
        calls.push('build')
        return 'context'
      },
      afterEmit: async () => {
        calls.push('after')
      },
    }
    await runHook(opts, {
      afterEmitOnly: true,
      input: {},
      sink: () => calls.push('sink'),
      detachAfterEmit: (fn) => pending.push(fn),
    })
    expect(calls).toEqual([])
    expect(pending).toHaveLength(1)
    await pending[0]!()
    expect(calls).toEqual(['after'])
  })

  test('io mode honors the forwarded hookHost (kimi → raw text, not JSON)', async () => {
    const opts: RunHookOptions<unknown> = {
      event: 'UserPromptSubmit',
      build: async () => 'plain context',
    }
    const chunks: string[] = []
    await runHook(opts, {
      input: {},
      hookHost: 'kimi',
      sink: (chunk) => chunks.push(chunk),
      detachAfterEmit: () => {},
    })
    expect(chunks.join('')).toBe('plain context\n')
  })
})

describe('hook registry', () => {
  test('exposes every installed hook subcommand', () => {
    // Mirrors settings-installer.ts HOOKS list.
    for (const name of [
      'session-start',
      'prompt',
      'pre-bash',
      'pre-commit',
      'post-edit',
      'stop',
      'subagent-start',
      'cwd-changed',
    ]) {
      expect(typeof HOOK_RUNNERS[name]).toBe('function')
    }
  })
})
