/**
 * E2E: the real user flow end-to-end against a hermetic fake project.
 *
 *   --version → init → task → remember → review-risk → status done → ship
 *
 * Runs the actual `bin/prjct.ts` (latest repo version) in an isolated
 * PRJCT_CLI_HOME + HOME, so nothing here touches real `~/.prjct-cli` data.
 */

import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { makeSandbox, REPO_ROOT, type Sandbox } from './_harness'

// E2E spawns the real CLI as a subprocess (cold start + git + SQLite) — the
// 5s bun default is far too tight. One generous ceiling for the whole file.
setDefaultTimeout(120_000)

const REPO_VERSION = JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf-8'))
  .version as string

describe('e2e: unconfigured project fails LOUD (regression)', () => {
  const fixture: {
    sb: Sandbox
  } = {
    sb: undefined as unknown as Sandbox,
  }
  beforeAll(async () => {
    fixture.sb = await makeSandbox()
  })
  afterAll(async () => {
    await fixture.sb.cleanup()
  })

  // Regression for the silent-no-op bug: before init, an action command must
  // NOT exit 0 (a script/agent would think `prjct task` worked when it didn't).
  test('`task` before init exits non-zero with an actionable hint', async () => {
    const r = await fixture.sb.cli(['task', 'should not silently succeed'])
    expect(r.code).not.toBe(0)
    expect((r.stdout + r.stderr).toLowerCase()).toMatch(/not configured|prjct init|prjct start/)
  })

  test('`--version` still works without setup (exempt path, exit 0)', async () => {
    const r = await fixture.sb.cli(['--version'])
    expect(r.code).toBe(0)
    expect(r.stdout + r.stderr).toContain(REPO_VERSION)
  })

  // A misrouted single command-shaped token (typo / stale parallel install
  // or daemon that predates a verb like `upgrade`) must NOT be written to
  // memory. It has to fail loudly so scripts and agents cannot miss it.
  test('an unknown command-shaped token fails without capture', async () => {
    const r = await fixture.sb.cli(['definitelynotacommand'])
    const out = (r.stdout + r.stderr).toLowerCase()
    expect(r.code).not.toBe(0)
    expect(out).toContain('not a known command')
    expect(out).toContain('prjct upgrade')
    expect(out).not.toContain('captured')
    expect(out).not.toContain('inbox')
  })

  // Free-text GTD capture (multi-word, first token not a verb) stays silent
  // — the advisory is only for a LONE command-shaped token, so quick notes
  // aren't nagged.
  test('multi-word free-text capture stays silent (GTD preserved)', async () => {
    const r = await fixture.sb.cli(['buy', 'more', 'coffee', 'beans'])
    expect((r.stdout + r.stderr).toLowerCase()).not.toContain('not a known command')
  })
})

describe('e2e: analysis-save-llm from sync --deep', () => {
  const fixture: {
    sb: Sandbox
  } = {
    sb: undefined as unknown as Sandbox,
  }
  beforeAll(async () => {
    fixture.sb = await makeSandbox()
    const init = await fixture.sb.cli(['init'], { timeoutMs: 90_000 })
    expect(init.code).toBe(0)
  })
  afterAll(async () => {
    await fixture.sb.cleanup()
  })

  test('accepts a file path with --md before provider setup', async () => {
    const analysisFile = path.join(fixture.sb.dir, 'analysis-notes.md')
    await fs.writeFile(analysisFile, '- Commands route through the manifest.\n', 'utf-8')
    const r = await fixture.sb.cli(['analysis-save-llm', analysisFile, '--md'])
    const out = (r.stdout + r.stderr).toLowerCase()
    expect(r.code).toBe(0)
    // Markdown notes are thin (not house style); title still reports a successful save.
    expect(out).toMatch(/llm analysis (notes )?saved/)
    expect(out).toContain('input')
    expect(out).toMatch(/thin|schema v1 json/)
    expect(out).not.toContain('not configured')
  })
})

describe('e2e: CLI lifecycle (hermetic fake project)', () => {
  const fixture: {
    sb: Sandbox
  } = {
    sb: undefined as unknown as Sandbox,
  }

  beforeAll(async () => {
    fixture.sb = await makeSandbox()
    // Real bootstrap = the README install flow: project init, then setup
    // (wires hooks + writes installed-editors.json → "configured" state).
    const init = await fixture.sb.cli(['init'], { timeoutMs: 90_000 })
    expect(init.code).toBe(0)
    const setup = await fixture.sb.cli(['setup'], { timeoutMs: 90_000 })
    expect(setup.code).toBe(0)
  })
  afterAll(async () => {
    await fixture.sb.cleanup()
  })

  test('removed workflow verbs fail with migration guidance instead of capture', async () => {
    const r = await fixture.sb.cli(['done', '--md'])
    const out = (r.stdout + r.stderr).toLowerCase()
    expect(r.code).not.toBe(0)
    expect(out).toContain("'prjct done' was removed in v2")
    expect(out).toContain('prjct status done')
    expect(out).not.toContain('saving it to the inbox')
  })

  test('task → status shows the active task', async () => {
    const t = await fixture.sb.cli(['task', 'e2e lifecycle task', '--md'])
    expect(t.code).toBe(0)

    const s = await fixture.sb.cli(['status', '--md'])
    expect(s.code).toBe(0)
    expect(s.stdout.toLowerCase()).toContain('active')
  })

  test('remember decision persists and is recallable', async () => {
    const w = await fixture.sb.cli([
      'remember',
      'decision',
      'use bun runtime for faster cold start',
      '--tags',
      'topic:e2e',
    ])
    expect(w.code).toBe(0)

    const recall = await fixture.sb.cli(['context', 'memory', 'bun', '--md'])
    expect(recall.code).toBe(0)
    expect(recall.stdout.toLowerCase()).toContain('bun runtime')
  })

  test('review-risk runs read-only and exits 0 (graceful no-signal)', async () => {
    const r = await fixture.sb.cli(['review-risk', '--md'])
    expect(r.code).toBe(0)
    expect(r.stdout.toLowerCase()).toMatch(/review risk|no comparable|trivial|tier/)
  })

  test('generic command errors are printed, not silent', async () => {
    const r = await fixture.sb.cli(['config', 'definitelybad', '--md'])
    const out = (r.stdout + r.stderr).toLowerCase()
    expect(r.code).not.toBe(0)
    expect(out).toContain('unknown config subcommand')
  })

  test('status done closes the active task', async () => {
    const d = await fixture.sb.cli(['status', 'done', '--md'])
    expect(d.code).toBe(0)
    const s = await fixture.sb.cli(['status', '--md'])
    expect(s.stdout.toLowerCase()).not.toContain('status: active')
  })

  test('ship on a no-remote fake project degrades gracefully (no crash)', async () => {
    await fixture.sb.cli(['task', 'shippable unit'])
    const r = await fixture.sb.cli(['ship', '--md'], { timeoutMs: 90_000 })
    // register-only OR code workflow whose push step fails cleanly — but
    // NEVER a hard crash / unhandled exception.
    expect([0, 1]).toContain(r.code)
    expect(r.stdout + r.stderr).not.toMatch(/Cannot read|undefined is not|TypeError|unhandled/i)
  })
})
