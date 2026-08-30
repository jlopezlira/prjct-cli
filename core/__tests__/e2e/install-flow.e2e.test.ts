/**
 * E2E: the README "Install / upgrade — one paste" promise, hermetically.
 *
 * The real prompt is: detect package manager → global install → `prjct setup`
 * → `prjct sync` (if git repo) → verify `prjct -v`. A global npm/bun install
 * can't run hermetically, so we exercise the *post-install* contract that the
 * prompt promises against the repo build in an isolated home:
 *
 *   prjct -v   →  prjct init  →  prjct setup  →  prjct sync  →  prjct doctor
 *
 * If any of these is broken, the onboarding promise is broken.
 */

import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { makeSandbox, REPO_ROOT, type Sandbox } from './_harness'

setDefaultTimeout(120_000)

const REPO_VERSION = JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf-8'))
  .version as string

describe('e2e: PRJCT_CLI_HOME is honored when it differs from HOME (regression)', () => {
  // Regression for the os.homedir() footgun: the "not configured" guard
  // resolved its config path via os.homedir() instead of pathManager, so
  // with PRJCT_CLI_HOME ≠ HOME, `setup` wrote installed-editors.json under
  // PRJCT_CLI_HOME but the guard looked under HOME → every command misfired
  // as "not configured". (Hidden whenever HOME == PRJCT_CLI_HOME.)
  const fixture: {
    sb: Sandbox
  } = {
    sb: undefined as unknown as Sandbox,
  }

  beforeAll(async () => {
    fixture.sb = await makeSandbox({ splitCliHome: true })
    expect((await fixture.sb.cli(['init'], { timeoutMs: 90_000 })).code).toBe(0)
    expect((await fixture.sb.cli(['setup'], { timeoutMs: 90_000 })).code).toBe(0)
  })
  afterAll(async () => {
    await fixture.sb.cleanup()
  })

  test('setup writes installed-editors.json under PRJCT_CLI_HOME, not HOME', () => {
    expect(existsSync(path.join(fixture.sb.home, 'config', 'installed-editors.json'))).toBe(true)
  })

  test('a normal command is NOT misreported as "not configured"', async () => {
    const r = await fixture.sb.cli(['task', 'split-home smoke', '--md'])
    expect(r.code).toBe(0)
    expect((r.stdout + r.stderr).toLowerCase()).not.toContain('not configured')
  })

  // Bullet-proof for the whole os.homedir()/.prjct-cli sweep: after a full
  // flow, ALL prjct data must live under PRJCT_CLI_HOME and NOTHING may leak
  // to <HOME>/.prjct-cli. If any swept site (provider-cache, update-checker,
  // self-heal, setup projects/statusline, command-installer docs, …) still
  // used os.homedir(), it would create <HOME>/.prjct-cli/* and fail here.
  test('no prjct data leaks to <HOME>/.prjct-cli (entire sweep)', async () => {
    expect((await fixture.sb.cli(['remember', 'decision', 'split-home persists'])).code).toBe(0)
    expect((await fixture.sb.cli(['review-risk', '--md'])).code).toBe(0)

    // Data is under PRJCT_CLI_HOME …
    expect(existsSync(path.join(fixture.sb.home, 'projects'))).toBe(true)
    // … and the os.homedir-based path was never created.
    expect(existsSync(path.join(fixture.sb.osHome, '.prjct-cli'))).toBe(false)
  })
})

describe('e2e: install/upgrade onboarding contract', () => {
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

  test('`prjct -v` reports the package.json version (not a stale global)', async () => {
    const r = await fixture.sb.cli(['-v'])
    expect(r.code).toBe(0)
    expect(r.stdout + r.stderr).toContain(REPO_VERSION)
  })

  test('`prjct init` then `prjct setup` reach a configured state and leave the repo clean', async () => {
    // prjct never writes AGENTS.md / CLAUDE.md / PRJCT.md / IDE rule files
    // into the client repository. The project is configured through `.prjct/`
    // and global agent config only.
    const init = await fixture.sb.cli(['init'], { timeoutMs: 90_000 })
    expect(init.code).toBe(0)
    expect(existsSync(path.join(fixture.sb.dir, 'AGENTS.md'))).toBe(false)
    expect(existsSync(path.join(fixture.sb.dir, 'PRJCT.md'))).toBe(false)
    expect(existsSync(path.join(fixture.sb.dir, 'CLAUDE.md'))).toBe(false)
    expect(existsSync(path.join(fixture.sb.dir, '.cursor'))).toBe(false)

    const setup = await fixture.sb.cli(['setup'], { timeoutMs: 90_000 })
    expect(setup.code).toBe(0)
    // Re-running setup still must not create repo-local agent surfaces.
    expect(existsSync(path.join(fixture.sb.dir, 'AGENTS.md'))).toBe(false)
    expect(existsSync(path.join(fixture.sb.dir, 'PRJCT.md'))).toBe(false)
    expect(existsSync(path.join(fixture.sb.dir, 'CLAUDE.md'))).toBe(false)

    // Configured ⇒ a normal command no longer hits the "not configured" gate.
    const task = await fixture.sb.cli(['task', 'post-setup smoke', '--md'])
    expect(task.code).toBe(0)
    expect((task.stdout + task.stderr).toLowerCase()).not.toContain('not configured')
  })

  test('`prjct sync` works inside a git repo (the prompt runs it post-setup)', async () => {
    const r = await fixture.sb.cli(['sync', '--md', '--yes'], { timeoutMs: 120_000 })
    expect(r.code).toBe(0)
    expect(r.stdout.toLowerCase()).toMatch(/sync|indexed|analysis/)
    // Sync must never create repo-local agent surfaces.
    expect(existsSync(path.join(fixture.sb.dir, 'AGENTS.md'))).toBe(false)
    expect(existsSync(path.join(fixture.sb.dir, 'PRJCT.md'))).toBe(false)
    expect(existsSync(path.join(fixture.sb.dir, 'CLAUDE.md'))).toBe(false)
  })

  test('`prjct doctor` reports health without crashing', async () => {
    const r = await fixture.sb.cli(['doctor'], { timeoutMs: 60_000 })
    expect([0, 1]).toContain(r.code) // may warn, must not crash
    expect(r.stdout + r.stderr).not.toMatch(/Cannot read|TypeError|unhandled|is not a function/i)
  })

  test('`prjct doctor --fix` runs the diagnose-repair-verify loop', async () => {
    const r = await fixture.sb.cli(['doctor', '--fix'], { timeoutMs: 90_000 })
    const output = r.stdout + r.stderr

    expect(r.code).toBe(0)
    expect(output).toContain('diagnose → repair → verify')
    expect(output).toContain('Check-driven repair:')
    expect(output).toContain('Context repair:')
    expect(output).not.toMatch(/Cannot read|TypeError|unhandled|is not a function/i)
  })
})

describe('e2e: `prjct upgrade` is an alias of `prjct update` (WS5)', () => {
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

  // The alias must route to the update command, NOT fall through to the
  // bare-capture path (which would silently inbox "upgrade" as a note).
  test('`upgrade` behaves identically to `update`, not bare-capture', async () => {
    const up = await fixture.sb.cli(['upgrade'])
    const ud = await fixture.sb.cli(['update'])
    expect(up.code).toBe(ud.code)
    const upOut = (up.stdout + up.stderr).toLowerCase()
    // Recognized as a real verb: it hits update's path (here: the
    // not-configured guard), never "captured to inbox".
    expect(upOut).not.toContain('captured')
    expect(upOut).not.toContain('inbox')
  })
})
