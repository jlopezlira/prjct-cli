/**
 * Precision-gated judgment engine v2 — pure pins (steroids vs gentle-ai 1.46).
 */

import { describe, expect, it } from 'bun:test'
import type { JudgmentFinding } from '../../schemas/judgment'
import { MAX_FIX_ROUNDS } from '../../schemas/judgment'
import {
  advanceFixRound,
  applyBatchRefutation,
  applyEvidenceTax,
  applyGhostFilter,
  applyMechanicalStyleRefute,
  applyScopeFreeze,
  applyScopeFreezeAll,
  applySeverityFloor,
  applySeverityFloorAll,
  blastRank,
  buildNextAction,
  buildReReviewBrief,
  canStartFixRound,
  computePrecisionHint,
  computeVerdict,
  createLedger,
  evidenceScore,
  findingDna,
  intensityFromChangeset,
  intensityProtocol,
  isActionableSeverity,
  isHotPath,
  isPreferConstClaim,
  judgmentShipVerdict,
  markFindings,
  markFindingsSkippedByScope,
  markGhost,
  markLeftoversOpen,
  mergeDualJudges,
  normalizeScopePath,
  pathInScope,
  rankFindingsForFix,
  refutePanelSize,
  resolveRefuteVotes,
  routeIntensity,
  upsertFinding,
} from '../../services/precision-judgment'

function finding(
  partial: Partial<JudgmentFinding> & Pick<JudgmentFinding, 'id' | 'severity' | 'title'>
): JudgmentFinding {
  return {
    status: 'candidate',
    ...partial,
  }
}

describe('intensity router', () => {
  it('maps trivial/normal/large to skip/standard/full', () => {
    expect(routeIntensity('trivial')).toBe('skip')
    expect(routeIntensity('normal')).toBe('standard')
    expect(routeIntensity('large')).toBe('full')
  })

  it('force-upgrades hot-path and H3 security to full', () => {
    expect(routeIntensity('trivial', { paths: ['core/auth/login.ts'] })).toBe('full')
    expect(routeIntensity('normal', { harnessLevel: 'H3' })).toBe('full')
    expect(routeIntensity('normal', { harnessKind: 'security' })).toBe('full')
    expect(isHotPath(['docs/readme.md'])).toBe(false)
    expect(isHotPath(['db/migrations/001.sql'])).toBe(true)
  })

  it('intensityFromChangeset uses delivery-geometry thresholds', () => {
    expect(intensityFromChangeset({ files: 1, loc: 5 }).intensity).toBe('skip')
    expect(intensityFromChangeset({ files: 5, loc: 100 }).intensity).toBe('standard')
    expect(intensityFromChangeset({ files: 20, loc: 500 }).intensity).toBe('full')
  })
})

describe('evidence tax', () => {
  it('scores evidence quality 0–3', () => {
    expect(evidenceScore({})).toBe(0)
    expect(evidenceScore({ file: 'a.ts' })).toBe(1)
    expect(evidenceScore({ file: 'a.ts', line: 10 })).toBe(2)
    expect(evidenceScore({ file: 'a.ts', line: 10, evidence: 'repro: call foo() with null' })).toBe(
      3
    )
  })

  it('demotes blocker without file:line to critical', () => {
    const f = applyEvidenceTax(finding({ id: '1', severity: 'blocker', title: 'vibes' }))
    expect(f.severity).toBe('critical')
  })

  it('demotes title-only critical to warning→info via floor', () => {
    const f = applySeverityFloor(finding({ id: '1', severity: 'critical', title: 'vibes' }))
    expect(f.severity).toBe('warning')
    expect(f.status).toBe('info')
  })

  it('keeps blocker with file:line', () => {
    const f = applyEvidenceTax(
      finding({
        id: '1',
        severity: 'blocker',
        title: 'rce',
        file: 'auth.ts',
        line: 42,
        evidence: 'curl payload exploits parse',
      })
    )
    expect(f.severity).toBe('blocker')
    expect(f.evidenceScore).toBe(3)
  })
})

