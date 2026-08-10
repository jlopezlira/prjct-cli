/**
 * Memory auto-dream — Claude Code KAIROS consolidation pattern for prjct.
 *
 * Deterministic 4-phase consolidator (no model call):
 *   1. Orient  — vault mass + type counts + last stamp
 *   2. Gather  — recent signal, inbox, retention candidates
 *   3. Consolidate — triageInbox + applyRetention (or dry-run)
 *   4. Prune   — rebuild L0 memory index + write dream stamp
 *
 * Gates (cheapest first): time → sessions → lock.
 * Wired as `prjct dream` and best-effort on `prjct land` when gates pass.
 */

import { prjctDb } from '../storage/database'
import { getTimestamp } from '../utils/date-helper'
import {
  buildAndStoreMemoryL0Index,
  buildMemoryL0Index,
  type MemoryL0IndexStamp,
} from './memory-index'
import {
  type ApplyRetentionResult,
  applyRetention,
  forgetJunkCaptures,
  triageInbox,
  type VaultHealth,
  vaultHealth,
} from './retention'

export const MEMORY_DREAM_STAMP_KEY = 'memory:dream'
export const MEMORY_DREAM_LOCK_KEY = 'memory:dream-lock'

/** Default: consolidate at most once per day unless forced. */
export const DREAM_DEFAULT_MIN_HOURS = 24
/** Default: need several session lands since last dream. */
export const DREAM_DEFAULT_MIN_SESSIONS = 5
/** Stale lock reclaim (crash mid-dream). */
export const DREAM_LOCK_STALE_MS = 30 * 60 * 1000

export interface MemoryDreamStamp {
  version: 1
  lastDreamAt: string
  /** Lands observed since last successful dream (incremented on land). */
  sessionsSinceDream: number
  lastResult?: {
    archived: number
    deleted: number
    inboxMerged: number
    inboxArchived: number
    dryRun: boolean
    live: number
  }
}

export interface MemoryDreamLock {
  startedAt: number
  owner: string
}

export interface DreamGateResult {
  ok: boolean
  reasons: string[]
  stamp: MemoryDreamStamp | null
  hoursSinceLast: number | null
  sessionsSinceDream: number
}

export interface RunMemoryDreamOptions {
  projectId: string
  projectPath?: string
  /** Bypass time + session gates (CLI --force). */
  force?: boolean
  dryRun?: boolean
  minHours?: number
  minSessions?: number
  maxArchive?: number
  maxDelete?: number
  nowMs?: number
  /**
   * When true (land path): if gates fail, only bump session counter and
   * return skipped — never error.
   */
  onLand?: boolean
}

export interface MemoryDreamReport {
  ran: boolean
  skipped: boolean
  reason?: string
  dryRun: boolean
  phases: {
    orient: { live: number; softDeleted: number; archives: number }
    gather: { inbox: number; wouldArchive: number; wouldDelete: number }
    consolidate: {
      archived: number
      deleted: number
      inboxMerged: number
      inboxArchived: number
      retention: ApplyRetentionResult | null
    }
    prune: { indexBuilt: boolean; indexLive: number }
  }
  gate: DreamGateResult
  stamp: MemoryDreamStamp | null
  index: MemoryL0IndexStamp | null
  line: string
  md: string
}

export function loadDreamStamp(projectId: string): MemoryDreamStamp | null {
  try {
    const raw = prjctDb.getDoc<MemoryDreamStamp>(projectId, MEMORY_DREAM_STAMP_KEY)
    if (!raw || raw.version !== 1) return null
    return raw
  } catch {
    return null
  }
}

function writeDreamStamp(projectId: string, stamp: MemoryDreamStamp): void {
  prjctDb.setDoc(projectId, MEMORY_DREAM_STAMP_KEY, stamp)
}

/**
 * Increment land/session counter so the session gate can fire.
 * Best-effort; never throws.
 */
export function recordDreamSession(projectId: string): MemoryDreamStamp {
  const prev = loadDreamStamp(projectId)
  const stamp: MemoryDreamStamp = {
    version: 1,
    lastDreamAt: prev?.lastDreamAt ?? '',
    sessionsSinceDream: (prev?.sessionsSinceDream ?? 0) + 1,
    lastResult: prev?.lastResult,
  }
  try {
    writeDreamStamp(projectId, stamp)
  } catch {
    /* ignore */
  }
  return stamp
}

