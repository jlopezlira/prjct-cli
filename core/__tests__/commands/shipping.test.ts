/**
 * ship() workflow-first dispatcher coverage.
 *
 * Ship used to hardcode version bump + changelog + git commit/push.
 * After the refactor, ship is a dispatcher: it runs configured
 * workflow rules, records the shipped row, and asks the user via
 * `clarification` when the state is ambiguous.
 */

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  setDefaultTimeout,
  type spyOn,
  test,
} from 'bun:test'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { ShippingCommands, seedCodeShipRules } from '../../commands/shipping'
import configManager from '../../infrastructure/config-manager'
import pathManager from '../../infrastructure/path-manager'
import { prjctDb } from '../../storage/database'
import { shippedStorage } from '../../storage/shipped-storage'
import { workflowRuleStorage } from '../../storage/workflow-rule-storage'

// Each test does a REAL ship: temp project + DB init + workflow
// dispatch + vault regen + cleanup. That exceeds bun's 5s default
// under CI load (flaky timeout at exactly 5001ms). Match the repo
// convention for heavy real-I/O command tests (update-cleanup.test.ts).
setDefaultTimeout(60_000)

// Mirrors the (module-local) marker key in shipping.ts.
const SHIP_MARKER_KEY = 'ship:in_progress'

async function freshProject(): Promise<{ projectPath: string; projectId: string }> {
  const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'prjct-ship-test-'))
  await fs.mkdir(path.join(projectPath, '.prjct'), { recursive: true })
  const projectId = `test-${Math.random().toString(36).slice(2, 10)}`
  await configManager.writeConfig(projectPath, {
    projectId,
    dataPath: path.join(projectPath, '.prjct-data'),
  })
  // ensureProjectStructure initialises the DB and seeds the built-in
  // 'ship' workflow row — no need to create a custom_workflows entry.
  await pathManager.ensureProjectStructure(projectId)
  return { projectPath, projectId }
}

function initGit(projectPath: string, branch = 'develop'): void {
  execFileSync('git', ['init', '-q', '-b', branch], { cwd: projectPath })
  execFileSync('git', ['config', 'user.email', 'test@prjct.local'], { cwd: projectPath })
  execFileSync('git', ['config', 'user.name', 'test'], { cwd: projectPath })
}