describe('const-only evidence tax', () => {
  it('detects prefer-const claims including Spanish "por que let"', () => {
    expect(isPreferConstClaim('prefer const for currentStreak')).toBe(true)
    expect(isPreferConstClaim('por que let?')).toBe(true)
    expect(isPreferConstClaim('null deref in auth')).toBe(false)
  })

  it('keeps a fully evidenced const-only finding actionable when reassignment exists', () => {
    const f = applyMechanicalStyleRefute(
      finding({
        id: 'fp1',
        severity: 'suggestion',
        title: 'prefer const for currentStreak — why let?',
        file: 'streak.ts',
        line: 206,
        evidence: 'let currentStreak = 0; … currentStreak++ on each active day',
      })
    )
    expect(f.status).toBe('candidate')
    expect(f.evidence).not.toMatch(/MECHANICAL REFUTE/i)
  })

  it('taxes prefer-const without file:line+snippet to info', () => {
    const f = applyMechanicalStyleRefute(
      finding({
        id: 'fp2',
        severity: 'warning',
        title: 'use const instead of let',
      })
    )
    expect(f.status).toBe('info')
    expect(f.severity).toBe('suggestion')
  })

  it('does not touch real production findings', () => {
    const f = applyMechanicalStyleRefute(
      finding({
        id: 'real',
        severity: 'blocker',
        title: 'race on shared counter',
        file: 'x.ts',
        line: 10,
        evidence: 'two writers increment without lock',
      })
    )
    expect(f.status).toBe('candidate')
    expect(f.severity).toBe('blocker')
  })
})

describe('finding DNA', () => {
  it('is stable for same title/file/line-bucket', () => {
    const a = findingDna({ title: 'Null deref in auth', file: 'auth.ts', line: 42 })
    const b = findingDna({ title: 'null deref in auth!', file: 'auth.ts', line: 44 })
    expect(a).toBe(b)
    expect(a.startsWith('dna:')).toBe(true)
  })

  it('upsertFinding merges same DNA', () => {
    const first = applySeverityFloor(
      finding({ id: 'a', severity: 'critical', title: 'x', file: 'f.ts', line: 10 })
    )
    const findings = [first]
    const r = upsertFinding(
      findings,
      applySeverityFloor(
        finding({
          id: 'b',
          severity: 'blocker',
          title: 'x',
          file: 'f.ts',
          line: 12,
          evidence: 'enough evidence here',
        })
      )
    )
    expect(r.deduped).toBe(true)
    expect(r.findings.length).toBe(1)
    expect(r.finding.severity).toBe('blocker')
  })
})

describe('severity floor', () => {
  it('only blocker/critical are actionable', () => {
    expect(isActionableSeverity('blocker')).toBe(true)
    expect(isActionableSeverity('critical')).toBe(true)
    expect(isActionableSeverity('warning')).toBe(false)
  })

  it('demotes warning/suggestion to info', () => {
    const w = applySeverityFloor(
      finding({ id: '1', severity: 'warning', title: 'nit', file: 'a.ts', line: 1 })
    )
    expect(w.status).toBe('info')
  })
})

describe('blast rank + fix order', () => {
  it('ranks hot-path blockers above cold criticals', () => {
    const hot = finding({
      id: 'h',
      severity: 'blocker',
      title: 'auth hole',
      file: 'core/auth/x.ts',
      line: 1,
      evidence: 'repro steps here ok',
      status: 'stands',
    })
    const cold = finding({
      id: 'c',
      severity: 'critical',
      title: 'typo path',
      file: 'docs/x.md',
      line: 1,
      status: 'stands',
    })
    const ranked = rankFindingsForFix([applySeverityFloor(cold), applySeverityFloor(hot)])
    expect(ranked[0]?.id).toBe('h')
    expect(blastRank(applySeverityFloor(hot))).toBeGreaterThan(blastRank(applySeverityFloor(cold)))
  })
})

describe('dual-judge RED/BLUE merge', () => {
  it('agrees on same DNA from both sides', () => {
    const m = mergeDualJudges(
      {
        role: 'red',
        findings: [
          {
            severity: 'blocker',
            title: 'auth bypass',
            file: 'auth.ts',
            line: 10,
            evidence: 'forged cookie works',
          },
        ],
      },
      {
        role: 'blue',
        findings: [
          {
            severity: 'critical',
            title: 'Auth bypass!',
            file: 'auth.ts',
            line: 12,
            evidence: 'session check missing',
          },
        ],
      },
      () => 'jf_test'
    )
    expect(m.findings.length).toBe(1)
    expect(m.agreed).toBe(1)
    expect(m.shouldEscalate).toBe(false)
  })

  it('escalates when red says actionable and blue says not (same DNA)', () => {
    const m = mergeDualJudges(
      {
        role: 'red',
        findings: [
          {
            severity: 'blocker',
            title: 'sql inject',
            file: 'db.ts',
            line: 5,
            evidence: 'quote in input',
          },
        ],
      },
      {
        role: 'blue',
        findings: [
          {
            severity: 'suggestion',
            title: 'SQL inject',
            file: 'db.ts',
            line: 5,
            evidence: 'already parameterized',
          },
        ],
      }
    )
    expect(m.contradicted).toBe(1)
    expect(m.shouldEscalate).toBe(true)
    expect(m.escalateReason).toMatch(/contradiction/i)
  })
})

