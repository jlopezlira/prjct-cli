/**
 * Retention — Rho-inspired selective memory for prjct.
 *
 * microsoft/rho (Selective Language Modeling):
 *   1. Build a reference model on high-quality data
 *   2. Score candidates by excess loss vs reference
 *   3. Keep / train only high-excess signal
 *
 * prjct mapping (deterministic, 0 tokens, no new tables):
 *   1. R = judgment + living-v2 synthesis (reference-model.ts)
 *   2. excess(entry) = 1 - max_sim(entry, R\{entry}) via local embeddings (excess.ts)
 *   3. Verdict active|archive|delete from excess + usage + groundedness + floor
 *
 * Capture gate (capture-gate.ts) rejects low-excess noise at write time.
 * applyRetention soft-deletes according to verdicts (capped).
 */

import { loadIndex as loadBm25Index } from '../../domain/bm25'
import { memoryFingerprint } from '../../memory/content-fingerprint'
import { collectSupersededIds, isModelMemory, type MemoryEntry } from '../../memory/entries'
import { classifyCapturePrecision } from '../../memory/precision-classifier'
import { projectMemory } from '../../memory/project-memory'
import { archiveStorage } from '../../storage/archive-storage'
import prjctDb from '../../storage/database'
import { isJunkCaptureContent } from '../capture-junk'
import { isIrrelevantGeneratedContext } from '../context-quality-service'
import { extractCorrectionIds, usefulnessService } from '../usefulness'
import { hardDeleteEntries } from './distill'
import {
  buildReferenceIndex,
  type ExcessResult,
  excessAgainstIndex,
  type ReferenceIndex,
} from './excess'
import { buildReferenceModel } from './reference-model'

export type RetentionVerdict = 'active' | 'archive' | 'delete'

export interface RetentionResult {
  id: string
  type: string
  verdict: RetentionVerdict
  /** 0–100; higher = more worth keeping. */
  score: number
  reasons: string[]
  /** Rho excess ∈ [0,1]; high = novel vs R. */
  excess?: number
  maxSim?: number
  nearestId?: string | null
}

export interface RetentionReport {
  evaluated: number
  active: number
  archive: number
  delete: number
  /** |R| used for this evaluation. */
  referenceSize: number
  flagged: RetentionResult[]
  byId: Map<string, RetentionResult>
}

export interface ApplyRetentionOptions {
  dryRun?: boolean
  maxArchive?: number
  maxDelete?: number
  nowMs?: number
}

export interface ApplyRetentionResult {
  evaluated: number
  active: number
  wouldArchive: number
  wouldDelete: number
  archived: number
  deleted: number
  skipped: number
  dryRun: boolean
  samples: RetentionResult[]
  referenceSize?: number
}

export const PROTECTED_TYPES = new Set([
  'decision',
  'gotcha',
  'learning',
  'feedback',
  'fact',
  'shipped',
  'spec',
])

const GRACE_DAYS = 30
const ACTIVE_MIN = 50
const ARCHIVE_MIN = 20

/**
 * Score composition (0–100), Rho-first:
 *   excess contribution up to 45  — THE signal (novelty vs R)
 *   usefulness up to 25
 *   recency up to 15
 *   penalties: superseded/corrected/noise/ungrounded/idle/low-excess
 */
const EXCESS_MAX = 45
const USEFULNESS_MAX_BONUS = 25
const RECENCY_MAX_BONUS = 15
const RECENCY_WINDOW_DAYS = 180
const IDLE_AFTER_DAYS = 90
const IDLE_MAX_PENALTY = 25
const IDLE_PENALTY_PER_DAY = 0.12
const SUPERSEDED_PENALTY = 40
const CORRECTED_PENALTY = 40
const NOISE_PENALTY = 30
const UNGROUNDED_PENALTY = 20
/** When excess is near-zero, push hard toward archive (redundant with R). */
const LOW_EXCESS_PENALTY = 35
const LOW_EXCESS_CUTOFF = 0.12

const MS_PER_DAY = 86_400_000
const DEFAULT_MAX_ARCHIVE = 100
const DEFAULT_MAX_DELETE = 50
const INCREMENTAL_MAX_ARCHIVE = 25
const INCREMENTAL_MAX_DELETE = 15

const PATH_RE = /\b[\w.-]+(?:\/[\w.-]+)+\.(?:ts|tsx|js|jsx|mjs|cjs|json|md|sh|toml|yml|yaml)\b/g