describe('ship() — workflow-first', () => {
  const fixture: {
    projectPath: string
    projectId: string
    cmd: ShippingCommands
    spies: Array<ReturnType<typeof spyOn>>
  } = {
    projectPath: '',
    projectId: '',
    cmd: undefined as unknown as ShippingCommands,
    spies: [],
  }

  beforeEach(async () => {
    ;({ projectPath: fixture.projectPath, projectId: fixture.projectId } = await freshProject())
    fixture.cmd = new ShippingCommands()
  })

  afterEach(async () => {
    for (const s of fixture.spies) s.mockRestore()
    fixture.spies = []
    if (fixture.projectPath) await fs.rm(fixture.projectPath, { recursive: true, force: true })
  })

  test('non-code project with no rules → returns clarification, does not touch anything', async () => {
    const result = await fixture.cmd.ship('release notes', fixture.projectPath, { md: true })
    expect(result.success).toBe(false)
    expect(result.clarification).toBeDefined()
    const c = result.clarification as { options: string[] }
    expect(c.options).toContain('register-only')
    expect(c.options).toContain('seed-code-workflow')
    expect(c.options).toContain('abort')
    // No CHANGELOG should have been written.
    const exists = await fs
      .access(path.join(fixture.projectPath, 'CHANGELOG.md'))
      .then(() => true)
      .catch(() => false)
    expect(exists).toBe(false)
  })

  test('register-only intent records the shipped row without touching files', async () => {
    const result = await fixture.cmd.ship('write blog post', fixture.projectPath, {
      md: true,
      intent: 'register-only',
    })

    expect(result.success).toBe(true)
    expect(result.version).toBe('unversioned')
    expect(result.feature).toBe('write blog post')

    const pkgExists = await fs
      .access(path.join(fixture.projectPath, 'package.json'))
      .then(() => true)
      .catch(() => false)
    expect(pkgExists).toBe(false)
  })

  test('reconciles an interrupted ship (marker → shipped row) idempotently', async () => {
    // Simulate a prior ship that pushed v9.9.9 but crashed before recording.
    prjctDb.setDoc(fixture.projectId, SHIP_MARKER_KEY, {
      feature: 'lost feature',
      version: '9.9.9',
      startedAt: new Date().toISOString(),
    })

    // The next ship must reconcile the marker BEFORE its own work.
    const r = await fixture.cmd.ship('next thing', fixture.projectPath, {
      md: true,
      intent: 'register-only',
    })
    expect(r.success).toBe(true)

    // The interrupted ship's row was recovered…
    expect(await shippedStorage.getByVersion(fixture.projectId, '9.9.9')).toBeTruthy()
    // …the marker was cleared…
    expect(prjctDb.getDoc(fixture.projectId, SHIP_MARKER_KEY)).toBeNull()
    // …and the current ship still recorded its own row.
    const all = await shippedStorage.getAll(fixture.projectId)
    expect(all.some((s) => s.name === 'next thing')).toBe(true)
  })

  test('reconcile is a no-op when the marker version is already recorded', async () => {
    await shippedStorage.addShipped(fixture.projectId, { name: 'already done', version: '5.0.0' })
    prjctDb.setDoc(fixture.projectId, SHIP_MARKER_KEY, {
      feature: 'already done',
      version: '5.0.0',
      startedAt: new Date().toISOString(),
    })

    await fixture.cmd.ship('another', fixture.projectPath, { md: true, intent: 'register-only' })

    const all = await shippedStorage.getAll(fixture.projectId)
    // No duplicate 5.0.0 row, and the stale marker is cleared.
    expect(all.filter((s) => s.version === '5.0.0')).toHaveLength(1)
    expect(prjctDb.getDoc(fixture.projectId, SHIP_MARKER_KEY)).toBeNull()
  })

  test('code project auto-seeds ship rules on first run (migration path)', async () => {
    await fs.writeFile(
      path.join(fixture.projectPath, 'package.json'),
      JSON.stringify({ name: 'codeproj', version: '0.5.0' }, null, 2)
    )
    initGit(fixture.projectPath)
    execFileSync('git', ['commit', '--allow-empty', '-m', 'init', '-q'], {
      cwd: fixture.projectPath,
    })

    // No rules pre-seeded — ship should auto-seed then proceed (push will
    // fail for lack of remote, but commit should land).
    await fixture.cmd.ship('first ship', fixture.projectPath, { md: true })

    const rules = workflowRuleStorage.getRulesForCommand(fixture.projectId, 'ship')
    const actions = rules.map((r) => r.action)
    expect(actions).toContain('version:bump')
    expect(actions).toContain('changelog:add')
    expect(actions).toContain('git:commit')
    expect(actions).toContain('git:push')

    const pkg = JSON.parse(
      await fs.readFile(path.join(fixture.projectPath, 'package.json'), 'utf-8')
    )
    // "first ship" is a described feature (no fix/chore prefix) → MINOR bump.
    expect(pkg.version).toBe('0.6.0')
  })

  test('seeds a Stop-Slop verify gate when the project has a test command', async () => {
    await fs.writeFile(
      path.join(fixture.projectPath, 'package.json'),
      JSON.stringify({ name: 'codeproj', version: '0.5.0', scripts: { test: 'true' } })
    )
    await seedCodeShipRules(fixture.projectId, fixture.projectPath)
    const actions = workflowRuleStorage
      .getRulesForCommand(fixture.projectId, 'ship')
      .map((r) => r.action)
    expect(actions.some((a) => a.startsWith('verify:'))).toBe(true)
  })

  test('seeds no verify gate when the project has no test command', async () => {
    await fs.writeFile(
      path.join(fixture.projectPath, 'package.json'),
      JSON.stringify({ name: 'codeproj', version: '0.5.0' })
    )
    await seedCodeShipRules(fixture.projectId, fixture.projectPath)
    const actions = workflowRuleStorage
      .getRulesForCommand(fixture.projectId, 'ship')
      .map((r) => r.action)
    expect(actions.some((a) => a.startsWith('verify:'))).toBe(false)
  })

  test('no-arg code ship derives the release description from the feature branch', async () => {
    await fs.writeFile(
      path.join(fixture.projectPath, 'package.json'),
      JSON.stringify({ name: 'codeproj', version: '0.5.0' }, null, 2)
    )
    initGit(fixture.projectPath, 'feat/universal-agent-compat')
    execFileSync('git', ['commit', '--allow-empty', '-m', 'init', '-q'], {
      cwd: fixture.projectPath,
    })

    const result = await fixture.cmd.ship(null, fixture.projectPath, { md: true })

    // No remote is configured, so the auto-seeded workflow fails at git:push.
    // The changelog step has already run by then, which is the regression
    // surface this test covers.
    expect(result.success).toBe(false)

    const changelog = await fs.readFile(path.join(fixture.projectPath, 'CHANGELOG.md'), 'utf-8')
    expect(changelog).toContain('## [0.6.0]')
    expect(changelog).toContain('- universal agent compat')
    expect(changelog).not.toContain('current work')
  })

  test('seed-code-workflow on a non-code project returns a helpful error', async () => {
    const result = await fixture.cmd.ship(null, fixture.projectPath, {
      md: true,
      intent: 'seed-code-workflow',
    })
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/does not look like code/i)
  })
})
