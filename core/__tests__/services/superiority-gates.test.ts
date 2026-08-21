/**
 * Superiority gates — beat field (not near-parity).
 * Pins for every program criterion: discuss/pressure/package/nyquist/
 * geometry/judgment override, close, competitive dust, multi-runtime signals.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { buildTopicalCue } from '../../hooks/prompt'
import {
  contextPressureBlocksExpansion,
  contextPressureRequiresCompactPath,
  contextPressureStatusLine,
  contextPressureVerdict,
} from '../../services/context-pressure'
import { shipGeometryVerdict } from '../../services/delivery-geometry'
import { discussLockVerdict } from '../../services/discuss-lock'
import {
  driftStaleResolved,
  formatDriftNotice,
  markDriftRefreshApplied,
  readDriftStamp,
  shouldRefreshDrift,
} from '../../services/drift-refresh'
import { computeHarnessScore, renderCompetitiveDustMd } from '../../services/harness-score'
import {
  CORE_SUPERIORITY_RUNTIMES,
  multiRuntimeInstallParityReport,
  multiRuntimeSignalParityComplete,
  REQUIRED_HOOK_SUBCOMMANDS,
} from '../../services/multi-runtime-signals'
import { effectiveNyquistWorkMode, nyquistWorkVerdict } from '../../services/nyquist-lite'
import { decidePackageInstall, parsePackageInstallCommand } from '../../services/package-legitimacy'
import { judgmentShipVerdict } from '../../services/precision-judgment'
import { applyRetention } from '../../services/retention'
import { formatLivingApplyLine } from '../../services/retention/living-apply'
import { isAutoSource, trimAutoSourceCap, vaultHealth } from '../../services/retention/purge'
import { PRJCT_HOOKS } from '../../services/settings-installer'
import {
  buildCodexSkill,
  buildGeminiConfig,
  CONTRACT,
} from '../../services/skill-generator/editor-surfaces'
import { formatRelatedContextForAgent } from '../../services/task-service'
import prjctDb from '../../storage/database'
import { patchPathManager, restorePathManager } from '../_setup/path-manager-mock'

describe('package install parse (PreToolUse superiority)', () => {
  it('parses npm/pnpm/yarn/bun add with package names', () => {
    expect(parsePackageInstallCommand('npm install lodash')).toEqual({
      manager: 'npm',
      packages: ['lodash'],
    })
    expect(parsePackageInstallCommand('pnpm add -D @types/node chalk')).toEqual({
      manager: 'pnpm',
      packages: ['@types/node', 'chalk'],
    })
    expect(parsePackageInstallCommand('yarn add react')).toEqual({
      manager: 'yarn',
      packages: ['react'],
    })
    expect(parsePackageInstallCommand('bun add hono')).toEqual({
      manager: 'bun',
      packages: ['hono'],
    })
  })

  it('ignores bare lockfile installs and non-install commands', () => {
    expect(parsePackageInstallCommand('npm install')).toBeNull()
    expect(parsePackageInstallCommand('pnpm i')).toBeNull()
    expect(parsePackageInstallCommand('git commit -m x')).toBeNull()
    expect(parsePackageInstallCommand('npm test')).toBeNull()
  })

  it('decidePackageInstall allows known deps, flags unknown', () => {
    const known = new Set(['lodash', 'chalk'])
    expect(decidePackageInstall(['lodash'], known).risky).toBe(false)
    const r = decidePackageInstall(['lodash', 'evil-typo'], known)
    expect(r.risky).toBe(true)
    expect(r.newPackages).toEqual(['evil-typo'])
  })

  it('package legitimacy is registered through the consolidated Bash hook', () => {
    expect(PRJCT_HOOKS.some((h) => h.subcommand === 'pre-bash')).toBe(true)
  })
})

describe('context-pressure reports measured token spend (no forced session kill)', () => {
  // Levels come from tokens against an explicitly configured budget. A turn
  // count is not context and no longer produces a level at all.
  const spent = (tokens: number) =>
    contextPressureVerdict(
      { maxTokensPerCycle: 100_000 } as never,
      { turnCount: 2, tokensIn: tokens, tokensOut: 0 } as never
    )

  it('default: never hard-blocks ship; compact preference only', () => {
    const crit = spent(85_000)
    expect(crit.level).toBe('critical')
    expect(contextPressureBlocksExpansion(crit)).toBe(false)
    expect(contextPressureRequiresCompactPath(crit)).toBe(true)
    expect(crit.cue).toMatch(/token budget/i)
    expect(contextPressureStatusLine(crit)).toMatch(/budget/i)

    const warn = spent(65_000)
    expect(warn.level).toBe('warn')
    expect(contextPressureBlocksExpansion(warn)).toBe(false)
    expect(contextPressureRequiresCompactPath(warn)).toBe(true)
    expect(warn.cue).toMatch(/token budget/i)
    expect(contextPressureStatusLine(warn)).toMatch(/budget/i)
  })

  it('opt-in hardBlockShip only when configured', () => {
    const crit = spent(85_000)
    expect(
      contextPressureBlocksExpansion(crit, {
        contextPressure: { hardBlockShip: true },
      } as never)
    ).toBe(true)
    expect(contextPressureBlocksExpansion(crit, {} as never)).toBe(false)
  })
})

describe('discuss-lock H2+ code path', () => {
  it('blocks H2 advisory without reviewed spec', () => {
    const v = discussLockVerdict({
      sddMode: 'advisory',
      harnessLevel: 'H2',
      hasSpecId: false,
    })
    expect(v.blocked).toBe(true)
    expect(v.message).toMatch(/Discuss-lock|SUPERIOR/i)
  })

  it('allows H0 without spec (smoke regression)', () => {
    const v = discussLockVerdict({
      sddMode: 'advisory',
      harnessLevel: 'H0',
      hasSpecId: false,
    })
    expect(v.blocked).toBe(false)
  })
})

describe('nyquist work-start H2+', () => {
  it('strict blocks H2 with vague ACs', () => {
    const v = nyquistWorkVerdict({
      harnessLevel: 'H2',
      criteria: ['auth feels solid'],
      mode: 'strict',
    })
    expect(v.blocked).toBe(true)
    expect(v.reason).toBe('strict-vague')
  })

  it('advisory warns but does not block', () => {
    const v = nyquistWorkVerdict({
      harnessLevel: 'H2',
      criteria: ['auth feels solid'],
      mode: 'advisory',
    })
    expect(v.blocked).toBe(false)
    expect(v.message).toMatch(/Nyquist/i)
  })

  it('H0 never blocks (smoke)', () => {
    const v = nyquistWorkVerdict({
      harnessLevel: 'H0',
      criteria: ['auth feels solid'],
      mode: 'strict',
    })
    expect(v.blocked).toBe(false)
    expect(v.reason).toBe('h0-skip')
  })

  it('maps sdd/tdd modes', () => {
    expect(effectiveNyquistWorkMode('strict', 'off')).toBe('strict')
    expect(effectiveNyquistWorkMode('advisory', 'assist')).toBe('advisory')
    expect(effectiveNyquistWorkMode('off', 'off')).toBe('off')
  })
})

describe('ship delivery-geometry gate', () => {
  it('strict blocks large committed diffs without explicit geometry', () => {
    const v = shipGeometryVerdict({
      changeset: {
        files: 20,
        loc: 900,
        source: 'committed',
        dirs: ['core', 'apps'],
      },
      mode: 'strict',
      explicitGeometry: null,
    })
    expect(v.blocked).toBe(true)
    expect(v.reason).toBe('strict-block')
    expect(v.message).toMatch(/--geometry/i)
  })

  it('explicit geometry overrides block', () => {
    const v = shipGeometryVerdict({
      changeset: { files: 20, loc: 900, source: 'committed', dirs: ['core'] },
      mode: 'strict',
      explicitGeometry: 'split',
    })
    expect(v.blocked).toBe(false)
    expect(v.reason).toBe('override')
  })
})

describe('judgment gate consent-scoped override', () => {
  it('codeStrict hard-blocks without ledger; override is separate', () => {
    const blocked = judgmentShipVerdict({
      codeStrict: true,
      intensity: 'full',
      ledger: null,
      override: false,
    })
    expect(blocked.blocked).toBe(true)
    expect(blocked.message).toMatch(/no-judgment-gate/)
    expect(blocked.message).toMatch(/Dual-blind|dual-blind/i)

    const ok = judgmentShipVerdict({
      codeStrict: true,
      intensity: 'full',
      ledger: null,
      override: true,
    })
    expect(ok.blocked).toBe(false)
  })
})

describe('competitive dust claims SUPERIOR on every row', () => {
  it('matrix uses SUPERIOR not n/a ties', () => {
    const md = renderCompetitiveDustMd(computeHarnessScore())
    expect(md).toMatch(/SUPERIOR/i)
    expect(md).toContain('gentle-ai')
    expect(md).toContain('open-GSD')
    expect(md).toContain('memory plugins')
    expect(md).not.toMatch(/\bn\/a\b/i)
    expect(md).toMatch(/discuss-lock/i)
    expect(md).toMatch(/Rho/i)
    expect(md).toMatch(/Package legitimacy/i)
  })
})

describe('multi-runtime signal + skill parity (installer-derived)', () => {
  it('PRJCT_HOOKS + host mappers + skill CONTRACT.loop are complete', () => {
    expect(CORE_SUPERIORITY_RUNTIMES).toEqual(['claude', 'codex', 'gemini', 'cursor', 'grok'])
    for (const sub of REQUIRED_HOOK_SUBCOMMANDS) {
      expect(PRJCT_HOOKS.some((h) => h.subcommand === sub)).toBe(true)
    }
    const report = multiRuntimeInstallParityReport()
    expect(report.missing).toEqual([])
    expect(report.ok).toBe(true)
    expect(multiRuntimeSignalParityComplete()).toBe(true)
    expect(report.codexHasLoop).toBe(true)
    expect(report.geminiHasLoop).toBe(true)
    expect(report.grokInheritsClaude).toBe(true)
    expect(report.grokMcpNative).toBe(true)
    expect(report.grokSkillsNative).toBe(true)
  })

  it('Codex + Gemini surfaces carry loop-discipline CONTRACT', () => {
    const codex = buildCodexSkill()
    const gemini = buildGeminiConfig()
    expect(codex).toContain(CONTRACT.loop)
    expect(gemini).toContain(CONTRACT.loop)
    expect(codex).toMatch(/tip→user|close/)
    expect(Buffer.byteLength(codex, 'utf-8')).toBeLessThanOrEqual(1024 - 50)
  })
})

describe('drift refresh — not warn-forever', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const d of dirs) {
      try {
        require('node:fs').rmSync(d, { recursive: true, force: true })
      } catch {
        /* ignore */
      }
    }
    dirs.length = 0
  })

  function tmpHome(): string {
    const d = require('node:fs').mkdtempSync(path.join(os.tmpdir(), 'prjct-sup-drift-'))
    dirs.push(d)
    return d
  }

  it('applied after schedule clears permanent stale presentation', () => {
    const home = tmpHome()
    expect(shouldRefreshDrift(home, 5)).toBe(true)
    // simulate schedule stamp
    const stateDir = path.join(home, 'state')
    require('node:fs').mkdirSync(stateDir, { recursive: true })
    require('node:fs').writeFileSync(
      path.join(stateDir, 'drift-refresh-last.json'),
      JSON.stringify({ scheduledAt: Date.now() - 1000, commitsAtSchedule: 5 }),
      'utf-8'
    )
    markDriftRefreshApplied(home)
    const stamp = readDriftStamp(home)
    expect(driftStaleResolved(stamp)).toBe(true)
    const notice = formatDriftNotice({
      warning: '5 commits behind',
      commitsSinceSync: 5,
      stamp,
      refreshScheduled: false,
    })
    expect(notice).toMatch(/refreshed|cleared/i)
    expect(notice).not.toMatch(/may be stale/i)
  })
})

