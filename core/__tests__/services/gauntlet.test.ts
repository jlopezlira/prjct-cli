import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  ensureShipGauntlet,
  GAUNTLET_FRESH_MS,
  type GauntletReceipt,
  gauntletDoneWarning,
  gauntletShipVerdict,
  readGauntletReceipt,
  renderGauntletMd,
  runGauntlet,
  warmGauntletInBackground,
} from '../../services/gauntlet'
import prjctDb from '../../storage/database'
import { patchPathManager, restorePathManager } from '../_setup/path-manager-mock'

const fixture: { tmpRoot: string; projectDir: string; projectId: string } = {
  tmpRoot: '',
  projectDir: '',
  projectId: '',
}

beforeEach(async () => {
  fixture.tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'prjct-gauntlet-'))
  fixture.projectDir = path.join(fixture.tmpRoot, 'proj')
  await fs.mkdir(fixture.projectDir, { recursive: true })
  fixture.projectId = `gauntlet-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  patchPathManager(fixture.tmpRoot)
  prjctDb.run(fixture.projectId, 'SELECT 1 WHERE 1=0') // force migrations
})

afterEach(async () => {
  restorePathManager()
  await fs.rm(fixture.tmpRoot, { recursive: true, force: true }).catch(() => undefined)
})

function receipt(overrides: Partial<GauntletReceipt> = {}): GauntletReceipt {
  return {
    version: 1,
    ranAt: new Date().toISOString(),
    headSha: 'abc123',
    dirty: false,
    passed: true,
    vacuous: false,
    checks: [{ kind: 'test', command: 'true', ok: true, outcome: 'ok', durationMs: 10 }],
    ...overrides,
  }
}

describe('runGauntlet', () => {
  it('is loudly vacuous when the project registers no verify commands', async () => {
    const result = await runGauntlet(fixture.projectDir, fixture.projectId)
    expect(result.vacuous).toBe(true)
    expect(result.passed).toBe(true)
    expect(result.checks.length).toBe(0)
    // Receipt persisted and readable.
    const stored = readGauntletReceipt(fixture.projectId)
    expect(stored?.data.vacuous).toBe(true)
  })

  it('runs DECLARED commands for a language it cannot detect — the agnosticism guarantee', async () => {
    // Swift: zero detection support today. Declaring commands must still make
    // the gate real, or "language-agnostic" is a promise instead of a mechanism.
    await fs.writeFile(
      path.join(fixture.projectDir, 'Package.swift'),
      '// swift-tools-version:5.9\n'
    )
    await fs.mkdir(path.join(fixture.projectDir, '.prjct'), { recursive: true })
    await fs.writeFile(
      path.join(fixture.projectDir, '.prjct', 'prjct.config.json'),
      JSON.stringify({
        gauntlet: { commands: [{ kind: 'test', command: 'true' }] },
      })
    )

    const result = await runGauntlet(fixture.projectDir, fixture.projectId)

    expect(result.vacuous).toBe(false)
    expect(result.passed).toBe(true)
    expect(result.checks.map((c) => c.command)).toEqual(['true'])
  })

  it('declared commands REPLACE detection, and a red declared check blocks', async () => {
    await fs.writeFile(
      path.join(fixture.projectDir, 'package.json'),
      JSON.stringify({ name: 'fixture', scripts: { test: 'true' } })
    )
    await fs.mkdir(path.join(fixture.projectDir, '.prjct'), { recursive: true })
    await fs.writeFile(
      path.join(fixture.projectDir, '.prjct', 'prjct.config.json'),
      JSON.stringify({ gauntlet: { commands: [{ kind: 'test', command: 'false' }] } })
    )

    const result = await runGauntlet(fixture.projectDir, fixture.projectId)

    // The declared `false` ran, not the detected `true`.
    expect(result.checks.map((c) => c.command)).toEqual(['false'])
    expect(result.passed).toBe(false)
  })

  it('a tool that is not installed NEVER fails the gate (client environments differ)', async () => {
    // The client-hostile bug this guards: a Rust repo without `clippy`, a Java
    // repo without `mvn` on PATH, a Ruby repo before `bundle install` — the
    // command cannot RUN, which is an environment gap, not a code defect. A
    // ship must not be blocked by it, and it must never be reported as verified.
    await fs.mkdir(path.join(fixture.projectDir, '.prjct'), { recursive: true })
    await fs.writeFile(
      path.join(fixture.projectDir, '.prjct', 'prjct.config.json'),
      JSON.stringify({
        gauntlet: {
          commands: [
            { kind: 'test', command: 'true' },
            { kind: 'lint', command: 'prjct-no-such-binary-xyz' },
          ],
        },
      })
    )

    const result = await runGauntlet(fixture.projectDir, fixture.projectId)

    const lint = result.checks.find((c) => c.kind === 'lint')
    expect(lint?.unavailable).toBe(true)
    expect(lint?.outcome).toBe('unavailable')
    expect(result.passed).toBe(true) // not blocked by a missing tool
    expect(result.vacuous).toBe(false) // the `true` test really ran
    // …and the receipt says so out loud rather than faking a clean green.
    expect(renderGauntletMd(result)).toContain('could not run here')
  })

  it('is vacuous — never green — when NOTHING could run', async () => {
    await fs.mkdir(path.join(fixture.projectDir, '.prjct'), { recursive: true })
    await fs.writeFile(
      path.join(fixture.projectDir, '.prjct', 'prjct.config.json'),
      JSON.stringify({
        gauntlet: { commands: [{ kind: 'test', command: 'prjct-no-such-binary-xyz' }] },
      })
    )
    const result = await runGauntlet(fixture.projectDir, fixture.projectId)
    expect(result.vacuous).toBe(true)
  })

  it('gates a language with ZERO hardcoded support, straight from its CI', async () => {
    // A Swift package: no manifest support, no config, nobody taught prjct the
    // language. Its own CI names the verify step, so the gate is real anyway.
    // (The command is a harmless stand-in for `swift test` so the assertion
    // does not depend on a Swift toolchain being installed on the runner.)
    await fs.writeFile(
      path.join(fixture.projectDir, 'Package.swift'),
      '// swift-tools-version:5.9\n'
    )
    await fs.mkdir(path.join(fixture.projectDir, '.github', 'workflows'), { recursive: true })
    await fs.writeFile(
      path.join(fixture.projectDir, '.github', 'workflows', 'ci.yml'),
      ['jobs:', '  ci:', '    steps:', '      - name: Test', '        run: /bin/echo ok'].join('\n')
    )

    const result = await runGauntlet(fixture.projectDir, fixture.projectId)

    expect(result.vacuous).toBe(false) // the gate is NOT hollow for an unknown language
    expect(result.checks.map((c) => c.command)).toEqual(['/bin/echo ok'])
    expect(result.passed).toBe(true)
  })

  it('really EXECUTES a non-Node ecosystem end to end (make)', async () => {
    // The detection matrix only proves the right strings come back. This proves
    // the whole path — detect → run → receipt — works outside package.json,
    // using a toolchain every POSIX box has.
    await fs.writeFile(
      path.join(fixture.projectDir, 'Makefile'),
      'test:\n\t@echo running real make target\n'
    )

    const result = await runGauntlet(fixture.projectDir, fixture.projectId)

    expect(result.vacuous).toBe(false)
    expect(result.checks.map((c) => c.command)).toEqual(['make test'])
    expect(result.checks[0].unavailable).toBeFalsy()
    expect(result.passed).toBe(true)

    // And a red make target really blocks.
    await fs.writeFile(path.join(fixture.projectDir, 'Makefile'), 'test:\n\t@exit 3\n')
    const red = await runGauntlet(fixture.projectDir, fixture.projectId)
    expect(red.passed).toBe(false)
    // make reports its OWN failure code (2) when a recipe fails, not the
    // recipe's — the point is a real non-zero exit, classified as a defect
    // (not as an absent tool).
    expect(red.checks[0].outcome).toMatch(/^exit:/)
    expect(red.checks[0].unavailable).toBeFalsy()
  })

  it('runs detected commands and goes RED on a failing check', async () => {
    await fs.writeFile(
      path.join(fixture.projectDir, 'package.json'),
      JSON.stringify({
        name: 'fixture',
        scripts: { typecheck: 'true', lint: 'false', test: 'true' },
      })
    )

    const result = await runGauntlet(fixture.projectDir, fixture.projectId)

    expect(result.vacuous).toBe(false)
    expect(result.passed).toBe(false)
    const lint = result.checks.find((c) => c.kind === 'lint')
    expect(lint?.ok).toBe(false)
    expect(lint?.outcome).toBe('exit:1')
    expect(result.checks.filter((c) => c.ok).map((c) => c.kind)).toEqual(['typecheck', 'test'])
    // Non-git fixture: binding degrades to null, never fake-clean.
    expect(result.headSha).toBeNull()

    const stored = readGauntletReceipt(fixture.projectId)
    expect(stored?.data.passed).toBe(false)
  })
})

describe('gauntletShipVerdict', () => {
  const base = { nowMs: Date.now(), headSha: 'abc123', hasCommands: true, strict: false }

  it('a fresh RED receipt always blocks, even outside strict mode', () => {
    const verdict = gauntletShipVerdict({
      ...base,
      receipt: receipt({
        passed: false,
        checks: [{ kind: 'test', command: 'x', ok: false, outcome: 'exit:1', durationMs: 5 }],
      }),
      override: false,
    })
    expect(verdict.blocked).toBe(true)
    expect(verdict.message).toContain('RED')
  })

  it('missing receipt blocks under strict, warns otherwise', () => {
    const strict = gauntletShipVerdict({ ...base, receipt: null, strict: true, override: false })
    expect(strict.blocked).toBe(true)
    const loose = gauntletShipVerdict({ ...base, receipt: null, override: false })
    expect(loose.blocked).toBe(false)
    expect(loose.message).toContain('⚠')
  })

  it('a stale green receipt does not count as machine-verified', () => {
    const stale = gauntletShipVerdict({
      ...base,
      strict: true,
      receipt: receipt({ ranAt: new Date(Date.now() - GAUNTLET_FRESH_MS - 60_000).toISOString() }),
      override: false,
    })
    expect(stale.blocked).toBe(true)
  })

  it('a receipt for another HEAD is stale', () => {
    const moved = gauntletShipVerdict({
      ...base,
      strict: true,
      receipt: receipt({ headSha: 'other-head' }),
      override: false,
    })
    expect(moved.blocked).toBe(true)
  })

  it('fresh green passes; override passes and says so; no commands is vacuous', () => {
    expect(gauntletShipVerdict({ ...base, receipt: receipt(), override: false }).blocked).toBe(
      false
    )
    const overridden = gauntletShipVerdict({
      ...base,
      receipt: receipt({ passed: false }),
      override: true,
    })
    expect(overridden.blocked).toBe(false)
    expect(overridden.message).toContain('overridden')
    const vacuous = gauntletShipVerdict({
      ...base,
      receipt: null,
      hasCommands: false,
      override: false,
    })
    expect(vacuous.blocked).toBe(false)
    expect(vacuous.message).toMatch(/vacuous/i)
    // …and it tells the AGENT how to make the gate real for any language.
    expect(vacuous.message).toContain('prjct gauntlet set')
  })
})

describe('ensureShipGauntlet (self-provisioning)', () => {
  it('runs the gauntlet inline when the receipt is missing — nobody has to remember', async () => {
    await fs.writeFile(
      path.join(fixture.projectDir, 'package.json'),
      JSON.stringify({ name: 'fixture', scripts: { test: 'true' } })
    )
    expect(readGauntletReceipt(fixture.projectId)).toBeNull()

    const verdict = await ensureShipGauntlet(fixture.projectDir, fixture.projectId, {
      headSha: null,
      strict: false,
      override: false,
    })

    expect(verdict.blocked).toBe(false)
    expect(readGauntletReceipt(fixture.projectId)?.data.passed).toBe(true)
  })

  it('blocks on the REAL result when the inline run goes red — even outside strict', async () => {
    await fs.writeFile(
      path.join(fixture.projectDir, 'package.json'),
      JSON.stringify({ name: 'fixture', scripts: { test: 'false' } })
    )

    const verdict = await ensureShipGauntlet(fixture.projectDir, fixture.projectId, {
      headSha: null,
      strict: false,
      override: false,
    })

    expect(verdict.blocked).toBe(true)
    expect(verdict.message).toContain('RED')
  })

  it('does not re-run when a fresh green receipt already exists', async () => {
    await fs.writeFile(
      path.join(fixture.projectDir, 'package.json'),
      JSON.stringify({ name: 'fixture', scripts: { test: 'true' } })
    )
    await runGauntlet(fixture.projectDir, fixture.projectId)
    const ranAt = readGauntletReceipt(fixture.projectId)?.data.ranAt

    const verdict = await ensureShipGauntlet(fixture.projectDir, fixture.projectId, {
      headSha: null,
      strict: false,
      override: false,
    })

    expect(verdict.blocked).toBe(false)
    expect(readGauntletReceipt(fixture.projectId)?.data.ranAt).toBe(ranAt)
  })
})

describe('warmGauntletInBackground', () => {
  it('never spawns a real CLI under tests (PRJCT_TEST_MODE guard)', async () => {
    await fs.writeFile(
      path.join(fixture.projectDir, 'package.json'),
      JSON.stringify({ name: 'fixture', scripts: { test: 'false' } })
    )
    expect(await warmGauntletInBackground(fixture.projectDir, fixture.projectId)).toBe(false)
  })
})

describe('gauntletDoneWarning', () => {
  it('warns on done when the gauntlet is red or unproven', async () => {
    await fs.writeFile(
      path.join(fixture.projectDir, 'package.json'),
      JSON.stringify({ name: 'fixture', scripts: { test: 'false' } })
    )
    await runGauntlet(fixture.projectDir, fixture.projectId)
    const warning = await gauntletDoneWarning(fixture.projectDir, fixture.projectId)
    expect(warning).not.toBeNull()
  })

  it('stays silent when the project has no verify commands', async () => {
    const warning = await gauntletDoneWarning(fixture.projectDir, fixture.projectId)
    expect(warning).toBeNull()
  })
})
