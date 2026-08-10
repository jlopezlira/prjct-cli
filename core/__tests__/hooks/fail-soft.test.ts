/**
 * Hook fail-soft contract — the #1 robustness guarantee of the harness.
 *
 * Every Claude Code hook runs through `runHook` → `safeRun`. The promise:
 * no matter what the hook body throws (missing native bindings, corrupted
 * config, a bug in a builder), the process emits a valid JSON line and
 * exits cleanly. If this guarantee ever breaks, EVERY user turn would
 * surface a hook error — so it must be regression-pinned, not just trusted
 * by reading the code.
 *
 * Before this test the behavior was correct but unpinned: nothing stopped a
 * future refactor from removing the try/catch in `safeRun` or letting a
 * builder rejection escape the runner.
 */

import { describe, expect, spyOn, test } from 'bun:test'
import { runHook } from '../../hooks/_runner'

/** Capture everything written to stdout during `fn`, with stdin forced to
 *  TTY so `readStdinSafe` resolves immediately (no 200ms wait, no hang). */
async function captureStdout(fn: () => Promise<void>): Promise<string> {
  const writes: string[] = []
  const spy = spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => {
    writes.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8'))
    return true
  }) as typeof process.stdout.write)
  const originalIsTTY = process.stdin.isTTY
  Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true })
  try {
    await fn()
  } finally {
    Object.defineProperty(process.stdin, 'isTTY', { value: originalIsTTY, configurable: true })
    spy.mockRestore()
  }
  return writes.join('')
}

describe('hook fail-soft contract (safeRun)', () => {
  test('a throwing build never rejects and still emits the empty no-op {}', async () => {
    const rejections: unknown[] = []
    const out = await captureStdout(async () => {
      try {
        await runHook({
          event: 'UserPromptSubmit',
          projectPath: process.cwd(),
          build: async () => {
            throw new Error('boom in build')
          },
        })
      } catch (error) {
        rejections.push(error)
      }
    })
    expect(rejections).toHaveLength(0)
    expect(out).toContain('{}')
  })

  test('a throwing afterEmit is swallowed; the built context was already emitted', async () => {
    const rejections: unknown[] = []
    const out = await captureStdout(async () => {
      try {
        await runHook({
          event: 'UserPromptSubmit',
          projectPath: process.cwd(),
          build: async () => 'CTX_BLOCK_SENTINEL',
          afterEmit: async () => {
            throw new Error('boom in afterEmit')
          },
        })
      } catch (error) {
        rejections.push(error)
      }
    })
    expect(rejections).toHaveLength(0)
    // emit() ran before afterEmit threw, so the real context reached stdout.
    expect(out).toContain('CTX_BLOCK_SENTINEL')
  })

  test('a normal build emits valid JSON containing the context', async () => {
    const out = await captureStdout(async () => {
      await runHook({
        event: 'UserPromptSubmit',
        projectPath: process.cwd(),
        build: async () => 'HELLO_CTX',
      })
    })
    const firstLine = out.split('\n').find((l) => l.trim().length > 0) ?? ''
    expect(() => JSON.parse(firstLine)).not.toThrow()
    expect(out).toContain('HELLO_CTX')
  })
})

describe('hooks stay non-blocking (passive inject only)', () => {
  const PASSIVE_EVENTS = [
    'SessionStart',
    'UserPromptSubmit',
    'PostToolUse',
    'Stop',
    'SubagentStart',
    'CwdChanged',
  ] as const

  for (const event of PASSIVE_EVENTS) {
    test(`${event} without decide never emits permissionDecision deny`, async () => {
      const out = await captureStdout(async () => {
        await runHook({
          event,
          projectPath: process.cwd(),
          build: async () => `ctx-for-${event}`,
        })
      })
      expect(out).not.toContain('permissionDecision')
      expect(out).not.toContain('"deny"')
      // Context may land as additionalContext or systemMessage depending on event schema.
      expect(out.length).toBeGreaterThan(0)
    })
  }

  test('decide throw fails open — no deny, no crash', async () => {
    const rejections: unknown[] = []
    const out = await captureStdout(async () => {
      try {
        await runHook({
          event: 'PreToolUse',
          projectPath: process.cwd(),
          decide: async () => {
            throw new Error('loop guard blew up')
          },
          build: async () => 'SHOULD_NOT_MATTER',
        })
      } catch (error) {
        rejections.push(error)
      }
    })
    expect(rejections).toHaveLength(0)
    expect(out).not.toContain('permissionDecision')
    expect(out).toContain('{}')
  })

  test('explicit decide deny is allowed only when decide returns {deny}', async () => {
    const out = await captureStdout(async () => {
      await runHook({
        event: 'PreToolUse',
        projectPath: process.cwd(),
        decide: async () => ({ deny: 'turn budget exceeded' }),
        build: async () => 'must-not-emit-when-denied',
      })
    })
    expect(out).toContain('permissionDecision')
    expect(out).toContain('deny')
    expect(out).toContain('turn budget exceeded')
    expect(out).not.toContain('must-not-emit-when-denied')
  })

  test('daemon mode detaches afterEmit so it never blocks the response', async () => {
    const chunks: string[] = []
    const fixture: {
      detachedFn: (() => Promise<void>) | null
      afterEmitRan: boolean
    } = {
      detachedFn: null,
      afterEmitRan: false,
    }

    await runHook(
      {
        event: 'UserPromptSubmit',
        projectPath: process.cwd(),
        build: async () => 'DAEMON_CTX',
        afterEmit: async () => {
          fixture.afterEmitRan = true
        },
      },
      {
        input: {},
        sink: (c) => {
          chunks.push(c)
        },
        detachAfterEmit: (fn) => {
          fixture.detachedFn = fn
        },
      }
    )

    // Response already contains context; afterEmit not yet run.
    expect(chunks.join('')).toContain('DAEMON_CTX')
    expect(chunks.join('')).not.toContain('permissionDecision')
    expect(fixture.afterEmitRan).toBe(false)
    expect(fixture.detachedFn).not.toBeNull()
    await fixture.detachedFn!()
    expect(fixture.afterEmitRan).toBe(true)
  })
})