describe('ghost FP memory', () => {
  it('tags known false positives without auto-killing', () => {
    const book = markGhost(
      { ghosts: [], updatedAt: 't0' },
      { dna: 'dna:deadbeef', title: 'old nit' },
      't1',
      'refuted'
    )
    expect(book.ghosts[0]?.times).toBe(1)
    const f = applySeverityFloor(
      finding({
        id: 'x',
        severity: 'critical',
        title: 'old nit',
        file: 'a.ts',
        line: 1,
        dna: 'dna:deadbeef',
      })
    )
    const tagged = applyGhostFilter([f], book)
    expect(tagged[0]?.knownFalsePositive).toBe(true)
    expect(tagged[0]?.status).toBe('candidate') // not auto-killed
  })
})

describe('batch refutation', () => {
  it('panel size is 1 standard / 3 full', () => {
    expect(refutePanelSize('standard')).toBe(1)
    expect(refutePanelSize('full')).toBe(3)
  })

  it('fail-closed missing votes → stands', () => {
    expect(resolveRefuteVotes(undefined, 1)).toBe('stands')
    expect(resolveRefuteVotes([], 3)).toBe('stands')
  })

  it('full panel 2-of-3 kills', () => {
    expect(resolveRefuteVotes(['refuted', 'refuted', 'stands'], 3)).toBe('refuted')
    expect(resolveRefuteVotes(['refuted', 'stands', 'stands'], 3)).toBe('stands')
  })

  it('batch processes whole candidate list', () => {
    const findings = applySeverityFloorAll([
      finding({
        id: 'a',
        severity: 'blocker',
        title: 'A',
        file: 'a.ts',
        line: 1,
        evidence: 'repro steps here',
      }),
      finding({
        id: 'b',
        severity: 'critical',
        title: 'B',
        file: 'b.ts',
        line: 1,
        evidence: 'repro steps here',
      }),
      finding({ id: 'c', severity: 'warning', title: 'C' }),
    ])
    const out = applyBatchRefutation(findings, { a: ['stands'], b: ['refuted'] }, 'standard')
    expect(out.find((f) => f.id === 'a')?.status).toBe('stands')
    expect(out.find((f) => f.id === 'b')?.status).toBe('refuted')
    expect(out.find((f) => f.id === 'c')?.status).toBe('info')
  })
})

describe('convergence budget', () => {
  it('caps at MAX_FIX_ROUNDS=2', () => {
    expect(MAX_FIX_ROUNDS).toBe(2)
    const initial = {
      ...createLedger({ target: 't', intensity: 'full', now: 't0' }),
      findings: [
        finding({
          id: 'a',
          severity: 'blocker',
          title: 'x',
          status: 'stands',
          file: 'a.ts',
          line: 1,
          evidence: 'repro steps here',
        }),
      ],
    }
    expect(canStartFixRound(initial).ok).toBe(true)
    const firstRound = advanceFixRound(initial, 't1')
    expect(firstRound.fixRound).toBe(1)
    const finalRound = advanceFixRound(firstRound, 't2')
    expect(finalRound.fixRound).toBe(2)
    expect(canStartFixRound(finalRound).ok).toBe(false)
  })

  it('markLeftoversOpen demotes stands → open', () => {
    const ledger = markLeftoversOpen(
      {
        ...createLedger({ target: 't', intensity: 'standard', now: 't0' }),
        fixRound: 2,
        findings: [
          finding({
            id: 'a',
            severity: 'blocker',
            title: 'x',
            status: 'stands',
            file: 'a.ts',
            line: 1,
            evidence: 'repro steps here',
          }),
        ],
      },
      't1'
    )
    expect(ledger.findings[0]!.status).toBe('open')
    expect(computeVerdict(ledger)).toBe('blocked')
  })
})

