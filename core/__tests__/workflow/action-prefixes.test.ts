/**
 * Coverage for the `version:bump`, `changelog:add`, `git:commit`, and
 * `git:push` action prefixes. The `git:*` tests assert cwd behaviour
 * explicitly — these were introduced to fix a bug where the daemon's
 * cwd (not the project's) was driving git commands.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import configManager from '../../infrastructure/config-manager'
import pathManager from '../../infrastructure/path-manager'
import { workflowRuleStorage } from '../../storage/workflow-rule-storage'
import type { WorkflowRunContext } from '../../types/workflow.js'
import { executeWorkflowRules } from '../../workflow-engine/workflow-engine'

async function freshProject(): Promise<{ projectPath: string; projectId: string }> {
  const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'prjct-prefix-test-'))
  await fs.mkdir(path.join(projectPath, '.prjct'), { recursive: true })
  const projectId = `test-${Math.random().toString(36).slice(2, 10)}`
  await configManager.writeConfig(projectPath, {
    projectId,
    dataPath: path.join(projectPath, '.prjct-data'),
  })
  // Built-in 'ship' workflow row is seeded by ensureProjectStructure.
  await pathManager.ensureProjectStructure(projectId)
  return { projectPath, projectId }
}

function addStep(projectId: string, action: string, sortOrder = 0): void {
  workflowRuleStorage.addRule(projectId, {
    type: 'step',
    command: 'ship',
    position: 'before',
    action,
    description: action,
    enabled: true,
    timeoutMs: 30000,
    createdAt: new Date().toISOString(),
    sortOrder,
  })
}

describe('action prefix: version:bump', () => {
  const fixture = { projectPath: '', projectId: '' }

  beforeEach(async () => {
    Object.assign(fixture, await freshProject())
  })

  afterEach(async () => {
    if (fixture.projectPath) await fs.rm(fixture.projectPath, { recursive: true, force: true })
  })

  test('bumps package.json version AND writes the new version into runContext', async () => {
    await fs.writeFile(
      path.join(fixture.projectPath, 'package.json'),
      JSON.stringify({ name: 'tmp', version: '1.2.3' }, null, 2)
    )
    addStep(fixture.projectId, 'version:bump')

    const runCtx: WorkflowRunContext = {}
    const result = await executeWorkflowRules(fixture.projectId, 'ship', 'before', {
      projectPath: fixture.projectPath,
      runContext: runCtx,
    })

    expect(result.success).toBe(true)
    expect(runCtx.version).toBe('1.2.4')
    const pkg = JSON.parse(
      await fs.readFile(path.join(fixture.projectPath, 'package.json'), 'utf-8')
    )
    expect(pkg.version).toBe('1.2.4')
  })

  test('does not touch a different cwd when fixture.projectPath is explicit', async () => {
    // Build a SECOND project that should remain untouched.
    const otherPath = await fs.mkdtemp(path.join(os.tmpdir(), 'prjct-prefix-other-'))
    await fs.writeFile(
      path.join(otherPath, 'package.json'),
      JSON.stringify({ name: 'other', version: '9.9.9' }, null, 2)
    )

    await fs.writeFile(
      path.join(fixture.projectPath, 'package.json'),
      JSON.stringify({ name: 'tmp', version: '1.2.3' }, null, 2)
    )
    addStep(fixture.projectId, 'version:bump')

    const runCtx: WorkflowRunContext = {}
    await executeWorkflowRules(fixture.projectId, 'ship', 'before', {
      projectPath: fixture.projectPath,
      runContext: runCtx,
    })

    const other = JSON.parse(await fs.readFile(path.join(otherPath, 'package.json'), 'utf-8'))
    expect(other.version).toBe('9.9.9')
    await fs.rm(otherPath, { recursive: true, force: true })
  })
})

describe('action prefix: changelog:add', () => {
  const fixture = { projectPath: '', projectId: '' }

  beforeEach(async () => {
    Object.assign(fixture, await freshProject())
  })

  afterEach(async () => {
    if (fixture.projectPath) await fs.rm(fixture.projectPath, { recursive: true, force: true })
  })

  test('requires version + feature in runContext', async () => {
    addStep(fixture.projectId, 'changelog:add')

    const result = await executeWorkflowRules(fixture.projectId, 'ship', 'before', {
      projectPath: fixture.projectPath,
      runContext: {},
    })
    expect(result.success).toBe(false)
    expect(result.output).toMatch(/version:bump|runContext/i)
  })

  test('appends a CHANGELOG entry when version + feature are present', async () => {
    await fs.writeFile(
      path.join(fixture.projectPath, 'package.json'),
      JSON.stringify({ name: 'tmp', version: '1.0.0' }, null, 2)
    )
    addStep(fixture.projectId, 'version:bump', 0)
    addStep(fixture.projectId, 'changelog:add', 1)

    const runCtx: WorkflowRunContext = { feature: 'flux capacitor' }
    const result = await executeWorkflowRules(fixture.projectId, 'ship', 'before', {
      projectPath: fixture.projectPath,
      runContext: runCtx,
    })

    expect(result.success).toBe(true)
    const changelog = await fs.readFile(path.join(fixture.projectPath, 'CHANGELOG.md'), 'utf-8')
    // A described feature ("flux capacitor", no fix/chore prefix) bumps MINOR.
    expect(changelog).toContain('1.1.0')
    expect(changelog).toContain('flux capacitor')
  })
})

describe('action prefix: git:commit / git:push', () => {
  const fixture = { projectPath: '', projectId: '' }

  beforeEach(async () => {
    Object.assign(fixture, await freshProject())
  })

  afterEach(async () => {
    if (fixture.projectPath) await fs.rm(fixture.projectPath, { recursive: true, force: true })
  })

  test('git:commit runs against projectPath, not process.cwd()', async () => {
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: fixture.projectPath })
    execFileSync('git', ['config', 'user.email', 'test@prjct.local'], { cwd: fixture.projectPath })
    execFileSync('git', ['config', 'user.name', 'test'], { cwd: fixture.projectPath })
    await fs.writeFile(path.join(fixture.projectPath, 'README.md'), '# tmp\n')
    execFileSync('git', ['add', '.'], { cwd: fixture.projectPath })
    execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: fixture.projectPath })

    // Stage a new file via the rule.
    await fs.writeFile(path.join(fixture.projectPath, 'new.txt'), 'hi\n')
    addStep(fixture.projectId, 'git:commit')

    const runCtx: WorkflowRunContext = { feature: 'welcome' }
    const result = await executeWorkflowRules(fixture.projectId, 'ship', 'before', {
      projectPath: fixture.projectPath,
      runContext: runCtx,
    })

    expect(result.success).toBe(true)
    const log = execFileSync('git', ['log', '-1', '--pretty=%s'], {
      cwd: fixture.projectPath,
      encoding: 'utf-8',
    })
    expect(log.trim()).toMatch(/welcome/)
  })

  test('git:push surfaces the real error when no remote is configured', async () => {
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: fixture.projectPath })
    execFileSync('git', ['config', 'user.email', 'test@prjct.local'], { cwd: fixture.projectPath })
    execFileSync('git', ['config', 'user.name', 'test'], { cwd: fixture.projectPath })
    await fs.writeFile(path.join(fixture.projectPath, 'README.md'), '# tmp\n')
    execFileSync('git', ['add', '.'], { cwd: fixture.projectPath })
    execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: fixture.projectPath })

    addStep(fixture.projectId, 'git:push')

    const result = await executeWorkflowRules(fixture.projectId, 'ship', 'before', {
      projectPath: fixture.projectPath,
      runContext: {},
    })
    expect(result.success).toBe(false)
    // Message varies by git version; accept "No configured push", "no remote",
    // or anything that clearly references pushing — just don't accept the old
    // "No changes to commit" lie.
    expect(result.output).not.toMatch(/No changes to commit/)
  })

  test('git:push sets upstream on a fresh branch with no upstream', async () => {
    // A bare repo acts as `origin`.
    const remotePath = await fs.mkdtemp(path.join(os.tmpdir(), 'prjct-prefix-remote-'))
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main'], { cwd: remotePath })

    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: fixture.projectPath })
    execFileSync('git', ['config', 'user.email', 'test@prjct.local'], { cwd: fixture.projectPath })
    execFileSync('git', ['config', 'user.name', 'test'], { cwd: fixture.projectPath })
    execFileSync('git', ['remote', 'add', 'origin', remotePath], { cwd: fixture.projectPath })
    await fs.writeFile(path.join(fixture.projectPath, 'README.md'), '# tmp\n')
    execFileSync('git', ['add', '.'], { cwd: fixture.projectPath })
    execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: fixture.projectPath })
    // Feature branch with NO upstream — the case a bare `git push` choked on.
    execFileSync('git', ['checkout', '-q', '-b', 'feat/x'], { cwd: fixture.projectPath })

    addStep(fixture.projectId, 'git:push')

    const result = await executeWorkflowRules(fixture.projectId, 'ship', 'before', {
      projectPath: fixture.projectPath,
      runContext: {},
    })

    expect(result.success).toBe(true)
    // Upstream is now set to origin/feat/x.
    const upstream = execFileSync(
      'git',
      ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'],
      { cwd: fixture.projectPath, encoding: 'utf-8' }
    )
    expect(upstream.trim()).toBe('origin/feat/x')

    await fs.rm(remotePath, { recursive: true, force: true })
  })
})

describe('action prefix: pr:ensure', () => {
  // Regression: `ship` used to stop at git:push — repeated ships on a
  // feature branch pushed commits with no PR ever opened/updated, silently
  // piling up unreviewed work (see PR #606). pr:ensure must never fail an
  // otherwise-successful ship over PR bookkeeping (missing/unauthenticated
  // `gh`, network errors) — every failure path is caught and reported as
  // an instruction line, never thrown. Full create/already-exists paths
  // need a real GitHub remote + gh auth and are verified manually, not here.
  const fixture = { projectPath: '', projectId: '' }

  beforeEach(async () => {
    Object.assign(fixture, await freshProject())
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: fixture.projectPath })
    execFileSync('git', ['config', 'user.email', 'test@prjct.local'], { cwd: fixture.projectPath })
    execFileSync('git', ['config', 'user.name', 'test'], { cwd: fixture.projectPath })
    await fs.writeFile(path.join(fixture.projectPath, 'README.md'), '# tmp\n')
    execFileSync('git', ['add', '.'], { cwd: fixture.projectPath })
    execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: fixture.projectPath })
  })

  afterEach(async () => {
    if (fixture.projectPath) await fs.rm(fixture.projectPath, { recursive: true, force: true })
  })

  test('is a silent no-op on main — never attempts gh at all', async () => {
    addStep(fixture.projectId, 'pr:ensure')

    const result = await executeWorkflowRules(fixture.projectId, 'ship', 'before', {
      projectPath: fixture.projectPath,
      runContext: {},
    })

    expect(result.success).toBe(true)
    expect(result.instructions).toEqual([])
  })

  test('reports (never fails) when there is no GitHub remote to operate against', async () => {
    // No `origin` remote configured — whether or not `gh` itself is on PATH
    // in the environment running this test (dev machines commonly install
    // git+gh side by side, so hiding gh via PATH is not reliably
    // reproducible), `gh pr list`/`gh pr create` cannot succeed without a
    // real GitHub remote. Every failure path here must report an
    // instruction and keep result.success true — never throw.
    execFileSync('git', ['checkout', '-q', '-b', 'feat/x'], { cwd: fixture.projectPath })
    addStep(fixture.projectId, 'pr:ensure')

    const result = await executeWorkflowRules(fixture.projectId, 'ship', 'before', {
      projectPath: fixture.projectPath,
      runContext: {},
    })
    expect(result.success).toBe(true)
    expect(result.instructions.some((i) => i.includes('pr:ensure'))).toBe(true)
  })
})