export function evaluateDreamGates(
  projectId: string,
  opts: {
    force?: boolean
    minHours?: number
    minSessions?: number
    nowMs?: number
  } = {}
): DreamGateResult {
  const minHours = opts.minHours ?? DREAM_DEFAULT_MIN_HOURS
  const minSessions = opts.minSessions ?? DREAM_DEFAULT_MIN_SESSIONS
  const now = opts.nowMs ?? Date.now()
  const stamp = loadDreamStamp(projectId)
  const reasons: string[] = []

  if (opts.force) {
    return {
      ok: true,
      reasons: ['force'],
      stamp,
      hoursSinceLast: hoursSince(stamp?.lastDreamAt, now),
      sessionsSinceDream: stamp?.sessionsSinceDream ?? 0,
    }
  }

  const hours = hoursSince(stamp?.lastDreamAt, now)
  const sessions = stamp?.sessionsSinceDream ?? 0

  // First dream ever: allow if there is any live memory (caller checks mass).
  if (!stamp?.lastDreamAt) {
    return {
      ok: true,
      reasons: ['first-dream'],
      stamp,
      hoursSinceLast: null,
      sessionsSinceDream: sessions,
    }
  }

  if (hours !== null && hours < minHours) {
    reasons.push(`time-gate: ${hours.toFixed(1)}h < ${minHours}h since last dream`)
  }
  if (sessions < minSessions) {
    reasons.push(`session-gate: ${sessions} < ${minSessions} lands since last dream`)
  }

  return {
    ok: reasons.length === 0,
    reasons: reasons.length === 0 ? ['gates-open'] : reasons,
    stamp,
    hoursSinceLast: hours,
    sessionsSinceDream: sessions,
  }
}

function hoursSince(iso: string | undefined, nowMs: number): number | null {
  if (!iso) return null
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return null
  return (nowMs - t) / (60 * 60 * 1000)
}

function tryAcquireLock(projectId: string, nowMs: number): boolean {
  try {
    const existing = prjctDb.getDoc<MemoryDreamLock>(projectId, MEMORY_DREAM_LOCK_KEY)
    if (existing?.startedAt && nowMs - existing.startedAt < DREAM_LOCK_STALE_MS) {
      return false
    }
    prjctDb.setDoc(projectId, MEMORY_DREAM_LOCK_KEY, {
      startedAt: nowMs,
      owner: `pid-${process.pid}`,
    } satisfies MemoryDreamLock)
    return true
  } catch {
    return true // fail open — single-user CLI
  }
}

function releaseLock(projectId: string): void {
  try {
    // Tombstone rather than delete (setDoc API is set-only).
    prjctDb.setDoc(projectId, MEMORY_DREAM_LOCK_KEY, {
      startedAt: 0,
      owner: '',
    } satisfies MemoryDreamLock)
  } catch {
    /* ignore */
  }
}

/**
 * Run the full dream loop. Never throws — returns skipped report on gate fail.
 */
