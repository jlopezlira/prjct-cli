/**
 * Settings installer — safe merge into ~/.claude/settings.json.
 *
 * We redirect HOME to a temp dir per test so the real user settings
 * are never touched. `settingsPath()` resolves homedir() at call time
 * (not at module load), so no cache busting is needed.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  HOOK_TIMEOUT_SECONDS,
  install,
  PRJCT_HOOKS,
  status,
  uninstall,
} from '../../services/settings-installer'

const ORIGINAL_HOME = process.env.HOME

async function freshHome(): Promise<string> {
  const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'prjct-settings-test-'))
  process.env.HOME = tmpHome
  return tmpHome
}

describe('settings-installer', () => {
  const fixture: {
    home: string
  } = {
    home: '',
  }

  beforeEach(async () => {
    fixture.home = await freshHome()
  })

  afterEach(async () => {
    await fs.rm(fixture.home, { recursive: true, force: true })
    if (ORIGINAL_HOME) process.env.HOME = ORIGINAL_HOME
    else delete process.env.HOME
  })

  test('install writes all hooks on a fresh settings file', async () => {
    const result = await install()
    expect(result.hooksWritten).toBe(PRJCT_HOOKS.length)
    expect(result.alreadyPresent).toBe(0)

    const raw = await fs.readFile(path.join(fixture.home, '.claude', 'settings.json'), 'utf-8')
    const parsed = JSON.parse(raw)
    expect(parsed.hooks).toBeDefined()
    expect(parsed.hooks.SessionStart).toBeDefined()
    expect(parsed.hooks.SessionStart[0].hooks[0]._prjctManaged).toBe(true)
  })

  test('install is idempotent — second run reports all already present', async () => {
    await install()
    const second = await install()
    expect(second.hooksWritten).toBe(0)
    expect(second.alreadyPresent).toBe(PRJCT_HOOKS.length)
    expect(second.hooksPruned).toBe(0)
  })

  test('every installed hook entry carries the bounded timeout', async () => {
    await install()
    const parsed = JSON.parse(
      await fs.readFile(path.join(fixture.home, '.claude', 'settings.json'), 'utf-8')
    )
    const managed = Object.values(parsed.hooks as Record<string, { hooks: unknown[] }[]>)
      .flatMap((blocks) => blocks.flatMap((b) => b.hooks))
      .filter((h) => (h as { _prjctManaged?: boolean })._prjctManaged === true)
    expect(managed.length).toBe(PRJCT_HOOKS.length)
    for (const hook of managed) {
      expect((hook as { timeout?: number }).timeout).toBe(HOOK_TIMEOUT_SECONDS)
    }
  })

  test('reinstall refreshes a managed entry that predates the timeout', async () => {
    await install()
    const settingsPath = path.join(fixture.home, '.claude', 'settings.json')

    // Simulate a settings file written before the timeout existed.
    const parsed = JSON.parse(await fs.readFile(settingsPath, 'utf-8'))
    for (const blocks of Object.values(parsed.hooks as Record<string, { hooks: unknown[] }[]>)) {
      for (const block of blocks) {
        for (const hook of block.hooks) {
          delete (hook as { timeout?: number }).timeout
        }
      }
    }
    await fs.writeFile(settingsPath, JSON.stringify(parsed), 'utf-8')

    const second = await install()
    // Every entry was rewritten with the timeout, none newly added.
    expect(second.hooksWritten).toBe(PRJCT_HOOKS.length)
    const after = JSON.parse(await fs.readFile(settingsPath, 'utf-8'))
    for (const blocks of Object.values(after.hooks as Record<string, { hooks: unknown[] }[]>)) {
      for (const block of blocks) {
        for (const hook of block.hooks) {
          expect((hook as { timeout?: number }).timeout).toBe(HOOK_TIMEOUT_SECONDS)
        }
      }
    }
  })

  test('reinstall moves pre-edit off the legacy matcher without duplicating it', async () => {
    await install()
    const settingsPath = path.join(fixture.home, '.claude', 'settings.json')
    const parsed = JSON.parse(await fs.readFile(settingsPath, 'utf-8'))
    const blocks = parsed.hooks.PreToolUse as Array<{
      matcher?: string
      hooks: Array<{ command: string; _prjctManaged?: boolean }>
    }>
    const current = blocks.find((block) =>
      block.hooks.some((hook) => hook.command.includes('pre-edit'))
    )
    expect(current).toBeDefined()
    current!.matcher = 'Edit|Write'
    current!.hooks.push({ command: 'echo keep-user-hook' })
    await fs.writeFile(settingsPath, JSON.stringify(parsed), 'utf-8')

    await install()
    const after = JSON.parse(await fs.readFile(settingsPath, 'utf-8'))
    const afterBlocks = after.hooks.PreToolUse as Array<{
      matcher?: string
      hooks: Array<{ command: string }>
    }>
    const preEditBlocks = afterBlocks.filter((block) =>
      block.hooks.some((hook) => hook.command.includes('pre-edit'))
    )
    expect(preEditBlocks).toHaveLength(1)
    expect(preEditBlocks[0]?.matcher).toContain('apply_patch')
    expect(JSON.stringify(afterBlocks)).toContain('keep-user-hook')
  })

  test('install prunes a retired managed hook from existing settings', async () => {
    const settingsPath = path.join(fixture.home, '.claude', 'settings.json')
    await fs.mkdir(path.dirname(settingsPath), { recursive: true })
    // Simulate a settings file from an older prjct that installed a hook
    // whose subcommand has since left PRJCT_HOOKS. Use a fictional retired
    // name (`legacy-recall`) under a matcher nothing current claims, so the
    // assertion isn't muddied by a real hook re-occupying the same block.
    await fs.writeFile(
      settingsPath,
      JSON.stringify({
        hooks: {
          PostToolUse: [
            {
              matcher: 'Bash',
              hooks: [
                {
                  type: 'command',
                  command: 'command -v prjct >/dev/null 2>&1 && prjct hook legacy-recall || exit 0',
                  _prjctManaged: true,
                },
              ],
            },
          ],
        },
      })
    )

    const result = await install()
    expect(result.hooksPruned).toBe(1)

    const parsed = JSON.parse(await fs.readFile(settingsPath, 'utf-8'))
    const commands = JSON.stringify(parsed.hooks)
    expect(commands).not.toContain('hook legacy-recall')
    // The retired hook's now-empty PostToolUse/Bash block is gone, but the
    // current consolidated Bash PreToolUse hook is present.
    expect(commands).toContain('hook pre-bash')
  })

  test('prune leaves foreign (non-prjct) hooks with unknown subcommands untouched', async () => {
    const settingsPath = path.join(fixture.home, '.claude', 'settings.json')
    await fs.mkdir(path.dirname(settingsPath), { recursive: true })
    await fs.writeFile(
      settingsPath,
      JSON.stringify({
        hooks: {
          PreToolUse: [
            {
              matcher: 'Edit|Write',
              hooks: [
                // Looks like a `hook X` command but is NOT prjct-managed.
                { type: 'command', command: 'othertool hook pre-edit' },
              ],
            },
          ],
        },
      })
    )

    const result = await install()
    expect(result.hooksPruned).toBe(0)
    const parsed = JSON.parse(await fs.readFile(settingsPath, 'utf-8'))
    expect(JSON.stringify(parsed.hooks)).toContain('othertool hook pre-edit')
  })

  test('install preserves foreign (non-prjct) hooks under the same event', async () => {
    const settingsPath = path.join(fixture.home, '.claude', 'settings.json')
    await fs.mkdir(path.dirname(settingsPath), { recursive: true })
    await fs.writeFile(
      settingsPath,
      JSON.stringify({
        hooks: {
          SessionStart: [
            { matcher: '', hooks: [{ type: 'command', command: '/usr/local/bin/other-tool' }] },
          ],
        },
        someUserKey: 'keep-me',
      }),
      'utf-8'
    )

    await install()
    const parsed = JSON.parse(await fs.readFile(settingsPath, 'utf-8'))

    // User key preserved
    expect(parsed.someUserKey).toBe('keep-me')
    // Foreign hook preserved, prjct entry added alongside
    const sessionHooks = parsed.hooks.SessionStart[0].hooks
    expect(sessionHooks.length).toBe(2)
    expect(
      sessionHooks.some((h: { command: string }) => h.command === '/usr/local/bin/other-tool')
    ).toBe(true)
    expect(sessionHooks.some((h: { _prjctManaged?: boolean }) => h._prjctManaged === true)).toBe(
      true
    )
  })

  test('uninstall removes only prjct entries, foreign hooks survive', async () => {
    await install()

    // Inject a foreign hook under the same event
    const settingsPath = path.join(fixture.home, '.claude', 'settings.json')
    const parsed = JSON.parse(await fs.readFile(settingsPath, 'utf-8'))
    parsed.hooks.SessionStart[0].hooks.push({
      type: 'command',
      command: '/usr/local/bin/other-tool',
    })
    await fs.writeFile(settingsPath, JSON.stringify(parsed), 'utf-8')

    const result = await uninstall()
    expect(result.hooksRemoved).toBeGreaterThan(0)

    const after = JSON.parse(await fs.readFile(settingsPath, 'utf-8'))
    // Foreign hook still there
    const remaining = after.hooks?.SessionStart?.[0]?.hooks ?? []
    expect(
      remaining.some((h: { command: string }) => h.command === '/usr/local/bin/other-tool')
    ).toBe(true)
    expect(remaining.some((h: { _prjctManaged?: boolean }) => h._prjctManaged === true)).toBe(false)
  })

  test('install collapses legacy unmanaged prjct duplicates into the marked entry', async () => {
    // Simulate JJ's machine 2026-05-01: 3 unmanaged + 1 managed copies
    // accumulated from older installs that didn't tag entries.
    const settingsPath = path.join(fixture.home, '.claude', 'settings.json')
    await fs.mkdir(path.dirname(settingsPath), { recursive: true })
    await fs.writeFile(
      settingsPath,
      JSON.stringify({
        hooks: {
          SessionStart: [
            {
              matcher: '',
              hooks: [
                { type: 'command', command: 'prjct hook session-start' },
                { type: 'command', command: 'prjct hook session-start' },
                { type: 'command', command: 'prjct hook session-start' },
                { type: 'command', command: 'prjct hook session-start', _prjctManaged: true },
                // Foreign hook must survive
                { type: 'command', command: '/usr/local/bin/other-tool' },
              ],
            },
          ],
        },
      }),
      'utf-8'
    )

    await install()
    const parsed = JSON.parse(await fs.readFile(settingsPath, 'utf-8'))
    const sessionHooks = parsed.hooks.SessionStart[0].hooks

    // Exactly 1 prjct entry remains, and it's the marked one
    const prjctOnes = sessionHooks.filter((h: { command: string }) =>
      /prjct\s+hook\s+session-start/.test(h.command)
    )
    expect(prjctOnes.length).toBe(1)
    expect(prjctOnes[0]._prjctManaged).toBe(true)

    // Foreign hook preserved
    expect(
      sessionHooks.some((h: { command: string }) => h.command === '/usr/local/bin/other-tool')
    ).toBe(true)

    // Idempotent: second run is a no-op
    const second = await install()
    expect(second.hooksWritten).toBe(0)
    expect(second.alreadyPresent).toBe(PRJCT_HOOKS.length)
  })

  test('status reports installed count', async () => {
    await install()
    const s = await status()
    expect(s.installed).toBe(PRJCT_HOOKS.length)
    expect(s.expected).toBe(PRJCT_HOOKS.length)
  })

  // Regression coverage for the no-prjct-on-PATH crash mode (May 2026).
  // After an aggressive uninstall, every Stop hook fired "command not
  // found: prjct" into the user's session. The fix wraps the command
  // in a `command -v` guard so missing prjct silently no-ops with exit 0.
  describe('hook command resilience (missing prjct binary)', () => {
    test('every installed hook command starts with a command -v guard', async () => {
      await install()
      const raw = await fs.readFile(path.join(fixture.home, '.claude', 'settings.json'), 'utf-8')
      const parsed = JSON.parse(raw)
      for (const event of Object.keys(parsed.hooks)) {
        for (const block of parsed.hooks[event]) {
          for (const hook of block.hooks) {
            if (hook._prjctManaged !== true) continue
            expect(hook.command).toContain('command -v')
            expect(hook.command).toContain('|| exit 0')
            expect(hook.command).toContain('prjct hook ')
          }
        }
      }
    })

    test('the guard actually exits 0 when prjct is missing (live shell smoke test)', async () => {
      // Force the portable `command -v` form regardless of local dist/ state.
      // This test regression-covers THAT guard specifically (May 2026
      // incident); the runtime+shim fast path added later tries an absolute
      // path first and would exit 0 via a real execution instead of the
      // guard, silently no longer testing the thing it asserts. The fast
      // path itself is covered by the next test.
      process.env.PRJCT_BIN = 'prjct'
      try {
        await install()
      } finally {
        delete process.env.PRJCT_BIN
      }
      const raw = await fs.readFile(path.join(fixture.home, '.claude', 'settings.json'), 'utf-8')
      const parsed = JSON.parse(raw)
      // Pull the Stop hook command (the one that surfaced the bug).
      const stopCommand = parsed.hooks.Stop[0].hooks[0].command
      // Run it with an empty PATH so prjct truly cannot be found.
      const { execSync } = await import('node:child_process')
      const exitCode = (() => {
        try {
          execSync(stopCommand, {
            env: { ...process.env, PATH: '/usr/bin:/bin' },
            stdio: 'ignore',
          })
          return 0
        } catch (error) {
          return (error as { status?: number }).status ?? -1
        }
      })()
      expect(exitCode).toBe(0)
    })

    test('resolves the runtime+shim fast path when the shim exists (skips the POSIX wrapper)', async () => {
      // Perf: the portable `prjct hook X` form pays bin/prjct's symlink
      // resolution + runtime detection (~10-15ms) on every hook event. When
      // the shipped daemon shim is resolvable from this checkout (dist built),
      // install writes `"<runtime>" "<shim>" hook X || <portable form>` —
      // direct exec first, the command -v guard as the fallback.
      await install()
      const raw = await fs.readFile(path.join(fixture.home, '.claude', 'settings.json'), 'utf-8')
      const parsed = JSON.parse(raw)
      const stop = parsed.hooks.Stop.flatMap((b: { hooks: { command: string }[] }) => b.hooks)[0]!
      const shimPath = path.resolve(__dirname, '..', '..', '..', 'dist', 'bin', 'prjct.mjs')
      if (existsSync(shimPath)) {
        expect(stop.command).toContain(`"${shimPath}" hook stop`)
        expect(stop.command).toContain('|| { command -v prjct')
        // The fast path must come FIRST — a leading `command -v` would mean
        // the wrapper form won.
        expect(stop.command.indexOf('hook stop')).toBeLessThan(
          stop.command.indexOf('command -v prjct')
        )
        // Regression: shell &&/|| are left-associative, so an unbraced
        // `A || B && C || exit 0` chain runs the fallback EVEN WHEN the fast
        // path succeeds — the hook fired TWICE per event (two JSON lines on
        // stdout, double daemon work). Run the installed command and assert
        // a single emission.
        const { execSync } = await import('node:child_process')
        const out = execSync(stop.command, {
          // PRJCT_NO_DAEMON=1: this runs the REAL compiled shim (not a
          // mock). Without it, a reachable daemon absorbs the event and an
          // unreachable one gets spawned-and-detached by the shim's cold
          // path — either way a real background process outlives this test
          // (afterEach only removes the temp HOME dir, not the process).
          env: { ...process.env, PRJCT_NO_DAEMON: '1' },
          input: '{}',
          encoding: 'utf-8',
        })
        const lines = out.trim().split('\n').filter(Boolean)
        expect(lines.length).toBe(1)
        expect(() => JSON.parse(lines[0]!)).not.toThrow()
      } else {
        // No dist build (CI without artifacts) → portable form only.
        expect(stop.command.startsWith('command -v prjct')).toBe(true)
      }
    })

    test('resolves the native hook-fast binary first when this platform has one', async () => {
      // native/hook-fast.c is compiled per-platform by build.js
      // (buildNativeHookFast) into dist/bin/hook-fast-<platform>-<arch>.
      // When present it must be the FIRST stage — it's the fastest path —
      // ahead of even the bun direct-exec form, with the same braced
      // fallback semantics.
      await install()
      const raw = await fs.readFile(path.join(fixture.home, '.claude', 'settings.json'), 'utf-8')
      const parsed = JSON.parse(raw)
      const stop = parsed.hooks.Stop.flatMap((b: { hooks: { command: string }[] }) => b.hooks)[0]!
      const nativeBinPath = path.resolve(
        __dirname,
        '..',
        '..',
        '..',
        'dist',
        'bin',
        `hook-fast-${process.platform}-${process.arch}`
      )
      if (process.platform !== 'win32' && existsSync(nativeBinPath)) {
        expect(stop.command).toContain(`"${nativeBinPath}" stop`)
        const shimPath = path.resolve(__dirname, '..', '..', '..', 'dist', 'bin', 'prjct.mjs')
        expect(stop.command.indexOf(`"${nativeBinPath}" stop`)).toBeLessThan(
          stop.command.indexOf(`"${shimPath}" hook stop`)
        )
        // PRJCT_NO_DAEMON=1 must reach the native stage too (it has no other
        // way to know the caller wants the daemon disabled) — verified by
        // running the real installed command and asserting single, valid
        // JSON output with no leaked daemon (same contract as the bun-only
        // test above, now exercised with the native binary in the chain).
        const { execSync } = await import('node:child_process')
        const out = execSync(stop.command, {
          env: { ...process.env, PRJCT_NO_DAEMON: '1' },
          input: '{}',
          encoding: 'utf-8',
        })
        const lines = out.trim().split('\n').filter(Boolean)
        expect(lines.length).toBe(1)
        expect(() => JSON.parse(lines[0]!)).not.toThrow()
      } else {
        // No native binary for this platform (no C toolchain at build
        // time, or Windows) — the bun form must still be the leading stage.
        const shimPath = path.resolve(__dirname, '..', '..', '..', 'dist', 'bin', 'prjct.mjs')
        if (existsSync(shimPath)) {
          expect(stop.command.startsWith(`"`)).toBe(true)
          expect(stop.command.indexOf('hook-fast-')).toBe(-1)
        }
      }
    })

    test('PRJCT_BIN env override is honored', async () => {
      process.env.PRJCT_BIN = '/custom/path/prjct'
      try {
        const m = await import(`../../services/settings-installer?t=${Date.now()}`)
        await m.install()
        const raw = await fs.readFile(path.join(fixture.home, '.claude', 'settings.json'), 'utf-8')
        const parsed = JSON.parse(raw)
        const stop = parsed.hooks.Stop[0].hooks[0]
        expect(stop.command).toContain('/custom/path/prjct')
      } finally {
        delete process.env.PRJCT_BIN
      }
    })
  })
})
