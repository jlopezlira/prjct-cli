/**
 * Rho core for prjct memory: reference model R + excess + capture gate.
 *
 * These tests pin the microsoft/rho analogy:
 *   high excess vs R → keep / accept
 *   low excess (near-dup of R) → reject capture / archive
 *   0 tokens, deterministic local embeddings
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { MemoryEntry } from '../../memory/entries'
import { projectMemory } from '../../memory/project-memory'
import { collectRetentionInputs, evaluateRetention, scoreEntry } from '../../services/retention'
import { captureGate } from '../../services/retention/capture-gate'
import {
  buildReferenceIndex,
  CAPTURE_MIN_EXCESS,
  computeExcess,
  excessAgainstIndex,
} from '../../services/retention/excess'
import { buildReferenceModel, isReferenceEligible } from '../../services/retention/reference-model'
import prjctDb from '../../storage/database'
import { patchPathManager, restorePathManager } from '../_setup/path-manager-mock'

const fixture: {
  tmpRoot: string
  projectId: string
} = {
  tmpRoot: '',
  projectId: '',
}

const NOW = Date.parse('2026-07-10T00:00:00.000Z')
const DAY = 86_400_000
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString()

const entry = (over: Partial<MemoryEntry>): MemoryEntry => ({
  id: 'mem_1',
  type: 'decision',
  content: 'we chose SQLite as the single source of truth for project state',
  tags: {},
  rememberedAt: iso(30 * DAY),
  provenance: 'declared',
  ...over,
})

beforeEach(async () => {
  fixture.tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'prjct-rho-'))
  fixture.projectId = `test-rho-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  patchPathManager(fixture.tmpRoot)
  prjctDb.run(fixture.projectId, 'SELECT 1 WHERE 1=0')
})

afterEach(async () => {
  restorePathManager()
  await fs.rm(fixture.tmpRoot, { recursive: true, force: true }).catch(() => {})
})

describe('reference model R', () => {
  it('includes declared decisions and excludes inbox/noise', () => {
    const R = buildReferenceModel([
      entry({ id: 'mem_d', type: 'decision' }),
      entry({
        id: 'mem_i',
        type: 'inbox',
        content: 'random capture that is not judgment knowledge at all',
      }),
      entry({
        id: 'mem_s',
        type: 'improvement-signal',
        content: 'User pushback: stop doing that pattern again in this session',
      }),
      entry({
        id: 'mem_c',
        type: 'context',
        content:
          'Session close: Work cycle still open. Context synthesis: Passive land. Key data: source=land-auto',
        tags: { context_schema: 'living-v2', source: 'land-auto' },
      }),
    ])
    expect(R.some((e) => e.id === 'mem_d')).toBe(true)
    expect(R.some((e) => e.id === 'mem_c')).toBe(true)
    expect(R.some((e) => e.id === 'mem_i')).toBe(false)
    expect(R.some((e) => e.id === 'mem_s')).toBe(false)
  })

  it('caps |R| and prefers decisions over weak context', () => {
    const many: MemoryEntry[] = []
    for (const i of Array.from({ length: 200 }, (_, index) => index)) {
      many.push(
        entry({
          id: `mem_${i}`,
          type: i < 20 ? 'decision' : 'learning',
          content: `unique knowledge item number ${i} about architecture topic ${i} with enough length`,
          rememberedAt: iso(i * DAY),
        })
      )
    }
    const R = buildReferenceModel(many)
    expect(R.length).toBeLessThanOrEqual(150)
    expect(R.filter((e) => e.type === 'decision').length).toBeGreaterThan(0)
  })

  it('isReferenceEligible rejects short and non-model rows', () => {
    expect(isReferenceEligible(entry({ content: 'short' }))).toBe(false)
    expect(
      isReferenceEligible(entry({ type: 'improvement-signal', content: 'x'.repeat(80) }))
    ).toBe(false)
  })
})

describe('excess vs R (Rho core)', () => {
  it('identical content against R has excess ≈ 0 (exact fingerprint)', () => {
    const body = 'daemon holds RW handles over prjct.db during concurrent sync writes'
    const R = [entry({ id: 'mem_ref', content: body })]
    const ex = computeExcess(body, R)
    expect(ex.exactDup).toBe(true)
    expect(ex.excess).toBe(0)
    expect(ex.nearestId).toBe('mem_ref')
  })

  it('near-paraphrase of R has low excess / high sim', () => {
    const R = [
      entry({
        id: 'mem_ref',
        content:
          'The daemon holds read-write handles on prjct.db which blocks concurrent sync writers without busy_timeout',
      }),
    ]
    const ex = computeExcess(
      'daemon holds read-write handles on prjct.db blocking concurrent sync without busy_timeout',
      R
    )
    expect(ex.maxSim).toBeGreaterThan(0.5)
    expect(ex.excess).toBeLessThan(0.55)
  })

  it('unrelated content has high excess', () => {
    const R = [
      entry({
        id: 'mem_ref',
        content: 'we chose SQLite as the single source of truth for all project memory state',
      }),
    ]
    const ex = computeExcess(
      'the onboarding wizard must detect package manager from PATH before installing globals',
      R
    )
    expect(ex.exactDup).toBe(false)
    expect(ex.excess).toBeGreaterThan(0.25)
  })

  it('empty R means full excess (everything is novel)', () => {
    const ex = computeExcess('anything at all goes here for the first seed entry', [])
    expect(ex.excess).toBe(1)
    expect(ex.maxSim).toBe(0)
  })

  it('scoring excludes self from R so a reference member is not zeroed', () => {
    const self = entry({
      id: 'mem_self',
      content: 'unique decision about using worktrees for multi-agent isolation strategy',
    })
    const other = entry({
      id: 'mem_other',
      content: 'unrelated fact about package manager detection on install path',
    })
    const index = buildReferenceIndex([self, other])
    const withSelf = excessAgainstIndex(self.content, index) // includes self fingerprint
    expect(withSelf.exactDup).toBe(true) // fingerprint points to self
    const without = excessAgainstIndex(self.content, index, 'mem_self')
    expect(without.exactDup).toBe(false)
    expect(without.excess).toBeGreaterThan(0.2)
  })
})

describe('scoreEntry integrates excess', () => {
  it('high-excess used decision stays active', () => {
    const novel = entry({
      id: 'mem_novel',
      content:
        'shipping must never force-push and worktree cleanup only after PR merge from main tree',
    })
    const R = [
      entry({
        id: 'mem_r',
        content: 'we use SQLite exclusively for project state never JSON files in repo',
      }),
    ]
    const inputs = {
      entries: [novel, ...R],
      usefulness: new Map([['mem_novel', 2]]),
      supersededIds: new Set<string>(),
      correctedIds: new Set<string>(),
      indexedPaths: null,
      nowMs: NOW,
      refIndex: buildReferenceIndex(R),
    }
    const r = scoreEntry(novel, inputs, new Set())
    expect(r.excess).toBeGreaterThan(0.2)
    expect(r.verdict).toBe('active')
    expect(r.reasons.join(' ')).toMatch(/excess/)
  })

  it('near-dup of R is penalized toward archive', () => {
    const body =
      'SQLite is the single source of truth for project memory and workflow state in prjct'
    const R = [entry({ id: 'mem_r', content: body })]
    const clone = entry({
      id: 'mem_clone',
      type: 'context',
      content: body,
      tags: { context_schema: 'living-v2' },
      rememberedAt: iso(100 * DAY),
    })
    const inputs = {
      entries: [clone, ...R],
      usefulness: new Map<string, number>(),
      supersededIds: new Set<string>(),
      correctedIds: new Set<string>(),
      indexedPaths: null,
      nowMs: NOW,
      refIndex: buildReferenceIndex(R),
    }
    const r = scoreEntry(clone, inputs, new Set())
    expect(r.excess).toBe(0)
    expect(r.verdict).not.toBe('active')
  })
})

describe('capture gate', () => {
  it('rejects low-stakes near-dup of existing judgment', async () => {
    await projectMemory.remember(fixture.tmpRoot, {
      type: 'decision',
      content:
        'always run typecheck before push because lefthook only covers staged files in worktrees',
      projectId: fixture.projectId,
    })
    const gate = captureGate(
      fixture.projectId,
      'inbox',
      'always run typecheck before push because lefthook only covers staged files in worktrees'
    )
    expect(gate.accept).toBe(false)
    expect(gate.reason).toMatch(/redundant|excess|exact/i)
  })

  it('accepts judgment types even when similar (human asserted)', async () => {
    await projectMemory.remember(fixture.tmpRoot, {
      type: 'decision',
      content:
        'prefer soft-delete over hard purge for memory so recovery remains possible from archives',
      projectId: fixture.projectId,
    })
    const gate = captureGate(
      fixture.projectId,
      'decision',
      'prefer soft-delete for memory recovery via archives table when retention archives'
    )
    expect(gate.accept).toBe(true)
  })

  it('accepts high-excess novel inbox on empty-ish R', () => {
    const gate = captureGate(
      fixture.projectId,
      'inbox',
      'brand new idea about shipping multi-agent handoff marketing narrative for the site'
    )
    // empty vault → accept
    expect(gate.accept).toBe(true)
  })

  it('CAPTURE_MIN_EXCESS is a sensible floor (not zero, not 1)', () => {
    expect(CAPTURE_MIN_EXCESS).toBeGreaterThan(0.05)
    expect(CAPTURE_MIN_EXCESS).toBeLessThan(0.5)
  })
})

describe('evaluateRetention end-to-end with R', () => {
  it('reports referenceSize and scores real vault', async () => {
    await projectMemory.remember(fixture.tmpRoot, {
      type: 'decision',
      content:
        'multi-agent switch yields ownership via SQLite handoffs with who and why durable fields',
      projectId: fixture.projectId,
    })
    await projectMemory.remember(fixture.tmpRoot, {
      type: 'gotcha',
      content:
        'Codex skill body must stay under 1024 bytes or the entire skill is silently rejected',
      projectId: fixture.projectId,
    })
    const report = evaluateRetention(fixture.projectId, NOW)
    expect(report.referenceSize).toBeGreaterThan(0)
    expect(report.evaluated).toBeGreaterThanOrEqual(2)
    expect(report.active + report.archive + report.delete).toBe(report.evaluated)
    const inputs = collectRetentionInputs(fixture.projectId, NOW)
    expect(inputs.refIndex.entries.length).toBe(report.referenceSize)
  })
})