export interface RetentionInputs {
  entries: MemoryEntry[]
  usefulness: Map<string, number>
  supersededIds: Set<string>
  correctedIds: Set<string>
  indexedPaths: Set<string> | null
  nowMs: number
  /** Prebuilt reference index (required for Rho excess). */
  refIndex: ReferenceIndex
}

export function collectRetentionInputs(projectId: string, nowMs: number): RetentionInputs {
  const entries = projectMemory.allEntriesForIndex(projectId)

  const correctedIds = new Set<string>()
  for (const entry of entries) {
    for (const id of extractCorrectionIds(entry.tags)) correctedIds.add(id)
  }

  const indexedPaths = (() => {
    try {
      const index = loadBm25Index(projectId)
      return index ? new Set(Object.keys(index.documents)) : null
    } catch {
      return null
    }
  })()

  const R = buildReferenceModel(entries)
  const refIndex = buildReferenceIndex(R)

  return {
    entries,
    usefulness: usefulnessService.decayedScores(projectId, nowMs),
    supersededIds: collectSupersededIds(entries),
    correctedIds,
    indexedPaths,
    nowMs,
    refIndex,
  }
}

export function collectDuplicateIds(entries: MemoryEntry[]): Set<string> {
  const newestByPrint = new Map<string, MemoryEntry>()
  const duplicates = new Set<string>()
  const byNewest = [...entries].sort((a, b) => b.rememberedAt.localeCompare(a.rememberedAt))
  for (const entry of byNewest) {
    const print = memoryFingerprint(entry.content)
    if (newestByPrint.has(print)) duplicates.add(entry.id)
    else newestByPrint.set(print, entry)
  }
  return duplicates
}

function isUngrounded(entry: MemoryEntry, indexedPaths: Set<string>): boolean {
  const cited = entry.content.match(PATH_RE)
  if (!cited || cited.length === 0) return false
  return !cited.some((p) => indexedPaths.has(p))
}

export function scoreEntry(
  entry: MemoryEntry,
  inputs: RetentionInputs,
  duplicateIds: Set<string>
): RetentionResult {
  const reasons: string[] = []

  // ── Rho core: excess vs R ──────────────────────────────────────────
  const ex: ExcessResult = excessAgainstIndex(entry.content, inputs.refIndex, entry.id)
  // Exact/near fingerprint dups among full corpus still count
  const corpusDup = duplicateIds.has(entry.id)
  if (corpusDup && !ex.exactDup) {
    reasons.push('duplicate of newer entry')
  }

  // Start from excess — high novelty is the keep signal (Rho).
  reasons.push(`excess ${ex.excess.toFixed(2)} (sim ${ex.maxSim.toFixed(2)})`)

  const lowExcess = ex.exactDup || ex.nearDup || ex.excess < LOW_EXCESS_CUTOFF
  if (lowExcess) {
    reasons.push(
      ex.exactDup
        ? `exact dup of ${ex.nearestId}`
        : ex.nearDup
          ? `near-dup of ${ex.nearestId}`
          : 'low excess vs reference'
    )
  }

  // ── Real usage ─────────────────────────────────────────────────────
  const usefulness = inputs.usefulness.get(entry.id) ?? 0
  const usefulnessBonus = Math.min(USEFULNESS_MAX_BONUS, Math.max(0, usefulness * 8))
  if (usefulness > 0) {
    reasons.push(`used (+${Math.round(usefulnessBonus)})`)
  }

  const ageDays = Math.max(0, (inputs.nowMs - Date.parse(entry.rememberedAt)) / MS_PER_DAY)
  const recencyBonus = Number.isFinite(ageDays)
    ? Math.max(0, RECENCY_MAX_BONUS * (1 - ageDays / RECENCY_WINDOW_DAYS))
    : 0

  const idlePenalty =
    usefulness <= 0 && Number.isFinite(ageDays) && ageDays > IDLE_AFTER_DAYS
      ? Math.min(IDLE_MAX_PENALTY, (ageDays - IDLE_AFTER_DAYS) * IDLE_PENALTY_PER_DAY)
      : 0
  if (idlePenalty > 0) {
    reasons.push(`idle ${Math.round(ageDays)}d`)
  }

  // ── Groundedness / refutation ──────────────────────────────────────
  const superseded = inputs.supersededIds.has(entry.id)
  if (superseded) {
    reasons.push('superseded')
  }
  const corrected = inputs.correctedIds.has(entry.id)
  if (corrected) {
    reasons.push('corrected')
  }

  const noise = !isModelMemory(entry) || isIrrelevantGeneratedContext(entry)
  if (noise) {
    reasons.push('generated noise')
  }

  const ungrounded = Boolean(inputs.indexedPaths && isUngrounded(entry, inputs.indexedPaths))
  if (ungrounded) {
    reasons.push('cites files missing at HEAD')
  }

  const score = Math.max(
    0,
    Math.min(
      100,
      ex.excess * EXCESS_MAX +
        usefulnessBonus +
        recencyBonus -
        (lowExcess ? LOW_EXCESS_PENALTY : 0) -
        idlePenalty -
        (superseded ? SUPERSEDED_PENALTY : 0) -
        (corrected ? CORRECTED_PENALTY : 0) -
        (noise ? NOISE_PENALTY : 0) -
        (ungrounded ? UNGROUNDED_PENALTY : 0) -
        (corpusDup ? 20 : 0)
    )
  )

  const scoredVerdict: RetentionVerdict =
    score >= ACTIVE_MIN ? 'active' : score >= ARCHIVE_MIN ? 'archive' : 'delete'

  // Grace: brand-new high-stakes knowledge gets time to be used —
  // unless already known-dead (dup/superseded/near-dup of R).
  const knownDead = corpusDup || ex.exactDup || ex.nearDup || superseded
  const graceVerdict =
    scoredVerdict !== 'active' && ageDays < GRACE_DAYS && !knownDead ? 'active' : scoredVerdict
  if (graceVerdict !== scoredVerdict) {
    reasons.push('grace period')
  }

  const verdict =
    graceVerdict === 'delete' && PROTECTED_TYPES.has(entry.type) ? 'archive' : graceVerdict
  if (verdict !== graceVerdict) {
    reasons.push('protected type')
  }

  return {
    id: entry.id,
    type: entry.type,
    verdict,
    score: Math.round(score),
    reasons,
    excess: ex.excess,
    maxSim: ex.maxSim,
    nearestId: ex.nearestId,
  }
}