describe('next-action card', () => {
  it('skip intensity → skip_ship', () => {
    const c = buildNextAction(null, 'skip')
    expect(c.kind).toBe('skip_ship')
  })

  it('no ledger → open_ledger with dual charters on full', () => {
    const c = buildNextAction(null, 'full')
    expect(c.kind).toBe('open_ledger')
    expect(c.judgeCharters?.red).toMatch(/RED/i)
    expect(c.judgeCharters?.blue).toMatch(/BLUE/i)
  })

  it('empty ledger full → dispatch_reviewers', () => {
    const ledger = createLedger({ target: 't', intensity: 'full', now: 't0' })
    const c = buildNextAction(ledger, 'full')
    expect(c.kind).toBe('dispatch_reviewers')
  })

  it('candidates present → dispatch_refuters', () => {
    const ledger = createLedger({ target: 't', intensity: 'standard', now: 't0' })
    ledger.findings = [
      applySeverityFloor(
        finding({
          id: 'a',
          severity: 'blocker',
          title: 'x',
          file: 'a.ts',
          line: 1,
          evidence: 'repro steps here',
        })
      ),
    ]
    const c = buildNextAction(ledger, 'standard')
    expect(c.kind).toBe('dispatch_refuters')
  })

  it('stands → fix_ranked with order', () => {
    const ledger = createLedger({ target: 't', intensity: 'standard', now: 't0' })
    ledger.findings = [
      {
        ...applySeverityFloor(
          finding({
            id: 'a',
            severity: 'blocker',
            title: 'x',
            file: 'auth/x.ts',
            line: 1,
            evidence: 'repro steps here',
          })
        ),
        status: 'stands',
      },
    ]
    const c = buildNextAction(ledger, 'standard')
    expect(c.kind).toBe('fix_ranked')
    expect(c.rankedFixIds).toContain('a')
  })
})

describe('scoped re-review + precision', () => {
  it('brief excludes info and refuted', () => {
    const ledger = createLedger({ target: 't', intensity: 'full', now: 't0' })
    ledger.findings = [
      finding({
        id: 'a',
        severity: 'blocker',
        title: 'A',
        status: 'fixed',
        file: 'a.ts',
        line: 1,
        evidence: 'repro steps here',
      }),
      finding({ id: 'b', severity: 'warning', title: 'B', status: 'info' }),
      finding({
        id: 'c',
        severity: 'critical',
        title: 'C',
        status: 'refuted',
        file: 'c.ts',
        line: 1,
      }),
    ]
    const brief = buildReReviewBrief(ledger)
    expect(brief.findings.map((f) => f.id)).toEqual(['a'])
    expect(brief.fixOrder).toEqual(['a'])
  })

  it('precision = verified / (verified + refuted)', () => {
    expect(
      computePrecisionHint([
        finding({ id: 'a', severity: 'blocker', title: 'a', status: 'verified' }),
        finding({ id: 'b', severity: 'blocker', title: 'b', status: 'refuted' }),
        finding({ id: 'c', severity: 'blocker', title: 'c', status: 'verified' }),
      ])
    ).toBe(0.667)
  })
})

describe('ship gate', () => {
  it('code-strict hard-blocks missing ledger', () => {
    const v = judgmentShipVerdict({
      codeStrict: true,
      intensity: 'full',
      ledger: null,
      override: false,
    })
    expect(v.blocked).toBe(true)
    expect(v.mode).toBe('hard')
  })

  it('approved ledger passes', () => {
    const ledger = createLedger({ target: 't', intensity: 'full', now: 't0' })
    ledger.verdict = 'approved'
    const v = judgmentShipVerdict({
      codeStrict: true,
      intensity: 'full',
      ledger,
      override: false,
    })
    expect(v.blocked).toBe(false)
    expect(v.reason).toBe('approved')
  })

  it('override always passes', () => {
    expect(
      judgmentShipVerdict({
        codeStrict: true,
        intensity: 'full',
        ledger: null,
        override: true,
      }).blocked
    ).toBe(false)
  })
})

describe('protocol card', () => {
  it('full documents RED/BLUE + evidence tax + 2 rounds', () => {
    const p = intensityProtocol('full')
    expect(p.reviewers).toMatch(/RED/i)
    expect(p.evidenceTax).toMatch(/file:line/i)
    expect(p.maxFixRounds).toBe(2)
    expect(p.redCharter).toMatch(/attack/i)
  })
})