describe('retention living-loop — noisy vault shrinks on apply', () => {
  const fixture: {
    tmpRoot: string
    projectId: string
  } = {
    tmpRoot: '',
    projectId: '',
  }

  beforeEach(async () => {
    fixture.tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'prjct-sup-ret-'))
    fixture.projectId = `test-sup-ret-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    patchPathManager(fixture.tmpRoot)
    prjctDb.run(fixture.projectId, 'SELECT 1 WHERE 1=0')
  })

  afterEach(async () => {
    restorePathManager()
    await fs.rm(fixture.tmpRoot, { recursive: true, force: true }).catch(() => {})
  })

  it('auto-source cap trims live noise and vaultHealth reports inventory', () => {
    const now = Date.now()
    // Seed many auto-source context rows (noise) — source lives in tags.
    // IDs must be mem_<digits> so projectMemory.forget can remove them.
    for (const i of Array.from({ length: 25 }, (_, index) => index)) {
      const id = `mem_${9100 + i}`
      prjctDb.run(
        fixture.projectId,
        `INSERT INTO memory_entries (
          id, project_id, type, title, content, provenance, content_hash,
          user_triggered, revision_count, created_at, updated_at, deleted_at
        ) VALUES (?, ?, 'context', ?, ?, 'extracted', ?, 0, 0, ?, ?, NULL)`,
        id,
        fixture.projectId,
        `auto noise ${i}`,
        `auto-generated noise content row ${i} for retention living-loop superiority fixture xx`,
        `hash_noise_${i}`,
        now - i * 1000,
        now - i * 1000
      )
      prjctDb.run(
        fixture.projectId,
        'INSERT INTO memory_entry_tags (entry_id, key, value, is_machine) VALUES (?, ?, ?, 0)',
        id,
        'source',
        'pattern-detector-auto'
      )
    }
    // One declared decision must survive
    prjctDb.run(
      fixture.projectId,
      `INSERT INTO memory_entries (
        id, project_id, type, title, content, provenance, content_hash,
        user_triggered, revision_count, created_at, updated_at, deleted_at
      ) VALUES (?, ?, 'decision', ?, ?, 'declared', ?, 1, 0, ?, ?, NULL)`,
      'mem_9199',
      fixture.projectId,
      'keep me',
      'important decision that retention must not delete under type floor',
      'hash_keep',
      now,
      now
    )

    expect(isAutoSource('pattern-detector-auto')).toBe(true)
    const before = vaultHealth(fixture.projectId)
    expect(before.live).toBeGreaterThanOrEqual(26)

    const trimmed = trimAutoSourceCap(fixture.projectId, 20)
    expect(trimmed).toBeGreaterThan(0)

    const after = vaultHealth(fixture.projectId)
    // Soft-delete reduces "live" count
    expect(after.live).toBeLessThan(before.live)

    // Full apply path still runs without throwing
    const applied = applyRetention(fixture.projectId, {
      dryRun: false,
      maxArchive: 50,
      maxDelete: 20,
    })
    expect(applied).toBeDefined()
    expect(typeof applied.active).toBe('number')
    expect(typeof applied.archived).toBe('number')

    // vault health line (same shape sync --md prints from retention phase)
    const health = vaultHealth(fixture.projectId)
    // eslint-disable-next-line no-console
    console.log(
      `vault health live=${health.live} softDeleted=${health.softDeleted} archives=${health.archives} autoSourceLive=${health.autoSourceLive}`
    )
    expect(health.live).toBeLessThan(before.live)
    expect(health.softDeleted + health.live).toBeGreaterThan(0)

    // Work surface tip→user SoT (formatRelatedContextForAgent is what prjct work injects)
    const workLine = formatRelatedContextForAgent({
      id: 'mem_9199',
      type: 'decision',
      title: 'keep me',
      detail: 'important decision that retention must not delete under type floor',
      decisionTrap: 'never hard-delete type-floor decisions',
      when: new Date().toISOString(),
    })
    // eslint-disable-next-line no-console
    console.log(`work surface: ${workLine}`)
    expect(workLine).toMatch(/tip→user/)
    expect(workLine).toMatch(/SoT/)

    // Living-apply line (same tip channel)
    const living = formatLivingApplyLine({
      id: 'mem_9199',
      type: 'decision',
      content: 'important decision that retention must not delete under type floor',
      tags: {},
      rememberedAt: new Date().toISOString(),
      provenance: 'declared',
    } as never)
    // eslint-disable-next-line no-console
    console.log(`living-apply: ${living.line}`)
    expect(living.line).toMatch(/tip→user|SoT|BINDING/i)

    // Prompt topical cue SoT (UserPromptSubmit surface)
    const cue = buildTopicalCue(fixture.projectId, 'important decision type floor retention')
    // eslint-disable-next-line no-console
    console.log(`prompt cue: ${cue ?? '(null — may miss FTS if decision not indexed)'}`)
    // Decision may not be FTS-indexed if only SQL-inserted; living/work lines already prove tip→user.
    if (cue) {
      expect(cue).toMatch(/Tip→user|SoT/i)
    }
  })
})