export function evaluateRetention(projectId: string, nowMs: number): RetentionReport {
  const inputs = collectRetentionInputs(projectId, nowMs)
  const duplicateIds = collectDuplicateIds(inputs.entries)

  const report: RetentionReport = {
    evaluated: inputs.entries.length,
    active: 0,
    archive: 0,
    delete: 0,
    referenceSize: inputs.refIndex.entries.length,
    flagged: [],
    byId: new Map(),
  }

  for (const entry of inputs.entries) {
    const result = scoreEntry(entry, inputs, duplicateIds)
    report[result.verdict]++
    report.byId.set(result.id, result)
    if (result.verdict !== 'active') report.flagged.push(result)
  }

  report.flagged.sort((a, b) => a.score - b.score)
  return report
}

export function shouldEmbedEntry(entry: MemoryEntry, retention?: RetentionResult | null): boolean {
  if (!isModelMemory(entry)) return false
  if (entry.content.trim().length === 0) return false
  if (retention && retention.verdict !== 'active') return false
  // Rho: do not embed zero-excess near-dups of R
  if (retention && retention.excess !== undefined && retention.excess < 0.05) return false
  return true
}

/**
 * Soft-remove one retention candidate from live surfaces.
 * - mem_* → projectMemory.forget / memory_entries soft-delete
 * - ship_* → archive + DELETE from shipped_features (ships live only there;
 *   previously forget always failed → dream wouldArchive>0, archived=0)
 */
function forgetEntry(projectId: string, id: string): boolean {
  if (id.startsWith('ship_')) {
    return forgetShippedFeature(projectId, id)
  }
  if (projectMemory.forget(projectId, id)) return true
  try {
    const r = prjctDb.run(
      projectId,
      'UPDATE memory_entries SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL',
      Date.now(),
      id
    )
    return (r.changes ?? 0) > 0
  } catch {
    return false
  }
}

/** True when retention can actually remove this id from live surfaces. */
export function isRetentionRemovableId(id: string): boolean {
  return id.startsWith('mem_') || id.startsWith('ship_') || /^\d+$/.test(id)
}

/**
 * Archive a shipped_features row referenced as `ship_<uuid>` (see shippedRowToEntry).
 * Mirrors archiveOldShipped for a single retention candidate.
 */
