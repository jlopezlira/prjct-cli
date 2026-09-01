/**
 * Entry-point tests for Dominance SUPERIOR program.
 * Drive the REAL choke points (startTask, ShippingCommands.ship, PrimitiveCommands.close)
 * — not pure verdict helpers. If shipping.ts / task-service.ts wiring is removed, these fail.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { PrimitiveCommands } from '../../commands/primitives'
import { ShippingCommands } from '../../commands/shipping'
import { REGISTERED_VERBS_SET } from '../../commands/verb-names'
import configManager from '../../infrastructure/config-manager'
import { projectMemory } from '../../memory/project-memory'
import { specService } from '../../services/spec-service'
import { startTask } from '../../services/task-service'
import { prjctDb } from '../../storage/database'
import { specStorage } from '../../storage/spec-storage'
import { stateStorage } from '../../storage/state-storage'

async function freshProject(cfg: Record<string, unknown> = {}): Promise<{
  projectPath: string
  projectId: string
}> {
  const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'prjct-sup-ep-'))
  await fs.mkdir(path.join(projectPath, '.prjct'), { recursive: true })
  const projectId = `sup-ep-${Math.random().toString(36).slice(2, 10)}`
  await configManager.writeConfig(projectPath, {
    projectId,
    dataPath: path.join(projectPath, '.prjct-data'),
    ...cfg,
  })
  // Ensure DB exists
  prjctDb.get(projectId, 'SELECT 1')
  return { projectPath, projectId }
}

function gitInitWithPackage(projectPath: string, deps: Record<string, string> = {}): void {
  execFileSync('git', ['init'], { cwd: projectPath, stdio: 'ignore' })
  execFileSync('git', ['config', 'user.email', 'test@prjct.local'], {
    cwd: projectPath,
    stdio: 'ignore',
  })
  execFileSync('git', ['config', 'user.name', 'prjct test'], { cwd: projectPath, stdio: 'ignore' })
  const pkg = JSON.stringify(
    { name: 'sup-ep-fixture', version: '0.0.1', dependencies: deps },
    null,
    2
  )
  require('node:fs').writeFileSync(path.join(projectPath, 'package.json'), pkg)
  execFileSync('git', ['add', 'package.json'], { cwd: projectPath, stdio: 'ignore' })
  execFileSync('git', ['commit', '-m', 'init'], { cwd: projectPath, stdio: 'ignore' })
}

describe('startTask entry-point (discuss-lock + nyquist wiring)', () => {
  const fixture = { projectPath: '', projectId: '' }

  afterEach(async () => {
    if (fixture.projectPath)
      await fs.rm(fixture.projectPath, { recursive: true, force: true }).catch(() => {})
  })

  it('blocks H2 work without reviewed spec when sdd is advisory', async () => {
    Object.assign(
      fixture,
      await freshProject({
        sdd: { mode: 'advisory' },
      })
    )
    // Description that classifies as H2 feature (not H0 smoke)
    const r = await startTask(
      fixture.projectId,
      fixture.projectPath,
      'implement multi-agent fan-out architecture for billing pipeline',
      { skipHooks: true }
    )
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.blocked).toMatch(/Discuss-lock|intent|spec/i)
    }
  })

  it('allows H0/H1 smoke description under advisory sdd (regression)', async () => {
    Object.assign(
      fixture,
      await freshProject({
        sdd: { mode: 'advisory' },
      })
    )
    const r = await startTask(fixture.projectId, fixture.projectPath, 'split-home smoke', {
      skipHooks: true,
    })
    // H0/H1 should not hit discuss-lock; may still succeed
    if (!r.ok) {
      // Must NOT be discuss-lock
      expect(r.blocked).not.toMatch(/Discuss-lock/i)
    } else {
      expect(r.ok).toBe(true)
    }
  })

  it('blocks H2 work with reviewed spec when ACs are vague (Nyquist via startTask)', async () => {
    Object.assign(
      fixture,
      await freshProject({
        sdd: { mode: 'strict' },
        tdd: { mode: 'strict' },
      })
    )
    // Real spec with prose-only ACs (no verifiable signal)
    const spec = await specService.create(fixture.projectPath, {
      title: 'Billing fan-out',
      content: {
        goal: 'Implement multi-agent fan-out for billing pipeline with durable ownership',
        acceptance_criteria: ['auth feels solid', 'UX is nicer overall'],
      },
      autoContext: false,
    })
    const reviewed = specStorage.setStatus(fixture.projectId, spec.id, 'reviewed')
    expect(reviewed?.status).toBe('reviewed')

    const r = await startTask(
      fixture.projectId,
      fixture.projectPath,
      'implement multi-agent fan-out architecture for billing pipeline',
      { skipHooks: true, spec: spec.id }
    )
    expect(r.ok).toBe(false)
    if (!r.ok) {
      // Must be Nyquist from task-service wiring (not discuss-lock — we have reviewed spec)
      expect(r.blocked).toMatch(/Nyquist/i)
      expect(r.blocked).not.toMatch(/Discuss-lock/i)
    }
  })
})

describe('ShippingCommands.ship entry-point gates', () => {
  const fixture = { projectPath: '', projectId: '' }
  const ship = new ShippingCommands()

  afterEach(async () => {
    if (fixture.projectPath)
      await fs.rm(fixture.projectPath, { recursive: true, force: true }).catch(() => {})
  })

  it('does not hard-block ship under critical density by default', async () => {
    Object.assign(
      fixture,
      await freshProject({
        maxTurnsPerCycle: 10,
        sdd: { mode: 'off' },
        deliveryGeometry: { mode: 'off' },
      })
    )
    // Active cycle with high turn count (critical = 70% of 10 = 7+)
    await stateStorage.startTask(fixture.projectId, {
      id: 'task-pressure',
      description: 'pressure fixture',
      sessionId: 'sess-pressure',
      turnCount: 9,
      tokensIn: 0,
      tokensOut: 0,
    })
    await stateStorage.updateCurrentTask(fixture.projectId, { turnCount: 9 })

    const result = await ship.ship('pressure fixture', fixture.projectPath, {
      md: true,
      skipHooks: true,
      noJudgmentGate: true,
    })
    // Default: density is soft — must NOT fail on context-pressure hard gate
    if (!result.success) {
      expect(String(result.error ?? '')).not.toMatch(
        /CONTEXT PRESSURE|force-pressure|hard-block|HARD GATE/i
      )
    }
  })

  it('hard-blocks ship only when contextPressure.hardBlockShip is opt-in', async () => {
    Object.assign(
      fixture,
      await freshProject({
        // Pressure is measured token spend against a configured budget —
        // a turn count is not context and no longer raises the level.
        maxTokensPerCycle: 100_000,
        sdd: { mode: 'off' },
        deliveryGeometry: { mode: 'off' },
        contextPressure: { hardBlockShip: true },
      })
    )
    await stateStorage.startTask(fixture.projectId, {
      id: 'task-pressure-hard',
      description: 'pressure fixture hard',
      sessionId: 'sess-pressure-hard',
      turnCount: 2,
      tokensIn: 85_000,
      tokensOut: 0,
    })
    await stateStorage.updateCurrentTask(fixture.projectId, { tokensIn: 85_000 })

    const blocked = await ship.ship('pressure fixture hard', fixture.projectPath, {
      md: true,
      skipHooks: true,
      noJudgmentGate: true,
    })
    expect(blocked.success).toBe(false)
    expect(String(blocked.error ?? '')).toMatch(/token budget|hard-block|force-pressure/i)

    const forced = await ship.ship('pressure fixture hard', fixture.projectPath, {
      md: true,
      skipHooks: true,
      noJudgmentGate: true,
      forcePressure: true,
    })
    if (!forced.success) {
      expect(String(forced.error ?? '')).not.toMatch(/hard-block|CONTEXT PRESSURE|HARD GATE/i)
    }
  })

  it('hard-blocks ship on new deps under strict pack without --allow-new-deps', async () => {
    Object.assign(
      fixture,
      await freshProject({
        sdd: { mode: 'strict' },
        deliveryGeometry: { mode: 'off' },
        maxTurnsPerCycle: 100,
      })
    )
    gitInitWithPackage(fixture.projectPath, { chalk: '^5.0.0' })
    // Add a NEW dependency vs HEAD
    const pkgPath = path.join(fixture.projectPath, 'package.json')
    const pkg = JSON.parse(await fs.readFile(pkgPath, 'utf-8')) as {
      dependencies: Record<string, string>
    }
    pkg.dependencies['left-pad'] = '^1.0.0'
    await fs.writeFile(pkgPath, JSON.stringify(pkg, null, 2))

    await stateStorage.startTask(fixture.projectId, {
      id: 'task-pkg',
      description: 'add left-pad',
      sessionId: 'sess-pkg',
      turnCount: 1,
      linkedSpecId: 'spec-fake-for-sdd',
    })

    const blocked = await ship.ship('add left-pad', fixture.projectPath, {
      md: true,
      skipHooks: true,
      noSpecGate: true, // prove package gate is independent of noSpecGate
      noJudgmentGate: true,
      forcePressure: true,
    })
    expect(blocked.success).toBe(false)
    expect(String(blocked.error ?? '')).toMatch(/Package legitimacy|allow-new-deps|left-pad/i)

    const allowed = await ship.ship('add left-pad', fixture.projectPath, {
      md: true,
      skipHooks: true,
      noSpecGate: true,
      noJudgmentGate: true,
      forcePressure: true,
      allowNewDeps: true,
    })
    if (!allowed.success) {
      expect(String(allowed.error ?? '')).not.toMatch(/Package legitimacy|allow-new-deps/i)
    }
  })

  it('hard-blocks large committed diffs without --geometry under deliveryGeometry strict', async () => {
    Object.assign(
      fixture,
      await freshProject({
        sdd: { mode: 'off' },
        deliveryGeometry: { mode: 'strict', locThreshold: 50 },
        maxTurnsPerCycle: 100,
      })
    )
    gitInitWithPackage(fixture.projectPath)
    // Branch ahead of main with a large committed change (merge-base ≠ HEAD)
    execFileSync('git', ['branch', '-M', 'main'], { cwd: fixture.projectPath, stdio: 'ignore' })
    execFileSync('git', ['checkout', '-b', 'feat/big'], {
      cwd: fixture.projectPath,
      stdio: 'ignore',
    })
    const big = Array.from({ length: 80 }, (_, i) => `export const line${i} = ${i}`).join('\n')
    require('node:fs').writeFileSync(path.join(fixture.projectPath, 'big-module.ts'), big)
    execFileSync('git', ['add', 'big-module.ts'], { cwd: fixture.projectPath, stdio: 'ignore' })
    execFileSync('git', ['commit', '-m', 'large change'], {
      cwd: fixture.projectPath,
      stdio: 'ignore',
    })

    await stateStorage.startTask(fixture.projectId, {
      id: 'task-geom',
      description: 'land large change',
      sessionId: 'sess-geom',
      turnCount: 1,
    })

    const blocked = await ship.ship('land large change', fixture.projectPath, {
      md: true,
      skipHooks: true,
      // Answer the first-step contradictory-review question so this test
      // reaches the gate it is actually about. Declining is a separate consent
      // from --no-judgment-gate and is never implied by it.
      intent: 'review-skip',
      noJudgmentGate: true,
      forcePressure: true,
      allowNewDeps: true,
      // no geometry — must hard-block
    })
    expect(blocked.success).toBe(false)
    expect(String(blocked.error ?? '')).toMatch(/Delivery geometry|geometry|--geometry/i)

    const withGeom = await ship.ship('land large change', fixture.projectPath, {
      md: true,
      skipHooks: true,
      intent: 'review-skip',
      noJudgmentGate: true,
      forcePressure: true,
      allowNewDeps: true,
      geometry: 'split',
    })
    if (!withGeom.success) {
      expect(String(withGeom.error ?? '')).not.toMatch(/Delivery geometry|--geometry/i)
    }
  })

  it('hard-blocks code-strict judgment without ledger; --no-judgment-gate overrides (not --no-spec-gate)', async () => {
    Object.assign(
      fixture,
      await freshProject({
        sdd: { mode: 'off' },
        deliveryGeometry: { mode: 'off' },
        maxTurnsPerCycle: 100,
        persona: { role: 'DEV', packs: ['code-strict'] },
      })
    )
    gitInitWithPackage(fixture.projectPath)
    // Large committed change so intensity can be full (optional — pack forces full)
    await stateStorage.startTask(fixture.projectId, {
      id: 'task-judge',
      description: 'ship grade change',
      sessionId: 'sess-judge',
      turnCount: 1,
    })

    const blocked = await ship.ship('ship grade change', fixture.projectPath, {
      md: true,
      skipHooks: true,
      noSpecGate: true, // must NOT bypass judgment
      forcePressure: true,
      allowNewDeps: true,
    })
    expect(blocked.success).toBe(false)
    expect(String(blocked.error ?? '')).toMatch(/judgment|no-judgment-gate|ledger/i)

    const withSpecGateOnly = await ship.ship('ship grade change', fixture.projectPath, {
      md: true,
      skipHooks: true,
      noSpecGate: true,
      forcePressure: true,
      allowNewDeps: true,
    })
    // Still blocked on judgment
    expect(withSpecGateOnly.success).toBe(false)

    const overridden = await ship.ship('ship grade change', fixture.projectPath, {
      md: true,
      skipHooks: true,
      noJudgmentGate: true,
      forcePressure: true,
      allowNewDeps: true,
      noSpecGate: true,
    })
    if (!overridden.success) {
      expect(String(overridden.error ?? '')).not.toMatch(/judgment|no-judgment-gate|ledger/i)
    }
  })
})

describe('PrimitiveCommands.close entry-point (resolve trail)', () => {
  const fixture = { projectPath: '', projectId: '' }
  const cmd = new PrimitiveCommands()

  beforeEach(async () => {
    Object.assign(fixture, await freshProject())
  })

  afterEach(async () => {
    await fs.rm(fixture.projectPath, { recursive: true, force: true }).catch(() => {})
  })

  it('close verb is registered', () => {
    expect(REGISTERED_VERBS_SET.has('close')).toBe(true)
  })

  it('removes entry from rotation and writes status:closed + resolves trail', async () => {
    await projectMemory.remember(fixture.projectPath, {
      type: 'inbox',
      content: 'triage this inbox item about package legitimacy noise for close test',
      tags: { source: 'manual' },
      projectId: fixture.projectId,
    })
    const before = projectMemory.allEntriesForIndex(fixture.projectId)
    const target = before.find((e) => /package legitimacy noise/.test(e.content ?? ''))
    expect(target).toBeTruthy()
    const targetId = target!.id

    const result = await cmd.close(targetId, fixture.projectPath, {
      md: true,
      reason: 'resolved in dominance program',
    })
    expect(result.success).toBe(true)

    // Gone from live rotation
    const after = projectMemory.allEntriesForIndex(fixture.projectId)
    expect(after.some((e) => e.id === targetId)).toBe(false)

    // Durable trail: closed context with resolves + status tags
    const trail = after.find(
      (e) =>
        e.type === 'context' &&
        /Closed/.test(e.content ?? '') &&
        (e.tags?.status === 'closed' || e.tags?.resolves)
    )
    expect(trail).toBeTruthy()
    expect(trail?.tags?.status).toBe('closed')
    expect(String(trail?.tags?.resolves ?? '')).toMatch(new RegExp(targetId.replace('mem_', '')))
    expect(trail?.content).toMatch(/resolved in dominance program|Closed/)
  })
})
