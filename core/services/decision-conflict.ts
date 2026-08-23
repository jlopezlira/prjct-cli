/**
 * Decision Conflict Gate — edit-time judgment that can warn or deny.
 *
 * Intensity uses ONE dedicated surface: config.judgment.conflictMode
 * (off | advisory | strict) or pack-derived default. MUST NOT read
 * land.mode or sdd.mode (orthogonal contracts).
 *
 * Deny lift: memory ids present in `overriddenIds` (from remember tags
 * conflict:override) — mirrors loop-guard's turnLimitAcknowledgedAt pattern
 * without a new CLI verb.
 */

import { projectMemory } from '../memory/project-memory'
import { prjctDb } from '../storage/database'
import type { LocalConfig } from '../types/config'

export type ConflictMode = 'off' | 'advisory' | 'strict'
export type ConflictAction = 'none' | 'warn' | 'deny'
export type ConflictConfidence = 'high' | 'low'

/**
 * Hard wall-clock cap for the pre-edit conflict/preventive path (ms).
 *
 * Overridable via `PRJCT_CONFLICT_HARD_CAP_MS`. A fixed 300ms decides, at
 * runtime and invisibly, whether a strict gate fires at all: on a loaded
 * machine, a cold disk, or a large store the recall overruns it and the deny
 * never happens. That is a threshold silently changing behaviour — the thing
 * a user cannot see, reproduce, or tune. Making it settable also lets the
 * test that asserts the deny be deterministic instead of load-dependent.
 */
export const DEFAULT_CONFLICT_HARD_CAP_MS = 300

export function conflictHardCapMs(): number {
  const raw = Number(process.env.PRJCT_CONFLICT_HARD_CAP_MS)
  // 0 is valid and means 'treat the budget as already spent' — the only
  // way to exercise the fail-open path deterministically, since the work
  // itself is sub-millisecond.
  return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_CONFLICT_HARD_CAP_MS
}

/** @deprecated Read `conflictHardCapMs()` — a constant captured at import time
 *  cannot be changed without restarting, which matters for the long-lived
 *  daemon and makes the budget untestable. */
export const CONFLICT_HARD_CAP_MS = DEFAULT_CONFLICT_HARD_CAP_MS
/** Max preventive entries on the hot path. */
export const CONFLICT_RECALL_LIMIT = 3

export interface ConflictCandidate {
  id: string
  type: string
  content: string
  confidence: ConflictConfidence
}

export interface ConflictVerdict {
  action: ConflictAction
  memoryIds: string[]
  reason: string
  /** Agent-facing recovery line (no new verb). */
  recovery: string
  /** Full message for deny channel or additionalContext. */
  message: string
}

/**
 * Resolve conflictMode. Explicit config wins.
 * Pack-gated defaults (never land.mode / sdd.mode):
 *   - code-strict → strict
 *   - code → advisory
 *   - else → off (quiet default — avoid CONFLICT spam on every edit)
 */
export function effectiveConflictMode(config: LocalConfig | null | undefined): ConflictMode {
  const explicit = config?.judgment?.conflictMode
  if (explicit === 'off' || explicit === 'advisory' || explicit === 'strict') {
    return explicit
  }
  const packs = config?.persona?.packs ?? []
  if (packs.includes('code-strict')) return 'strict'
  if (packs.includes('code')) return 'advisory'
  return 'off'
}

/**
 * Pure gate. Never denies empty/low-confidence. Never denies when mode=off|advisory.
 * overriddenIds lifts high-confidence denies (durable consent).
 */
export function decisionConflictVerdict(input: {
  mode: ConflictMode
  candidates: ConflictCandidate[]
  /** Memory ids previously overridden for this file/cycle. */
  overriddenIds?: Iterable<string>
  fileLabel?: string
}): ConflictVerdict {
  const empty: ConflictVerdict = {
    action: 'none',
    memoryIds: [],
    reason: '',
    recovery: '',
    message: '',
  }

  if (input.mode === 'off') return empty
  const overridden = new Set(input.overriddenIds ?? [])
  const active = input.candidates.filter((c) => c.id && !overridden.has(c.id))
  if (active.length === 0) return empty

  const high = active.filter((c) => c.confidence === 'high')
  const low = active.filter((c) => c.confidence === 'low')
  const primary = high[0] ?? low[0]
  if (!primary) return empty

  const ids = active.map((c) => c.id)
  const fileBit = input.fileLabel ? ` on \`${input.fileLabel}\`` : ''
  const reason = `Edit may contradict [${primary.type}] ${truncate(primary.content, 80)} (\`${primary.id}\`)${fileBit}`
  const recovery =
    'To supersede: `prjct remember decision "…why supersede…" --tags supersedes:' +
    primary.id +
    '`. To lift deny for this memory: `prjct remember feedback "override conflict ' +
    primary.id +
    ': <why>" --tags conflict:override,memory:' +
    primary.id +
    '`.'

  // Low confidence never denies — warn at most under advisory/strict.
  if (high.length === 0) {
    return {
      action: 'warn',
      memoryIds: ids,
      reason: `Low-confidence preventive signal${fileBit}: ${truncate(primary.content, 80)}`,
      recovery,
      message: formatWarnMessage(reason, recovery, ids, false),
    }
  }

  if (input.mode === 'strict') {
    return {
      action: 'deny',
      memoryIds: high.map((c) => c.id),
      reason,
      recovery,
      message: formatDenyMessage(
        reason,
        recovery,
        high.map((c) => c.id)
      ),
    }
  }

  // advisory: warn on high, never deny
  return {
    action: 'warn',
    memoryIds: ids,
    reason,
    recovery,
    message: formatWarnMessage(reason, recovery, ids, true),
  }
}