export function forgetShippedFeature(projectId: string, shipPrefixedId: string): boolean {
  const rawId = shipPrefixedId.startsWith('ship_')
    ? shipPrefixedId.slice('ship_'.length)
    : shipPrefixedId
  if (!rawId) return false
  try {
    const row = prjctDb.get<{
      id: string
      name: string
      shipped_at: string
      version: string | null
      description: string | null
      type: string | null
      duration: number | null
      data: string | null
    }>(projectId, 'SELECT * FROM shipped_features WHERE id = ?', rawId)
    if (!row) return false

    try {
      archiveStorage.archive(projectId, {
        entityType: 'shipped',
        entityId: rawId,
        entityData: row,
        summary: `retention archive shipped [${row.name}]`,
        reason: 'retention-archive',
      })
    } catch {
      /* still delete from live table even if archive row fails */
    }

    const r = prjctDb.run(projectId, 'DELETE FROM shipped_features WHERE id = ?', rawId)
    return (r.changes ?? 0) > 0
  } catch {
    return false
  }
}

export function applyRetention(
  projectId: string,
  options: ApplyRetentionOptions = {}
): ApplyRetentionResult {
  const dryRun = options.dryRun === true
  const nowMs = options.nowMs ?? Date.now()
  const maxArchive = options.maxArchive ?? DEFAULT_MAX_ARCHIVE
  const maxDelete = options.maxDelete ?? DEFAULT_MAX_DELETE

  const report = evaluateRetention(projectId, nowMs)
  // Honest counts: only ids we can actually remove (mem_* / ship_*). Orphan
  // shapes (if any) do not inflate wouldArchive / wouldDelete vs archived.
  const toArchive = report.flagged.filter(
    (r) => r.verdict === 'archive' && isRetentionRemovableId(r.id)
  )
  const toDelete = report.flagged.filter(
    (r) => r.verdict === 'delete' && isRetentionRemovableId(r.id)
  )
  const unremovable = report.flagged.filter(
    (r) => (r.verdict === 'archive' || r.verdict === 'delete') && !isRetentionRemovableId(r.id)
  ).length

  const applied = dryRun
    ? { archived: 0, deleted: 0, skipped: unremovable }
    : (() => {
        const archiveBatch = toArchive.slice(0, maxArchive)
        const archiveResults = archiveBatch.map((result) => {
          // Ships archive inside forgetShippedFeature; mem_* get a memory_entry
          // archive row here (ships already write entityType:shipped).
          if (!result.id.startsWith('ship_')) {
            try {
              archiveStorage.archive(projectId, {
                entityType: 'memory_entry',
                entityId: result.id,
                entityData: {
                  id: result.id,
                  type: result.type,
                  score: result.score,
                  excess: result.excess,
                  reasons: result.reasons,
                  verdict: result.verdict,
                },
                summary: `retention archive [${result.type}] excess=${result.excess?.toFixed(2) ?? '?'} score=${result.score}`,
                reason: 'retention-archive',
              })
            } catch {
              /* best-effort */
            }
          }
          return forgetEntry(projectId, result.id)
        })
        const archived = archiveResults.filter(Boolean).length
        const archiveSkipped =
          Math.max(0, toArchive.length - archiveBatch.length) +
          archiveResults.filter((success) => !success).length

        // Delete verdict = no future value (not even statistical): HARD-delete.
        // Protected types never reach here (floored to archive).
        const deleteBatch = toDelete.slice(0, maxDelete)
        const hardIds = deleteBatch
          .filter((result) => !PROTECTED_TYPES.has(result.type))
          .map((result) => result.id)
        const protectedSkipped = deleteBatch.length - hardIds.length
        const deleted = hardIds.length > 0 ? hardDeleteEntries(projectId, hardIds) : 0
        const deleteSkipped =
          Math.max(0, toDelete.length - deleteBatch.length) +
          protectedSkipped +
          hardIds.length -
          deleted
        return { archived, deleted, skipped: unremovable + archiveSkipped + deleteSkipped }
      })()

  return {
    evaluated: report.evaluated,
    active: report.active,
    wouldArchive: toArchive.length,
    wouldDelete: toDelete.length,
    archived: applied.archived,
    deleted: applied.deleted,
    skipped: applied.skipped,
    dryRun,
    samples: report.flagged.slice(0, 10),
    referenceSize: report.referenceSize,
  }
}

export function applyRetentionIncremental(projectId: string): ApplyRetentionResult {
  return applyRetention(projectId, {
    maxArchive: INCREMENTAL_MAX_ARCHIVE,
    maxDelete: INCREMENTAL_MAX_DELETE,
  })
}