export function runMemoryDream(opts: RunMemoryDreamOptions): MemoryDreamReport {
  const nowMs = opts.nowMs ?? Date.now()
  const dryRun = opts.dryRun === true
  const projectId = opts.projectId

  const emptyPhases = (): MemoryDreamReport['phases'] => ({
    orient: { live: 0, softDeleted: 0, archives: 0 },
    gather: { inbox: 0, wouldArchive: 0, wouldDelete: 0 },
    consolidate: {
      archived: 0,
      deleted: 0,
      inboxMerged: 0,
      inboxArchived: 0,
      retention: null,
    },
    prune: { indexBuilt: false, indexLive: 0 },
  })

  // Land path always bumps session counter first (even when we skip dream).
  if (opts.onLand) {
    recordDreamSession(projectId)
  }

  const gate = evaluateDreamGates(projectId, {
    force: opts.force,
    minHours: opts.minHours,
    minSessions: opts.minSessions,
    nowMs,
  })

  if (!gate.ok) {
    const reason = gate.reasons.join('; ')
    return {
      ran: false,
      skipped: true,
      reason,
      dryRun,
      phases: emptyPhases(),
      gate,
      stamp: gate.stamp,
      index: null,
      line: `Dream skipped: ${reason}`,
      md: `## Memory dream\n\n_Skipped — ${reason}_\n`,
    }
  }

  if (!tryAcquireLock(projectId, nowMs)) {
    const reason = 'lock-held (another dream in progress)'
    return {
      ran: false,
      skipped: true,
      reason,
      dryRun,
      phases: emptyPhases(),
      gate,
      stamp: gate.stamp,
      index: null,
      line: `Dream skipped: ${reason}`,
      md: `## Memory dream\n\n_Skipped — ${reason}_\n`,
    }
  }

  try {
    // Phase 1 — Orient
    const health: VaultHealth = (() => {
      try {
        return vaultHealth(projectId)
      } catch {
        return {
          live: 0,
          softDeleted: 0,
          archives: 0,
          rememberEvents: 0,
          autoSourceLive: 0,
        }
      }
    })()

    // Phase 2 — Gather (dry retention preview for reporting)
    const preview: ApplyRetentionResult | null = (() => {
      try {
        return applyRetention(projectId, {
          dryRun: true,
          maxArchive: opts.maxArchive ?? 50,
          maxDelete: opts.maxDelete ?? 25,
          nowMs,
        })
      } catch {
        return null
      }
    })()

    const inboxCount = (() => {
      try {
        const row = prjctDb.get<{ n: number }>(
          projectId,
          "SELECT COUNT(*) AS n FROM memory_entries WHERE project_id IN (?, 'local') AND type = 'inbox' AND deleted_at IS NULL",
          projectId
        )
        return row?.n ?? 0
      } catch {
        return 0
      }
    })()

    // Phase 3 — Consolidate
    const { retention, inboxMerged, inboxArchived } = dryRun
      ? { retention: preview, inboxMerged: 0, inboxArchived: 0 }
      : (() => {
          const triage = (() => {
            try {
              const result = triageInbox(projectId, nowMs)
              return {
                merged: result.merged + (result.junkForgotten ?? 0),
                archived: result.archived,
              }
            } catch {
              return { merged: 0, archived: 0 }
            }
          })()
          const junkForgotten = (() => {
            try {
              return forgetJunkCaptures(projectId, { max: 40 }).forgotten
            } catch {
              return 0
            }
          })()
          const applied = (() => {
            try {
              return applyRetention(projectId, {
                dryRun: false,
                maxArchive: opts.maxArchive ?? 50,
                maxDelete: opts.maxDelete ?? 25,
                nowMs,
              })
            } catch {
              return null
            }
          })()
          return {
            retention: applied,
            inboxMerged: triage.merged + junkForgotten,
            inboxArchived: triage.archived,
          }
        })()

    // Phase 4 — Prune / index
    const index: MemoryL0IndexStamp | null = dryRun
      ? (() => {
          // Dry-run still builds index in-memory for preview; does not store.
          try {
            return buildMemoryL0Index({ projectId, source: 'dream' })
          } catch {
            return null
          }
        })()
      : buildAndStoreMemoryL0Index({ projectId, source: 'dream' })

    const archived = dryRun ? (preview?.wouldArchive ?? 0) : (retention?.archived ?? 0)
    const deleted = dryRun ? (preview?.wouldDelete ?? 0) : (retention?.deleted ?? 0)

    const stamp: MemoryDreamStamp | null = dryRun
      ? loadDreamStamp(projectId)
      : {
          version: 1,
          lastDreamAt: getTimestamp(),
          sessionsSinceDream: 0,
          lastResult: {
            archived: retention?.archived ?? 0,
            deleted: retention?.deleted ?? 0,
            inboxMerged,
            inboxArchived,
            dryRun: false,
            live: health.live,
          },
        }
    if (!dryRun && stamp) {
      try {
        writeDreamStamp(projectId, stamp)
      } catch {
        /* ignore */
      }
    }

    const phases: MemoryDreamReport['phases'] = {
      orient: {
        live: health.live,
        softDeleted: health.softDeleted,
        archives: health.archives,
      },
      gather: {
        inbox: inboxCount,
        wouldArchive: preview?.wouldArchive ?? 0,
        wouldDelete: preview?.wouldDelete ?? 0,
      },
      consolidate: {
        archived: dryRun ? 0 : (retention?.archived ?? 0),
        deleted: dryRun ? 0 : (retention?.deleted ?? 0),
        inboxMerged: dryRun ? 0 : inboxMerged,
        inboxArchived: dryRun ? 0 : inboxArchived,
        retention,
      },
      prune: {
        indexBuilt: Boolean(index),
        indexLive: index?.live ?? 0,
      },
    }

    const line = dryRun
      ? `Dream dry-run: live=${health.live} · would archive=${archived} delete=${deleted} · inbox=${inboxCount} · index≈${index?.live ?? 0}`
      : `Dream complete: archived=${phases.consolidate.archived} deleted=${phases.consolidate.deleted} inboxΔ=${inboxMerged + inboxArchived} · L0 index live=${index?.live ?? 0}`

    const md = [
      '## Memory dream',
      '',
      dryRun ? '_Dry-run — no writes._' : '_Applied consolidation._',
      '',
      '| Phase | Signal |',
      '|---|---|',
      `| Orient | live=${health.live} soft=${health.softDeleted} arch=${health.archives} |`,
      `| Gather | inbox=${inboxCount} wouldArchive=${preview?.wouldArchive ?? 0} wouldDelete=${preview?.wouldDelete ?? 0} |`,
      `| Consolidate | archived=${phases.consolidate.archived} deleted=${phases.consolidate.deleted} inboxMerged=${inboxMerged} inboxArchived=${inboxArchived} |`,
      `| Prune | index=${index ? 'yes' : 'no'} live=${index?.live ?? 0} |`,
      '',
      `**${line}**`,
      '',
    ].join('\n')

    return {
      ran: true,
      skipped: false,
      dryRun,
      phases,
      gate,
      stamp,
      index,
      line,
      md,
    }
  } finally {
    releaseLock(projectId)
  }
}

/**
 * Land path helper: bump session, run dream only when gates open.
 * Never throws.
 */
export function maybeDreamOnLand(projectId: string): MemoryDreamReport | null {
  try {
    return runMemoryDream({ projectId, onLand: true, force: false, dryRun: false })
  } catch {
    return null
  }
}