function formatWarnMessage(reason: string, recovery: string, ids: string[], high: boolean): string {
  const head = high
    ? '# prjct: CONFLICT — decision/gotcha may block this path'
    : '# prjct: heads-up — weak preventive signal'
  return [
    head,
    '',
    reason,
    '',
    `Memory: ${ids.map((id) => `\`${id}\``).join(', ')}`,
    '',
    recovery,
    '',
    high
      ? '> Not a soft nudge. Revise the edit or supersede the decision with rationale before proceeding.'
      : '> Apply if it still holds; proceed if not.',
  ].join('\n')
}

function formatDenyMessage(reason: string, recovery: string, ids: string[]): string {
  return [
    `⛔ prjct conflict deny: ${reason}`,
    `Memories: ${ids.join(', ')}`,
    recovery,
    'Host will block Edit|Write until override or supersede. Fail-open only on hook errors, not on intentional deny.',
  ].join(' ')
}

/**
 * Load overridden memory ids from remember tags (conflict:override + memory:<id>)
 * written in the last 7 days — durable lift without a new verb.
 */
export function loadConflictOverrides(projectId: string): Set<string> {
  const out = new Set<string>()
  try {
    const since = Date.now() - 7 * 24 * 60 * 60 * 1000
    const rows = prjctDb.query<{ value: string }>(
      projectId,
      `SELECT t.value AS value
       FROM memory_entry_tags t
       JOIN memory_entries me ON me.id = t.entry_id
       WHERE me.deleted_at IS NULL
         AND me.created_at >= ?
         AND t.key = 'memory'
         AND EXISTS (
           SELECT 1 FROM memory_entry_tags t2
           WHERE t2.entry_id = me.id AND t2.key = 'conflict' AND t2.value = 'override'
         )`,
      since
    )
    for (const r of rows) {
      if (r.value) out.add(r.value.startsWith('mem_') ? r.value : `mem_${r.value}`)
    }
    // Also accept tag key memory: with value, or tags written as conflict:override
    // with memory in content — secondary path: key=conflict value=override already filtered.
  } catch {
    /* empty */
  }
  return out
}

/**
 * Best-effort audit row for closed-loop health metrics.
 * Only **deny** is persisted (warn is ephemeral additionalContext — avoid
 * flooding memory with one fact per Edit).
 */
export async function recordConflictEvent(
  projectPath: string,
  projectId: string,
  action: 'warn' | 'deny',
  memoryIds: string[],
  reason: string
): Promise<void> {
  if (action !== 'deny') return
  try {
    await projectMemory.remember(projectPath, {
      type: 'fact',
      content: `conflict-gate ${action}: ${truncate(reason, 200)}`,
      tags: {
        source: 'conflict-gate',
        conflict_action: action,
        memory: memoryIds[0] ?? '',
      },
      provenance: 'extracted',
      projectId,
    })
  } catch {
    /* never block edit path */
  }
}

export function countConflictEvents(
  projectId: string,
  action: 'warn' | 'deny',
  sinceMs = 0
): number {
  try {
    const row = prjctDb.get<{ c: number }>(
      projectId,
      `SELECT COUNT(*) AS c
       FROM memory_entries me
       JOIN memory_entry_tags t ON t.entry_id = me.id AND t.key = 'conflict_action' AND t.value = ?
       JOIN memory_entry_tags t2 ON t2.entry_id = me.id AND t2.key = 'source' AND t2.value = 'conflict-gate'
       WHERE me.deleted_at IS NULL AND me.created_at >= ?`,
      action,
      sinceMs
    )
    return row?.c ?? 0
  } catch {
    return 0
  }
}

/**
 * Map preventive memory entries to conflict candidates.
 * High confidence = gotcha/anti-pattern/decision with non-trivial content.
 */
export function candidatesFromPreventive(
  entries: Array<{ id: string; type: string; content: string; tags?: Record<string, string> }>
): ConflictCandidate[] {
  return entries.map((e) => {
    const preventive =
      e.type === 'gotcha' ||
      e.type === 'anti-pattern' ||
      e.type === 'decision' ||
      e.tags?.pattern === 'recurring-bug'
    const longEnough = (e.content?.trim().length ?? 0) >= 20
    return {
      id: e.id,
      type: e.type,
      content: e.content,
      confidence: preventive && longEnough ? ('high' as const) : ('low' as const),
    }
  })
}

/**
 * Fail-open timer: if elapsed since `startedAt` exceeds hard cap, treat as timeout.
 */
export function budgetExceeded(startedAt: number, hardCapMs = conflictHardCapMs()): boolean {
  return Date.now() - startedAt >= hardCapMs
}

function truncate(s: string, n: number): string {
  const t = s.replace(/\s+/g, ' ').trim()
  return t.length > n ? `${t.slice(0, n - 1)}…` : t
}
