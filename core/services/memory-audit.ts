/**
 * Memory audit — the visible, fail-able relevance check.
 *
 * prjct already deletes irrelevant memory automatically (retention runs in
 * `apply` mode on sync: superseded/corrected/idle/redundant → archive/delete,
 * capped). What was missing is a way to SEE it and TRUST it. This audit
 * surfaces exactly the metrics Theo used to condemn naïve memory — never-read
 * share, stale share, slop (signal ratio), and what the auto-cleanup would
 * remove next — and FAILS a threshold, so a project whose memory has rotted
 * says so out loud instead of failing silently.
 *
 * Below a small corpus it reports but never fails (not decision-grade volume),
 * mirroring the retrieval gate's minimum-sample rule.
 */

import { isModelMemory } from '../memory/entries'
import { projectMemory } from '../memory/project-memory'
import { computeSubstrateHealth } from '../memory/substrate-health'
import prjctDb from '../storage/database'
import { evaluateRetentionShared } from './retention'

const STALE_DAYS = 180
const MIN_CORPUS_TO_GATE = 20
const DEFAULT_MAX_NEVER_READ_PCT = 60
const DEFAULT_MIN_SIGNAL_RATIO = 0.7

export interface MemoryAuditThresholds {
  maxNeverReadPct: number
  minSignalRatio: number
}

export interface MemoryAudit {
  total: number
  engaged: number
  /** Entries with a real citation (+REF) — the strong, uninflatable signal. */
  cited: number
  citedPct: number
  neverRead: number
  neverReadPct: number
  stale: number
  stalePct: number
  /** What the automatic retention cleanup would remove on the next apply. */
  wouldArchive: number
  wouldDelete: number
  signalRatio: number
  slopPct: number
  gated: boolean
  passed: boolean
  failures: string[]
  thresholds: MemoryAuditThresholds
}

interface EngagementSets {
  engaged: Set<string>
  cited: Set<string>
}

// cited (ref_count) is tracked apart from the engaged union because historical
// fetch_count rows were inflated by the old recall-credits-everything bug —
// citations are the signal that was never inflatable.
function engagementSets(projectId: string): EngagementSets {
  const engaged = new Set<string>()
  const cited = new Set<string>()
  try {
    const rows = prjctDb.query<{ memory_id: string; ref_count: number }>(
      projectId,
      'SELECT memory_id, ref_count FROM memory_usefulness WHERE ref_count > 0 OR fetch_count > 0'
    )
    for (const row of rows) {
      engaged.add(row.memory_id)
      if (row.ref_count > 0) cited.add(row.memory_id)
    }
  } catch {
    /* memory_usefulness may be empty/absent — treat as no engagement */
  }
  return { engaged, cited }
}

export function buildMemoryAudit(
  projectId: string,
  thresholds: MemoryAuditThresholds = {
    maxNeverReadPct: DEFAULT_MAX_NEVER_READ_PCT,
    minSignalRatio: DEFAULT_MIN_SIGNAL_RATIO,
  },
  nowMs: number = Date.now()
): MemoryAudit {
  const entries = projectMemory.recall(projectId, { limit: 100_000 }).filter(isModelMemory)
  const total = entries.length
  const retention = evaluateRetentionShared(projectId, nowMs)
  const health = computeSubstrateHealth(entries, nowMs)

  const sets = engagementSets(projectId)
  const engagedCount = entries.filter((e) => sets.engaged.has(e.id)).length
  const citedCount = entries.filter((e) => sets.cited.has(e.id)).length
  const neverRead = total - engagedCount

  const staleMs = STALE_DAYS * 24 * 60 * 60 * 1000
  const stale = entries.filter((e) => {
    const t = Date.parse(e.rememberedAt)
    return Number.isFinite(t) && nowMs - t > staleMs
  }).length

  const pct = (n: number): number => (total === 0 ? 0 : Math.round((n / total) * 1000) / 10)
  const neverReadPct = pct(neverRead)
  const slopPct = Math.round((1 - health.signalRatio) * 1000) / 10

  const gated = total >= MIN_CORPUS_TO_GATE
  const failures: string[] = []
  if (gated) {
    if (neverReadPct > thresholds.maxNeverReadPct) {
      failures.push(`never-read ${neverReadPct}% > ${thresholds.maxNeverReadPct}%`)
    }
    if (health.signalRatio < thresholds.minSignalRatio) {
      failures.push(
        `signal ${Math.round(health.signalRatio * 100)}% < ${Math.round(thresholds.minSignalRatio * 100)}%`
      )
    }
  }

  return {
    total,
    engaged: engagedCount,
    cited: citedCount,
    citedPct: pct(citedCount),
    neverRead,
    neverReadPct,
    stale,
    stalePct: pct(stale),
    wouldArchive: retention.archive,
    wouldDelete: retention.delete,
    signalRatio: health.signalRatio,
    slopPct,
    gated,
    passed: failures.length === 0,
    failures,
    thresholds,
  }
}

function verdictLine(audit: MemoryAudit): string {
  if (!audit.gated)
    return `INFORMATIONAL (corpus ${audit.total} < ${MIN_CORPUS_TO_GATE}, not gated)`
  return audit.passed ? 'PASS' : `FAIL — ${audit.failures.join('; ')}`
}

export function renderMemoryAuditMd(audit: MemoryAudit): string {
  const pctStr = (n: number): string => `${n}%`
  return [
    `## Memory audit — ${audit.total} model-worthy entries`,
    '',
    `- **read / used:** ${audit.engaged} engaged (${audit.cited} cited — the uninflatable signal · ${audit.engaged - audit.cited} fetch-only) · ${audit.neverRead} never read (${pctStr(audit.neverReadPct)})`,
    `- **signal:** ${Math.round(audit.signalRatio * 100)}% (slop ${pctStr(audit.slopPct)})`,
    `- **stale (>${STALE_DAYS}d):** ${audit.stale} (${pctStr(audit.stalePct)})`,
    `- **auto-cleanup would remove next:** ${audit.wouldDelete} delete · ${audit.wouldArchive} archive`,
    '',
    `**Verdict: ${verdictLine(audit)}**`,
    '',
    audit.passed
      ? '_Memory is earning its place. The automatic retention pass keeps it clean on each sync._'
      : '_Memory is not earning its place — retention is not keeping up, or the corpus has rotted. Run `prjct sync` to apply cleanup, or raise the bar._',
    '',
  ].join('\n')
}

export function renderMemoryAuditText(audit: MemoryAudit): string {
  return [
    `Memory audit · ${audit.total} entries`,
    `  read/used:    ${audit.engaged} engaged (${audit.cited} cited · ${audit.engaged - audit.cited} fetch-only) · ${audit.neverRead} never read (${audit.neverReadPct}%)`,
    `  signal:       ${Math.round(audit.signalRatio * 100)}% (slop ${audit.slopPct}%)`,
    `  stale >${STALE_DAYS}d:   ${audit.stale} (${audit.stalePct}%)`,
    `  cleanup next: ${audit.wouldDelete} delete · ${audit.wouldArchive} archive`,
    `  verdict:      ${verdictLine(audit)}`,
  ].join('\n')
}