/**
 * Forget live entries that match junk-capture heuristics (tool dumps, bare
 * mem ids, short noise). Caps batch size. Used by dream + optional doctor.
 */
export function forgetJunkCaptures(
  projectId: string,
  options: { max?: number; types?: string[] } = {}
): { forgotten: number; samples: string[] } {
  const max = options.max ?? 50
  // Include gotcha/spec so precision shape failures (open narration, empty
  // mirrors) leave living surfaces on dream — not only low-stakes junk.
  const types = options.types ?? ['inbox', 'context', 'idea', 'todo', 'question', 'gotcha', 'spec']
  const forgottenEntries: MemoryEntry[] = []
  const samples: string[] = []
  try {
    const entries = projectMemory.allEntriesForIndex(projectId)
    for (const e of entries) {
      if (forgottenEntries.length >= max) break
      if (!types.includes(e.type)) continue
      const j = isJunkCaptureContent(e.content, e.type)
      const precision = classifyCapturePrecision(e.content, e.type)
      const drop =
        j.junk ||
        precision.action === 'refuse' ||
        // Historical open-narration gotchas: drop from living judgment surface
        (e.type === 'gotcha' && precision.action === 'demote')
      if (!drop) continue
      if (forgetEntry(projectId, e.id)) {
        forgottenEntries.push(e)
        if (samples.length < 8) {
          samples.push(`${e.id}:${j.junk ? j.reason : precision.reasonCode}`)
        }
      }
    }
  } catch {
    return { forgotten: 0, samples: [] }
  }
  return { forgotten: forgottenEntries.length, samples }
}

export function triageInbox(
  projectId: string,
  nowMs: number = Date.now()
): { merged: number; archived: number; junkForgotten: number } {
  const entries = projectMemory.allEntriesForIndex(projectId)
  const inbox = entries.filter((e) => e.type === 'inbox')
  if (inbox.length === 0) return { merged: 0, archived: 0, junkForgotten: 0 }

  // First pass: junk content (always drop from living rotation).
  const junkForgotten = inbox.filter(
    (item) => isJunkCaptureContent(item.content, item.type).junk && forgetEntry(projectId, item.id)
  ).length

  const remaining = projectMemory.allEntriesForIndex(projectId).filter((e) => e.type === 'inbox')
  if (remaining.length === 0) return { merged: 0, archived: 0, junkForgotten }

  const R = buildReferenceModel(projectMemory.allEntriesForIndex(projectId))
  const refIndex = buildReferenceIndex(R)
  const report = evaluateRetention(projectId, nowMs)

  const mergedIds: string[] = []
  const archivedIds: string[] = []

  for (const item of remaining) {
    const ex = excessAgainstIndex(item.content, refIndex)
    if (ex.exactDup || ex.nearDup || ex.excess < 0.15) {
      if (forgetEntry(projectId, item.id)) mergedIds.push(item.id)
      continue
    }
    const verdict = report.byId.get(item.id)
    if (verdict && verdict.verdict !== 'active') {
      try {
        archiveStorage.archive(projectId, {
          entityType: 'memory_entry',
          entityId: item.id,
          entityData: {
            id: item.id,
            type: 'inbox',
            score: verdict.score,
            excess: verdict.excess,
            reasons: verdict.reasons,
          },
          summary: `inbox triage excess=${verdict.excess?.toFixed(2) ?? '?'}`,
          reason: 'retention-inbox',
        })
      } catch {
        /* best-effort */
      }
      if (forgetEntry(projectId, item.id)) archivedIds.push(item.id)
    }
  }

  return { merged: mergedIds.length, archived: archivedIds.length, junkForgotten }
}

export type { CaptureGateResult } from './capture-gate'
// Re-exports for tests and capture path
export { captureGate } from './capture-gate'
export type { ExcessResult } from './excess'
export { CAPTURE_MIN_EXCESS, computeExcess, NEAR_DUP_SIM } from './excess'
export type { PurgeResult, VaultHealth } from './purge'
export {
  DEFAULT_SOFT_DELETED_PURGE_DAYS,
  isAutoSource,
  purgeOrphanRememberEvents,
  purgeSoftDeleted,
  runVaultPurge,
  trimAutoSourceCap,
  vaultHealth,
} from './purge'
export { buildReferenceModel, isReferenceEligible, REFERENCE_CAP } from './reference-model'
