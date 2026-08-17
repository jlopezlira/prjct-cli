/**
 * Hook stdin spill (core/hooks/stdin-spill.ts) — the recovery channel that
 * lets a `||` chain fallback re-read a hook payload after the native
 * hook-fast binary already consumed stdin and punted.
 *
 * Pins:
 *   1. Deterministic path shape + fnv1a-32 vector that MUST match
 *      native/hook-fast.c (verified against the compiled binary:
 *      cwd=/Users/jj/Apps/prjct/prjct-cli → e37b236f).
 *   2. write → consume roundtrip returns the payload and deletes the file.
 *   3. Missing / stale (> HOOK_STDIN_SPILL_MAX_AGE_MS) spills are not
 *      consumed; stale ones are GC'd.
 *   4. Everything is fail-soft (never throws).
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  consumeHookStdinSpill,
  HOOK_STDIN_SPILL_MAX_AGE_MS,
  hookStdinSpillPath,
  writeHookStdinSpill,
} from '../../hooks/stdin-spill'

const ORIGINAL_CLI_HOME = process.env.PRJCT_CLI_HOME
const fixture: { dir: string } = { dir: '' }

beforeEach(async () => {
  fixture.dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'prjct-stdin-spill-test-'))
  process.env.PRJCT_CLI_HOME = fixture.dir
})

afterEach(async () => {
  await fsp.rm(fixture.dir, { recursive: true, force: true }).catch(() => {})
  if (ORIGINAL_CLI_HOME === undefined) delete process.env.PRJCT_CLI_HOME
  else process.env.PRJCT_CLI_HOME = ORIGINAL_CLI_HOME
})

describe('hookStdinSpillPath', () => {
  it('builds <cliHome>/run/hook-stdin-<fnv1a32hex(cwd)>-<sub>.json', () => {
    const p = hookStdinSpillPath('/some/project', 'prompt')
    expect(p).toBe(
      path.join(fixture.dir, 'run', `hook-stdin-${fnv1aExpected('/some/project')}-prompt.json`)
    )
  })

  it('matches the fnv1a-32 vector the compiled C binary produces', () => {
    // Cross-checked by running `PRJCT_CLI_HOME=<tmp> ./hook-fast prompt`
    // from this directory: the C binary spilled to hook-stdin-e37b236f-prompt.json.
    const p = hookStdinSpillPath('/Users/jj/Apps/prjct/prjct-cli', 'prompt')
    expect(p).toContain('hook-stdin-e37b236f-prompt.json')
  })

  it('sanitizes the subcommand to lowercase [a-z0-9-] (mirrors the C side)', () => {
    expect(hookStdinSpillPath('/x', 'Pre_Edit!')).toContain('-preedit.json')
    expect(hookStdinSpillPath('/x', 'session-start')).toContain('-session-start.json')
    expect(hookStdinSpillPath('/x', '!!!')).toBeNull()
  })
})

/** Reference fnv1a-32 (UTF-8 bytes) so the path-shape test doesn't just
 * re-run the implementation under test. */
function fnv1aExpected(input: string): string {
  const bytes = Buffer.from(input, 'utf-8')
  const hash = bytes.reduce((acc, b) => Math.imul(acc ^ b, 16777619) >>> 0, 2166136261)
  return hash.toString(16).padStart(8, '0')
}

describe('write/consume roundtrip', () => {
  it('returns the spilled payload exactly once, then deletes the file', () => {
    const cwd = process.cwd()
    writeHookStdinSpill(cwd, 'prompt', '{"prompt":"hello"}')
    const spillPath = hookStdinSpillPath(cwd, 'prompt')
    expect(spillPath).not.toBeNull()
    expect(fs.existsSync(spillPath as string)).toBe(true)

    expect(consumeHookStdinSpill(cwd, 'prompt')).toBe('{"prompt":"hello"}')
    expect(fs.existsSync(spillPath as string)).toBe(false)
    // Second consume: nothing left.
    expect(consumeHookStdinSpill(cwd, 'prompt')).toBeNull()
  })

  it('keys spills by (cwd, subcommand) — a different subcommand misses', () => {
    const cwd = process.cwd()
    writeHookStdinSpill(cwd, 'prompt', '{"a":1}')
    expect(consumeHookStdinSpill(cwd, 'stop')).toBeNull()
    expect(consumeHookStdinSpill(cwd, 'prompt')).toBe('{"a":1}')
  })

  it('refuses (and GCs) a stale spill older than the freshness window', () => {
    const cwd = process.cwd()
    writeHookStdinSpill(cwd, 'prompt', '{"old":true}')
    const spillPath = hookStdinSpillPath(cwd, 'prompt') as string
    const stale = new Date(Date.now() - HOOK_STDIN_SPILL_MAX_AGE_MS - 1000)
    fs.utimesSync(spillPath, stale, stale)

    expect(consumeHookStdinSpill(cwd, 'prompt')).toBeNull()
    expect(fs.existsSync(spillPath)).toBe(false)
  })

  it('is fail-soft: missing file and unknown subcommand return null', () => {
    expect(consumeHookStdinSpill(process.cwd(), 'prompt')).toBeNull()
    expect(consumeHookStdinSpill(process.cwd(), '')).toBeNull()
    expect(() => writeHookStdinSpill(process.cwd(), '!!!', '{}')).not.toThrow()
  })
})