describe('scope freeze (gentle-ai v1.49)', () => {
  it('normalizeScopePath strips ./ and backslashes', () => {
    expect(normalizeScopePath('./core/foo.ts')).toBe('core/foo.ts')
    expect(normalizeScopePath('core\\foo.ts')).toBe('core/foo.ts')
  })

  it('pathInScope: empty scope = everything allowed', () => {
    expect(pathInScope('evil/other.ts', undefined)).toBe(true)
    expect(pathInScope('evil/other.ts', [])).toBe(true)
  })

  it('pathInScope: exact + prefix membership', () => {
    const scope = ['core/services/precision-judgment.ts', 'core/schemas']
    expect(pathInScope('core/services/precision-judgment.ts', scope)).toBe(true)
    expect(pathInScope('core/schemas/judgment.ts', scope)).toBe(true)
    expect(pathInScope('scripts/release.js', scope)).toBe(false)
  })

  it('createLedger freezes deduped scopePaths', () => {
    const ledger = createLedger({
      target: 't',
      intensity: 'full',
      now: 't0',
      scopePaths: ['./core/a.ts', 'core/a.ts', 'core/b.ts'],
    })
    expect(ledger.scopePaths).toEqual(['core/a.ts', 'core/b.ts'])
    expect(ledger.scopeFrozenAt).toBe('t0')
  })

  it('applyScopeFreeze demotes out-of-scope blocker → info follow-up', () => {
    const f = applyScopeFreeze(
      finding({
        id: 'a',
        severity: 'blocker',
        title: 'leak',
        status: 'candidate',
        file: 'scripts/evil.ts',
        line: 1,
        evidence: 'repro steps here',
      }),
      ['core/services/x.ts']
    )
    expect(f.status).toBe('info')
    expect(f.evidence).toMatch(/out of frozen review scope/i)
  })

  it('in-scope findings stay candidates', () => {
    const f = applyScopeFreeze(
      finding({
        id: 'a',
        severity: 'blocker',
        title: 'leak',
        status: 'candidate',
        file: 'core/services/x.ts',
        line: 1,
        evidence: 'repro steps here',
      }),
      ['core/services/x.ts']
    )
    expect(f.status).toBe('candidate')
  })

  it('rankFindingsForFix excludes out-of-scope stands', () => {
    const ranked = rankFindingsForFix(
      [
        finding({
          id: 'in',
          severity: 'blocker',
          title: 'in',
          status: 'stands',
          file: 'core/a.ts',
          line: 1,
          evidence: 'repro steps here',
        }),
        finding({
          id: 'out',
          severity: 'blocker',
          title: 'out',
          status: 'stands',
          file: 'scripts/b.ts',
          line: 1,
          evidence: 'repro steps here',
        }),
      ],
      ['core/a.ts']
    )
    expect(ranked.map((f) => f.id)).toEqual(['in'])
  })

  it('markFindings refuses fixed on out-of-scope findings', () => {
    const ledger = {
      ...createLedger({
        target: 't',
        intensity: 'standard',
        now: 't0',
        scopePaths: ['core/a.ts'],
      }),
      findings: [
        finding({
          id: 'out',
          severity: 'blocker',
          title: 'x',
          status: 'stands',
          file: 'scripts/b.ts',
          line: 1,
          evidence: 'repro steps here',
        }),
      ],
    }
    // Force stands despite freeze (simulates pre-freeze legacy row)
    expect(markFindingsSkippedByScope(ledger, ['out'], 'fixed')).toEqual(['out'])
    const marked = markFindings(ledger, ['out'], 'fixed', 't1')
    expect(marked.findings[0]!.status).toBe('stands')
  })

  it('applyScopeFreezeAll batch demotes', () => {
    const out = applyScopeFreezeAll(
      [
        finding({
          id: 'a',
          severity: 'critical',
          title: 'a',
          file: 'core/a.ts',
          status: 'candidate',
        }),
        finding({
          id: 'b',
          severity: 'critical',
          title: 'b',
          file: 'other/b.ts',
          status: 'candidate',
        }),
      ],
      ['core/a.ts']
    )
    expect(out[0]!.status).toBe('candidate')
    expect(out[1]!.status).toBe('info')
  })
})
