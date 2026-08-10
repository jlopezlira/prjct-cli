/**
 * gentle-ai v2.2.0 value steals:
 *  A1 — content-bound no-stamp fail-closed under hard
 *  B1 — delivery kill switch outranks gate overrides
 *  C1 — audit candidate hash binds lens admission
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { ShippingCommands } from '../../commands/shipping'
import configManager from '../../infrastructure/config-manager'
import { contentBoundDriftVerdict } from '../../services/content-bound-stamp'
import {
  computeAuditCandidateHash,
  reviewsGatePassedRelational,
} from '../../services/spec-audit-dispatch'
import { prjctDb } from '../../storage/database'
import { specStorage } from '../../storage/spec-storage'
import { emptySpecContent, type SpecContent } from '../../types/spec'
import { patchPathManager, restorePathManager } from '../_setup/path-manager-mock'

describe('A1 content-bound no-stamp', () => {
  it('hard-blocks missing stamp', () => {
    const v = contentBoundDriftVerdict({
      stamp: null,
      currentTreeHash: 'abc',
      hard: true,
    })
    expect(v.blocked).toBe(true)
    expect(v.reason).toBe('no-stamp')
    expect(v.message).toMatch(/content-bound stamp missing/i)
  })
})

describe('B1 delivery kill switch', () => {
  const fixture: {
    projectPath: string
    projectId: string
    cmd: ShippingCommands
  } = {
    projectPath: '',
    projectId: '',
    cmd: undefined as unknown as ShippingCommands,
  }

  beforeEach(async () => {
    fixture.projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'prjct-kill-'))
    await fs.mkdir(path.join(fixture.projectPath, '.prjct'), { recursive: true })
    fixture.projectId = `kill-${Math.random().toString(36).slice(2, 10)}`
    await configManager.writeConfig(fixture.projectPath, {
      projectId: fixture.projectId,
      dataPath: path.join(fixture.projectPath, '.prjct-data'),
      delivery: { killSwitch: 'on' },
    })
    patchPathManager(fixture.projectPath)
    prjctDb.get(fixture.projectId, 'SELECT 1')
    fixture.cmd = new ShippingCommands()
  })

  afterEach(async () => {
    restorePathManager()
    if (fixture.projectPath)
      await fs.rm(fixture.projectPath, { recursive: true, force: true }).catch(() => {})
  })

  it('blocks ship before mutation and outranks --no-judgment-gate', async () => {
    const result = await fixture.cmd.ship('feat x', fixture.projectPath, {
      noJudgmentGate: true,
      noSpecGate: true,
      forcePressure: true,
    })
    expect(result.success).toBe(false)
    expect(String(result.error)).toMatch(/kill-switch ON/i)
    expect(String(result.error)).toMatch(/not via --no-judgment-gate/)
  })

  it('allows ship path past kill when off', async () => {
    await configManager.writeConfig(fixture.projectPath, {
      projectId: fixture.projectId,
      dataPath: path.join(fixture.projectPath, '.prjct-data'),
      delivery: { killSwitch: 'off' },
    })
    // Without active task / workflow the ship may still fail later — but
    // must NOT fail on kill-switch.
    const result = await fixture.cmd.ship('feat y', fixture.projectPath, { noJudgmentGate: true })
    if (!result.success) {
      expect(String(result.error)).not.toMatch(/kill-switch/i)
    }
  })
})

describe('C1 audit candidate hash admission', () => {
  const fixture: {
    projectPath: string
    projectId: string
  } = {
    projectPath: '',
    projectId: '',
  }

  beforeEach(async () => {
    fixture.projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'prjct-cand-'))
    await fs.mkdir(path.join(fixture.projectPath, '.prjct'), { recursive: true })
    fixture.projectId = `cand-${Math.random().toString(36).slice(2, 10)}`
    await configManager.writeConfig(fixture.projectPath, {
      projectId: fixture.projectId,
      dataPath: path.join(fixture.projectPath, '.prjct-data'),
    })
    patchPathManager(fixture.projectPath)
    prjctDb.get(fixture.projectId, 'SELECT 1')
  })

  afterEach(async () => {
    restorePathManager()
    if (fixture.projectPath)
      await fs.rm(fixture.projectPath, { recursive: true, force: true }).catch(() => {})
  })

  function body(goal: string): SpecContent {
    return emptySpecContent(goal)
  }

  it('computeAuditCandidateHash is stable and sensitive to body', () => {
    const a = body('ship kill switch')
    a.acceptance_criteria = ['unit test green']
    const b = { ...a, acceptance_criteria: ['unit test green', 'e2e green'] }
    const h1 = computeAuditCandidateHash(a)
    const h2 = computeAuditCandidateHash(a)
    const h3 = computeAuditCandidateHash(b)
    expect(h1).toBe(h2)
    expect(h1).not.toBe(h3)
  })

  it('gate fails when body drifts after lens pass on frozen hash', () => {
    const content = body('candidate bind')
    content.acceptance_criteria = ['A']
    content.selected_reviewers = ['architecture', 'strategic', 'design']
    const hash = computeAuditCandidateHash(content)
    content.audit_candidate_hash = hash
    content.reviews = {
      architecture: { verdict: 'pass', notes: 'ok', ts: 't0', candidateHash: hash },
      strategic: { verdict: 'pass', notes: 'ok', ts: 't0', candidateHash: hash },
      design: { verdict: 'pass', notes: 'ok', ts: 't0', candidateHash: hash },
    }
    const spec = specStorage.create(fixture.projectId, { title: 't', content })
    expect(reviewsGatePassedRelational(fixture.projectId, spec.id)).toBe(true)

    // Mutate body in storage without re-audit (simulates failed invalidation or race)
    const drifted = {
      ...content,
      acceptance_criteria: ['A', 'B new'],
      // keep old reviews + old frozen hash → gate must fail
    }
    specStorage.updateContent(fixture.projectId, spec.id, drifted)
    expect(reviewsGatePassedRelational(fixture.projectId, spec.id)).toBe(false)
  })

  it('legacy specs without audit_candidate_hash keep lens-only gate', () => {
    const content = body('legacy')
    content.selected_reviewers = ['architecture', 'strategic', 'design']
    content.audit_candidate_hash = null
    content.reviews = {
      architecture: { verdict: 'pass', notes: 'ok', ts: 't0' },
      strategic: { verdict: 'pass', notes: 'ok', ts: 't0' },
      design: { verdict: 'pass', notes: 'ok', ts: 't0' },
    }
    const spec = specStorage.create(fixture.projectId, { title: 'legacy', content })
    expect(reviewsGatePassedRelational(fixture.projectId, spec.id)).toBe(true)
  })
})
