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
import { customWorkflowStorage } from '../../storage/custom-workflow-storage'
import { prjctDb } from '../../storage/database'
import { judgmentLedgerStorage } from '../../storage/judgment-ledger-storage'
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

function commitFixtureState(projectPath: string): void {
  execFileSync('git', ['add', '--all'], { cwd: projectPath })
  execFileSync('git', ['commit', '--allow-empty', '-m', 'init', '-q'], { cwd: projectPath })
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

  test('fails closed before review when authoritative project settings are malformed', async () => {
    await fs.writeFile(configManager.getProjectSettingsPath(fixture.projectId), '{ malformed')

    const result = await fixture.cmd.ship('release notes', fixture.projectPath, { md: true })

    expect(result.success).toBe(false)
    expect(String(result.error)).toContain('Project settings')
    expect(judgmentLedgerStorage.get(fixture.projectId)).toBeNull()
    expect(await shippedStorage.getCount(fixture.projectId)).toBe(0)
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
    commitFixtureState(fixture.projectPath)

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

  test('does not seed a duplicate verify gate when gauntlet owns machine verification', async () => {
    await fs.writeFile(
      path.join(fixture.projectPath, 'package.json'),
      JSON.stringify({ name: 'codeproj', version: '0.5.0', scripts: { test: 'true' } })
    )
    await seedCodeShipRules(fixture.projectId, fixture.projectPath)
    const actions = workflowRuleStorage
      .getRulesForCommand(fixture.projectId, 'ship')
      .map((r) => r.action)
    expect(actions.some((a) => a.startsWith('verify:'))).toBe(false)
  })

  test('fresh green gauntlet retires the legacy Stop-Slop gate instead of re-running tests', async () => {
    await fs.writeFile(
      path.join(fixture.projectPath, 'package.json'),
      JSON.stringify({ name: 'codeproj', version: '0.5.0', scripts: { test: 'exit 99' } })
    )
    await configManager.writeConfig(fixture.projectPath, {
      projectId: fixture.projectId,
      dataPath: path.join(fixture.projectPath, '.prjct-data'),
      gauntlet: { commands: [{ kind: 'test', command: 'true' }] },
    })
    initGit(fixture.projectPath)
    execFileSync('git', ['add', '.'], { cwd: fixture.projectPath })
    execFileSync('git', ['commit', '-m', 'init', '-q'], { cwd: fixture.projectPath })
    const headSha = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: fixture.projectPath,
      encoding: 'utf8',
    }).trim()
    prjctDb.setDoc(fixture.projectId, 'gauntlet:latest', {
      version: 1,
      ranAt: new Date().toISOString(),
      headSha,
      dirty: false,
      passed: true,
      vacuous: false,
      checks: [{ kind: 'test', command: 'true', ok: true, outcome: 'ok', durationMs: 1 }],
    })
    const now = new Date().toISOString()
    workflowRuleStorage.addRule(fixture.projectId, {
      type: 'gate',
      command: 'ship',
      position: 'before',
      action: 'verify:bun run test',
      description: 'Verify before shipping (Stop-Slop)',
      enabled: true,
      timeoutMs: 300_000,
      sortOrder: 1,
      createdAt: now,
    })
    workflowRuleStorage.addRule(fixture.projectId, {
      type: 'step',
      command: 'ship',
      position: 'before',
      action: 'touch shipped-marker',
      description: 'Test ship marker',
      enabled: true,
      timeoutMs: 5_000,
      sortOrder: 2,
      createdAt: now,
    })

    const result = await fixture.cmd.ship('deduplicated verification', fixture.projectPath, {
      md: true,
      intent: 'proceed',
    })

    expect(result.success).toBe(true)
    expect(await fs.readFile(path.join(fixture.projectPath, 'shipped-marker'), 'utf8')).toBe('')
    expect(
      workflowRuleStorage
        .getRulesForCommand(fixture.projectId, 'ship')
        .some((rule) => rule.action.startsWith('verify:'))
    ).toBe(false)
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
    commitFixtureState(fixture.projectPath)

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

describe('ship() — PR convention', () => {
  const fixture: {
    projectPath: string
    projectId: string
    cmd: ShippingCommands
  } = { projectPath: '', projectId: '', cmd: undefined as unknown as ShippingCommands }

  beforeEach(async () => {
    ;({ projectPath: fixture.projectPath, projectId: fixture.projectId } = await freshProject())
    fixture.cmd = new ShippingCommands()
    await fs.writeFile(
      path.join(fixture.projectPath, 'package.json'),
      JSON.stringify({ name: 'codeproj', version: '0.5.0' })
    )
  })

  afterEach(async () => {
    if (fixture.projectPath) await fs.rm(fixture.projectPath, { recursive: true, force: true })
  })

  test('a pre-set manual convention keeps seedCodeShipRules from adding pr:ensure', async () => {
    initGit(fixture.projectPath)
    execFileSync('git', ['remote', 'add', 'origin', 'git@github.com:acme/widgets.git'], {
      cwd: fixture.projectPath,
    })
    customWorkflowStorage.updateWorkflow(fixture.projectId, 'ship', {
      metadata: { prConvention: 'manual' },
    })

    await seedCodeShipRules(fixture.projectId, fixture.projectPath)

    const actions = workflowRuleStorage
      .getRulesForCommand(fixture.projectId, 'ship')
      .map((r) => r.action)
    expect(actions).toContain('git:push')
    expect(actions).not.toContain('pr:ensure')
  })

  test('an undecided GitHub project defaults to auto and persists the decision', async () => {
    initGit(fixture.projectPath)
    execFileSync('git', ['remote', 'add', 'origin', 'git@github.com:acme/widgets.git'], {
      cwd: fixture.projectPath,
    })

    await seedCodeShipRules(fixture.projectId, fixture.projectPath)

    const actions = workflowRuleStorage
      .getRulesForCommand(fixture.projectId, 'ship')
      .map((r) => r.action)
    expect(actions).toContain('pr:ensure')
    expect(customWorkflowStorage.getWorkflow(fixture.projectId, 'ship')?.metadata).toEqual({
      prConvention: 'auto',
    })
  })

  test('a project seeded before pr:ensure existed gets asked once, then never again', async () => {
    // Simulate a project whose ship steps predate this feature: gate +
    // 4 steps, no pr:ensure, no stored prConvention — the exact shape
    // this repo's own workflow_rules were in before this session.
    initGit(fixture.projectPath, 'feat/legacy')
    commitFixtureState(fixture.projectPath)
    const now = new Date().toISOString()
    for (const [i, action] of [
      'git branch --show-current | grep -vE "^(main|master)$"',
      'version:bump',
      'changelog:add',
      'git:commit',
      'git:push',
    ].entries()) {
      workflowRuleStorage.addRule(fixture.projectId, {
        type: action.startsWith('git branch') ? 'gate' : 'step',
        command: 'ship',
        position: 'before',
        action,
        description: action,
        enabled: true,
        timeoutMs: 30000,
        sortOrder: i + 1,
        createdAt: now,
      })
    }

    const asked = await fixture.cmd.ship('legacy release', fixture.projectPath, { md: true })
    expect(asked.success).toBe(false)
    const c = asked.clarification as { options: string[] } | undefined
    expect(c?.options).toEqual(['pr-convention-auto', 'pr-convention-manual'])

    // Answering persists the decision and adds pr:ensure — the changelog
    // step already ran once above (before the gate re-blocks it); use
    // --intent=pr-convention-manual so this test doesn't also need a
    // configured remote for pr:ensure/git:push to succeed against.
    await fixture.cmd.ship('legacy release', fixture.projectPath, {
      md: true,
      intent: 'pr-convention-manual',
    })
    expect(customWorkflowStorage.getWorkflow(fixture.projectId, 'ship')?.metadata).toEqual({
      prConvention: 'manual',
    })

    // Re-invoking without an intent no longer asks the PR-convention
    // question (only whatever gate/task-state applies next).
    const again = await fixture.cmd.ship('legacy release', fixture.projectPath, { md: true })
    const c2 = again.clarification as { options: string[] } | undefined
    expect(c2?.options).not.toEqual(['pr-convention-auto', 'pr-convention-manual'])
  })

  test('--intent=pr-convention-auto persists auto and adds the pr:ensure step', async () => {
    initGit(fixture.projectPath, 'feat/legacy')
    commitFixtureState(fixture.projectPath)
    const now = new Date().toISOString()
    for (const [i, action] of [
      'version:bump',
      'changelog:add',
      'git:commit',
      'git:push',
    ].entries()) {
      workflowRuleStorage.addRule(fixture.projectId, {
        type: 'step',
        command: 'ship',
        position: 'before',
        action,
        description: action,
        enabled: true,
        timeoutMs: 30000,
        sortOrder: i + 1,
        createdAt: now,
      })
    }

    await fixture.cmd.ship('legacy release', fixture.projectPath, {
      md: true,
      intent: 'pr-convention-auto',
    })

    expect(customWorkflowStorage.getWorkflow(fixture.projectId, 'ship')?.metadata).toEqual({
      prConvention: 'auto',
    })
    const actions = workflowRuleStorage
      .getRulesForCommand(fixture.projectId, 'ship')
      .map((r) => r.action)
    expect(actions).toContain('pr:ensure')
  })
})

/**
 * Contradictory review is the FIRST step of ship: it asks before every other
 * gate, and only an approved-and-still-bound ledger gets past the question.
 */
describe('ship() — contradictory review gate', () => {
  const fixture: { projectPath: string; projectId: string; cmd: ShippingCommands } = {
    projectPath: '',
    projectId: '',
    cmd: undefined as unknown as ShippingCommands,
  }

  beforeEach(async () => {
    ;({ projectPath: fixture.projectPath, projectId: fixture.projectId } = await freshProject())
    fixture.cmd = new ShippingCommands()
    // A branch ahead of main — merge-base ≠ HEAD is what makes a changeset
    // reviewable. Without it there is nothing to contradict and ship is silent.
    initGit(fixture.projectPath, 'main')
    await fs.writeFile(path.join(fixture.projectPath, 'base.ts'), 'export const a = 1\n')
    execFileSync('git', ['add', '.'], { cwd: fixture.projectPath })
    execFileSync('git', ['commit', '-m', 'base'], { cwd: fixture.projectPath })
    execFileSync('git', ['checkout', '-q', '-b', 'feat/thing'], { cwd: fixture.projectPath })
    await fs.writeFile(path.join(fixture.projectPath, 'base.ts'), 'export const a = 2\n')
    execFileSync('git', ['add', '.'], { cwd: fixture.projectPath })
    execFileSync('git', ['commit', '-m', 'change'], { cwd: fixture.projectPath })
  })

  afterEach(async () => {
    if (fixture.projectPath) await fs.rm(fixture.projectPath, { recursive: true, force: true })
  })

  test('asks before any other gate, and ships nothing', async () => {
    const result = await fixture.cmd.ship('a feature', fixture.projectPath, { md: true })
    expect(result.success).toBe(false)
    const c = result.clarification as { options: string[]; question: string } | undefined
    expect(c?.options).toEqual(['review-full', 'review-standard', 'review-skip', 'abort'])
    expect(c?.question).toMatch(/RED \(attack\) \+ BLUE \(defense\)/)
    expect(await shippedStorage.getAll(fixture.projectId)).toHaveLength(0)
  })

  test('asks for review when the payload exists only in the dirty tree', async () => {
    execFileSync('git', ['reset', '--hard', 'main'], { cwd: fixture.projectPath })
    await fs.writeFile(path.join(fixture.projectPath, 'base.ts'), 'export const dirty = 1\n')
    await fs.writeFile(path.join(fixture.projectPath, 'untracked.ts'), 'export const fresh = 1\n')

    const result = await fixture.cmd.ship('dirty feature', fixture.projectPath, { md: true })
    const clarification = result.clarification as { options?: string[] } | undefined

    expect(result.success).toBe(false)
    expect(clarification?.options).toContain('review-standard')
  })

  test('review-full opens a dual-blind ledger and still does not ship', async () => {
    const result = await fixture.cmd.ship('a feature', fixture.projectPath, {
      md: true,
      intent: 'review-full',
    })
    expect(result.success).toBe(false)
    expect(String(result.error ?? '')).toMatch(/Contradictory review/i)
    expect(judgmentLedgerStorage.get(fixture.projectId)?.intensity).toBe('full')
    expect(await shippedStorage.getAll(fixture.projectId)).toHaveLength(0)
  })

  test('review-skip clears the question and records the decline', async () => {
    const result = await fixture.cmd.ship('a feature', fixture.projectPath, {
      md: true,
      intent: 'review-skip',
    })
    // Past the review gate — whatever stops ship now is a later gate, not this one.
    const c = result.clarification as { options: string[] } | undefined
    expect(c?.options ?? []).not.toContain('review-full')
    expect(prjctDb.getDoc(fixture.projectId, 'ship:review_choice')).toMatchObject({
      choice: 'skip',
      branch: 'feat/thing',
    })
  })

  test('a recorded decline does not silence the next ask', async () => {
    await fixture.cmd.ship('a feature', fixture.projectPath, { md: true, intent: 'review-skip' })
    const again = await fixture.cmd.ship('a feature', fixture.projectPath, { md: true })
    const c = again.clarification as { options: string[] } | undefined
    expect(c?.options).toContain('review-full')
  })

  test('register-only ships a row without asking — no diff to contradict', async () => {
    const result = await fixture.cmd.ship('release notes', fixture.projectPath, {
      md: true,
      intent: 'register-only',
    })
    expect(result.success).toBe(true)
    expect(await shippedStorage.getAll(fixture.projectId)).toHaveLength(1)
  })
})

describe('ship() — QA gate', () => {
  const fixture: { projectPath: string; projectId: string; cmd: ShippingCommands } = {
    projectPath: '',
    projectId: '',
    cmd: undefined as unknown as ShippingCommands,
  }

  beforeEach(async () => {
    ;({ projectPath: fixture.projectPath, projectId: fixture.projectId } = await freshProject())
    await configManager.writeConfig(fixture.projectPath, {
      projectId: fixture.projectId,
      dataPath: path.join(fixture.projectPath, '.prjct-data'),
      qa: { mode: 'strict' },
    })
    fixture.cmd = new ShippingCommands()
    initGit(fixture.projectPath, 'main')
    await fs.writeFile(path.join(fixture.projectPath, 'base.ts'), 'export const a = 1\n')
    execFileSync('git', ['add', '.'], { cwd: fixture.projectPath })
    execFileSync('git', ['commit', '-m', 'base'], { cwd: fixture.projectPath })
    execFileSync('git', ['checkout', '-q', '-b', 'feat/thing'], { cwd: fixture.projectPath })
    await fs.writeFile(path.join(fixture.projectPath, 'base.ts'), 'export const a = 2\n')
    execFileSync('git', ['add', '.'], { cwd: fixture.projectPath })
    execFileSync('git', ['commit', '-m', 'change'], { cwd: fixture.projectPath })
    const { startTask } = await import('../../services/task-service')
    const started = await startTask(
      fixture.projectId,
      fixture.projectPath,
      'add billing retry handling',
      { skipHooks: true }
    )
    expect(started.ok).toBe(true)
  })

  afterEach(async () => {
    if (fixture.projectPath) await fs.rm(fixture.projectPath, { recursive: true, force: true })
  })

  test('strict blocks a ship whose cycle has no verified QA plan', async () => {
    const result = await fixture.cmd.ship('a feature', fixture.projectPath, {
      md: true,
      intent: 'review-skip',
    })
    expect(result.success).toBe(false)
    expect(String(result.error ?? '')).toMatch(/QA gate \(strict\)/)
    expect(await shippedStorage.getAll(fixture.projectId)).toHaveLength(0)
  })

  test('--no-qa-gate proceeds past the gate and records the override', async () => {
    const result = await fixture.cmd.ship('a feature', fixture.projectPath, {
      md: true,
      intent: 'review-skip',
      noQaGate: true,
    })
    expect(String(result.error ?? '')).not.toMatch(/QA gate/)
    const events = prjctDb.getEvents(fixture.projectId, 'qa-override')
    expect(events.length).toBeGreaterThan(0)
  })
})
