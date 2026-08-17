/**
 * Kimi Code CLI hooks installer — `[[hooks]]` entries in config.toml.
 *
 * Pins the contract:
 *   1. Missing file → created with every mapped hook, each preceded by a
 *      `# prjct-managed` marker comment (TOML forbids extra entry fields).
 *   2. Re-run with no change → changed: false, file bytes identical.
 *   3. User entries and other tools' blocks (Orca) survive byte-identical.
 *   4. Managed entries whose subcommand left PRJCT_HOOKS are pruned.
 *   5. Uninstall strips only prjct-managed entries.
 *   6. CwdChanged is never mapped (no Kimi equivalent).
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { existsSync } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { installKimiHooks, kimiHookMaps, uninstallKimiHooks } from '../../utils/kimi-hooks'

const fixture: { dir: string; configPath: string } = { dir: '', configPath: '' }

beforeEach(async () => {
  fixture.dir = await fs.mkdtemp(path.join(os.tmpdir(), 'prjct-kimi-hooks-test-'))
  fixture.configPath = path.join(fixture.dir, 'config.toml')
})

afterEach(async () => {
  await fs.rm(fixture.dir, { recursive: true, force: true }).catch(() => {})
})

const ORCA_BLOCK = `# orca-managed-kimi-hooks
[[hooks]]
event = "SessionStart"
command = "orca hooks session-start"
timeout = 5
`

const USER_HOOK = `# my own hook
[[hooks]]
event = "PreToolUse"
matcher = "Bash"
command = "my-linter --check"
`

describe('kimiHookMaps', () => {
  it('maps the Kimi-supported subset and skips CwdChanged', () => {
    const maps = kimiHookMaps()
    expect(maps.some((m) => m.event === 'CwdChanged')).toBe(false)
    expect(maps.find((m) => m.subcommand === 'session-start')?.event).toBe('SessionStart')
    expect(maps.find((m) => m.subcommand === 'prompt')?.event).toBe('UserPromptSubmit')
    expect(maps.find((m) => m.subcommand === 'pre-bash')?.matcher).toBe('Bash')
    // Plain regex alternation — Kimi matchers are regexes (docs escape dots,
    // not pipes), so Claude's Edit|Write carries over verbatim.
    expect(maps.find((m) => m.subcommand === 'pre-edit')?.matcher).toBe('Edit|Write')
    expect(maps.find((m) => m.subcommand === 'post-edit')?.event).toBe('PostToolUse')
    expect(maps.find((m) => m.subcommand === 'stop')?.event).toBe('Stop')
  })
})

describe('installKimiHooks', () => {
  it('creates config.toml with a marked [[hooks]] entry per mapped hook', async () => {
    const r = await installKimiHooks(fixture.configPath)
    expect(r.changed).toBe(true)
    expect(r.hooksWritten).toBe(kimiHookMaps().length)

    const content = await fs.readFile(fixture.configPath, 'utf-8')
    const entryCount = content.split('[[hooks]]').length - 1
    expect(entryCount).toBe(kimiHookMaps().length)
    const markerCount = content.split('# prjct-managed').length - 1
    expect(markerCount).toBe(kimiHookMaps().length)
    expect(content).toContain('event = "PreToolUse"')
    expect(content).toContain('matcher = "Edit|Write"')
    expect(content).toContain('PRJCT_HOOK_HOST=kimi')
    expect(content).toContain('timeout = 10')
    expect(content).not.toContain('CwdChanged')
  })

  it('is idempotent on re-run (bytes identical, nothing rewritten)', async () => {
    await installKimiHooks(fixture.configPath)
    const before = await fs.readFile(fixture.configPath, 'utf-8')
    const second = await installKimiHooks(fixture.configPath)
    const after = await fs.readFile(fixture.configPath, 'utf-8')
    expect(second.changed).toBe(false)
    expect(second.hooksWritten).toBe(0)
    expect(second.alreadyPresent).toBe(kimiHookMaps().length)
    expect(after).toBe(before)
  })

  it('coexists with orca-managed blocks and user entries (byte-preserved)', async () => {
    const seeded = `${ORCA_BLOCK}\n${USER_HOOK}`
    await fs.writeFile(fixture.configPath, seeded, 'utf-8')

    await installKimiHooks(fixture.configPath)
    const content = await fs.readFile(fixture.configPath, 'utf-8')
    expect(content.startsWith(seeded)).toBe(true)

    const un = await uninstallKimiHooks(fixture.configPath)
    expect(un.hooksRemoved).toBe(kimiHookMaps().length)
    const after = await fs.readFile(fixture.configPath, 'utf-8')
    expect(after).toBe(seeded)
  })

  it('prunes managed entries whose subcommand left PRJCT_HOOKS', async () => {
    await fs.writeFile(
      fixture.configPath,
      `# prjct-managed
[[hooks]]
event = "Stop"
command = "command -v prjct >/dev/null 2>&1 && PRJCT_HOOK_HOST=kimi prjct hook retired-hook || exit 0"
timeout = 10
`,
      'utf-8'
    )

    const r = await installKimiHooks(fixture.configPath)
    expect(r.hooksPruned).toBe(1)
    const content = await fs.readFile(fixture.configPath, 'utf-8')
    expect(content).not.toContain('retired-hook')
  })

  it('adopts marker-less prjct entries via the command fallback match', async () => {
    await fs.writeFile(
      fixture.configPath,
      `[[hooks]]
event = "Stop"
command = "prjct hook stop"
`,
      'utf-8'
    )

    const r = await installKimiHooks(fixture.configPath)
    const content = await fs.readFile(fixture.configPath, 'utf-8')
    // The hand-pasted entry was absorbed; exactly ONE stop entry remains and
    // it is the canonical marked one.
    expect(content.split('prjct hook stop').length - 1).toBe(1)
    expect(content).toContain('# prjct-managed')
    expect(r.hooksWritten).toBeGreaterThan(0)
  })

  it('installs the native hook-fast chain with PRJCT_HOOK_HOST=kimi in every stage', async () => {
    await installKimiHooks(fixture.configPath)
    const content = await fs.readFile(fixture.configPath, 'utf-8')
    // Pull the Stop hook command out of its TOML entry.
    const commandLine = content
      .split('\n')
      .find((line) => line.startsWith('command = ') && line.includes('stop'))
    expect(commandLine).toBeDefined()
    // TOML-escaped quotes (\\") — unescape for assertions.
    const cmd = (commandLine ?? '').replace(/\\"/g, '"')

    const nativeBinPath = path.resolve(
      __dirname,
      '..',
      '..',
      '..',
      'dist',
      'bin',
      `hook-fast-${process.platform}-${process.arch}`
    )
    const shimPath = path.resolve(__dirname, '..', '..', '..', 'dist', 'bin', 'prjct.mjs')
    if (process.platform !== 'win32' && existsSync(nativeBinPath) && existsSync(shimPath)) {
      // Native first, then the direct runtime+shim, then portable — and the
      // host env rides in front of ALL THREE (the native binary forwards it
      // to the daemon as hookHost).
      expect(cmd).toContain(`PRJCT_HOOK_HOST=kimi "${nativeBinPath}" stop`)
      expect(cmd).toContain(`PRJCT_HOOK_HOST=kimi `)
      expect(cmd.indexOf(`"${nativeBinPath}" stop`)).toBeLessThan(cmd.indexOf('hook stop'))
      expect(cmd.indexOf('hook stop')).toBeLessThan(cmd.indexOf('command -v prjct'))
      expect(cmd.split('PRJCT_HOOK_HOST=kimi').length - 1).toBe(3)
    } else if (existsSync(shimPath)) {
      // Direct runtime+shim, then the braced portable fallback.
      expect(cmd).toContain('|| { command -v prjct')
      expect(cmd).toContain('PRJCT_HOOK_HOST=kimi prjct hook stop')
      expect(cmd).toContain('|| exit 0')
      expect(cmd.startsWith('command = "PRJCT_HOOK_HOST=kimi ')).toBe(true)
      expect(cmd.split('PRJCT_HOOK_HOST=kimi').length - 1).toBe(2)
    } else {
      // No dist build (e.g. CI unit shard on a fresh checkout) → portable
      // form only, no braced fallback stage.
      expect(cmd).toContain('command -v prjct >/dev/null 2>&1 && PRJCT_HOOK_HOST=kimi prjct hook')
      expect(cmd).toContain('|| exit 0')
    }
  })
})

describe('uninstallKimiHooks', () => {
  it('is a no-op when the file does not exist', async () => {
    const r = await uninstallKimiHooks(fixture.configPath)
    expect(r.hooksRemoved).toBe(0)
  })

  it('leaves a file with only user content untouched', async () => {
    await fs.writeFile(fixture.configPath, USER_HOOK, 'utf-8')
    const r = await uninstallKimiHooks(fixture.configPath)
    expect(r.hooksRemoved).toBe(0)
    expect(await fs.readFile(fixture.configPath, 'utf-8')).toBe(USER_HOOK)
  })
})
