/**
 * L0 compact memory index — Claude Code MEMORY.md pattern for prjct.
 *
 * Always-on, hard-capped table of contents so agents know what exists and
 * pull L2 (`prjct search` / `context memory <topic>`) instead of dumping
 * the vault into every cold start.
 *
 * Stored in kv_store (`memory:l0-index`). Rebuilt by `prjct dream` and
 * best-effort on land. SessionStart prefers a fresh stamp over rebuilding.
 */

import { isModelMemory, type MemoryEntry } from '../memory/entries'
import { formatMemoryDigestLine } from '../memory/format'
import { projectMemory } from '../memory/project-memory'
import { prjctDb } from '../storage/database'
import { getTimestamp } from '../utils/date-helper'
import { extractDeveloperRules } from './developer-profile'
import { usefulnessService } from './usefulness'

export const MEMORY_L0_INDEX_KEY = 'memory:l0-index'

/** Hard cap — multi-LLM cold start; tighter than Claude's ~25KB MEMORY.md. */
export const L0_INDEX_MAX_CHARS = 4_000

/** Index is "fresh" for SessionStart when younger than this. */
export const L0_INDEX_FRESH_MS = 24 * 60 * 60 * 1000

/** Match SessionStart digest density (proven slots, not vault dump). */
const PER_TYPE = 3
const DEV_RULES = 4
const REPEAT_MISS_THRESHOLD = 2
/** Teaser sizing for index lines (see `formatMemoryDigestLine`) — tighter than SessionStart's digest. */
const INDEX_TEASER = { minTeaser: 20, maxTeaser: 80 }
const INDEX_TYPES = ['decision', 'gotcha', 'anti-pattern', 'learning', 'fact', 'feedback'] as const

export interface MemoryL0IndexStamp {
  version: 1
  builtAt: string
  projectId: string
  live: number
  byType: Record<string, number>
  markdown: string
  /** Source of last rebuild. */
  source: 'dream' | 'land' | 'manual' | 'session-start'
}

export interface BuildMemoryL0IndexInput {
  projectId: string
  source?: MemoryL0IndexStamp['source']
  nowMs?: number
}

/**
 * Build + persist the L0 index. Pure-ish (DB reads/writes). Never throws.
 */
export function buildAndStoreMemoryL0Index(
  input: BuildMemoryL0IndexInput
): MemoryL0IndexStamp | null {
  try {
    const stamp = buildMemoryL0Index(input)
    if (!stamp) return null
    prjctDb.setDoc(input.projectId, MEMORY_L0_INDEX_KEY, stamp)
    return stamp
  } catch {
    return null
  }
}

/**
 * Pure builder (also used by tests). Returns null when vault has nothing
 * worth a SessionStart digest (empty / only noise).
 */
export function buildMemoryL0Index(input: BuildMemoryL0IndexInput): MemoryL0IndexStamp | null {
  const entries = projectMemory
    .allEntriesForIndex(input.projectId)
    .filter((e) => isModelMemory(e) || e.type === 'inbox' || e.type === 'improvement-signal')

  // Empty vault: no SessionStart noise (identity-only cold start).
  if (entries.length === 0) {
    return null
  }

  const byType: Record<string, number> = {}
  for (const e of entries) {
    byType[e.type] = (byType[e.type] ?? 0) + 1
  }

  // Prefer model-memory + inbox for "live" signal; improvement-signals alone
  // do not force a digest (avoids empty-looking cold starts).
  const modelish = entries.filter((e) => e.type !== 'improvement-signal' && isModelMemory(e))
  if (modelish.length === 0 && (byType.inbox ?? 0) === 0) {
    return null
  }

  const lines: string[] = [
    '## What this project already knows',
    '',
    '> Carried across sessions and model updates — this survived even if your conversation context did not. Apply these; do not re-derive from source.',
    '',
    `_L0 index · live=${entries.length} · pull L2: \`prjct search\` / \`prjct context memory <topic>\` / \`prjct guard <file>\`_`,
    '',
  ]

  // Only traps+decisions suppress the skill-miss slot (legacy digest contract):
  // a learning that is also skill-missed still earns "Keeps being missed".
  const suppressMissIds = new Set<string>()

  // Developer rules first (act-as-them) — small budget.
  try {
    const pool = projectMemory.recall(input.projectId, {
      types: ['feedback', 'improvement-signal'],
      limit: 40,
      dedupeByKey: false,
    })
    const rules = extractDeveloperRules(pool, DEV_RULES)
    if (rules.length > 0) {
      lines.push('**How this developer works (act as them):**')
      for (const r of rules) {
        const short = r.rule.length > 140 ? `${r.rule.slice(0, 139)}…` : r.rule
        lines.push(`- ${short}  \`${r.sourceId}\``)
      }
      lines.push('')
    }
  } catch {
    /* optional */
  }

  const sectionDefs: Array<{ title: string; types: string[]; suppressMiss?: boolean }> = [
    { title: 'Traps to avoid', types: ['gotcha', 'anti-pattern'], suppressMiss: true },
    { title: 'Decisions in force', types: ['decision'], suppressMiss: true },
    { title: 'Learnings', types: ['learning'] },
    { title: 'Facts', types: ['fact'] },
  ]

  for (const sec of sectionDefs) {
    const pool = usefulnessService
      .rerank(
        input.projectId,
        projectMemory.recall(input.projectId, {
          types: sec.types,
          limit: PER_TYPE * 4,
        })
      )
      .slice(0, PER_TYPE)
    if (pool.length === 0) continue
    lines.push(`**${sec.title}:**`)
    for (const e2 of pool) {
      lines.push(`- ${formatMemoryDigestLine(e2, INDEX_TEASER)}`)
      if (sec.suppressMiss) suppressMissIds.add(e2.id)
    }
    lines.push('')
  }

  // Skill-miss feedback loop (legacy digest read side).
  const repeatMiss = findRepeatMissedEntry(input.projectId, suppressMissIds)
  if (repeatMiss) {
    lines.push(
      '**Keeps being missed:**',
      `- ${formatMemoryDigestLine(repeatMiss.entry, INDEX_TEASER)} — flagged relevant-but-unused ${repeatMiss.count}×. Apply it or supersede it.`,
      ''
    )
  }

  const inbox = entries.filter((e) => e.type === 'inbox').slice(0, 3)
  const inboxN = byType.inbox ?? 0
  if (inboxN > 0) {
    lines.push(`**Inbox (${inboxN}):**`)
    for (const e3 of inbox) lines.push(`- ${formatMemoryDigestLine(e3, INDEX_TEASER)}`)
    if (inboxN > inbox.length) lines.push(`- … +${inboxN - inbox.length} more`)
    lines.push(
      '',
      '> Close resolved: `prjct close <id> --reason "…"`. Forget noise: `prjct forget <id>`.',
      ''
    )
  }

  // Type counts TOC (Claude MEMORY.md "what exists" without full bodies).
  const countParts = INDEX_TYPES.filter((t) => (byType[t] ?? 0) > 0)
    .map((t) => `${t}=${byType[t]}`)
    .concat(
      Object.keys(byType)
        .filter((t) => !(INDEX_TYPES as readonly string[]).includes(t) && (byType[t] ?? 0) > 0)
        .sort()
        .slice(0, 8)
        .map((t) => `${t}=${byType[t]}`)
    )
  if (countParts.length > 0) {
    lines.push(`_Counts: ${countParts.join(' · ')}_`, '')
  }

  lines.push(
    '> Resolve any `mem_id` with `prjct search <id>`. Full developer model: MCP `prjct_developer`. Consolidate: `prjct dream`. Never stuff L2 into L0.'
  )

  const fullMarkdown = lines.join('\n')
  const markdown =
    fullMarkdown.length > L0_INDEX_MAX_CHARS
      ? `${fullMarkdown.slice(0, L0_INDEX_MAX_CHARS - 20).trimEnd()}\n…(truncated)`
      : fullMarkdown

  return {
    version: 1,
    builtAt: getTimestamp(),
    projectId: input.projectId,
    live: entries.length,
    byType,
    markdown,
    source: input.source ?? 'manual',
  }
}

export function loadMemoryL0Index(projectId: string): MemoryL0IndexStamp | null {
  try {
    const raw = prjctDb.getDoc<MemoryL0IndexStamp>(projectId, MEMORY_L0_INDEX_KEY)
    if (!raw || raw.version !== 1 || !raw.markdown) return null
    return raw
  } catch {
    return null
  }
}

export function isMemoryL0IndexFresh(
  stamp: MemoryL0IndexStamp | null,
  nowMs: number = Date.now()
): boolean {
  if (!stamp?.builtAt) return false
  const t = Date.parse(stamp.builtAt)
  if (!Number.isFinite(t)) return false
  return nowMs - t <= L0_INDEX_FRESH_MS
}

/**
 * SessionStart / prime surface: prefer fresh stored index; else rebuild
 * best-effort; else null (caller keeps legacy digest).
 */
export function memoryL0IndexForSession(
  projectId: string,
  opts: { rebuildIfStale?: boolean } = {}
): string | null {
  try {
    const loaded = loadMemoryL0Index(projectId)
    const stamp =
      (!loaded || !isMemoryL0IndexFresh(loaded)) && opts.rebuildIfStale !== false
        ? buildAndStoreMemoryL0Index({ projectId, source: 'session-start' })
        : loaded
    if (!stamp?.markdown?.trim()) return null
    return stamp.markdown.trim()
  } catch {
    return null
  }
}

/**
 * Skill-miss feedback loop read side (same contract as SessionStart digest).
 * Exported: `hooks/session-start.ts` imports this directly rather than
 * keeping its own copy.
 */
export function findRepeatMissedEntry(
  projectId: string,
  alreadyShown: Set<string>
): { entry: MemoryEntry; count: number } | null {
  try {
    const signals = projectMemory.recall(projectId, {
      types: ['improvement-signal'],
      tags: { kind: 'skill-miss' },
      limit: 50,
      dedupeByKey: false,
    })
    const counts = new Map<string, number>()
    for (const s of signals) {
      const memId = s.tags?.relates
      if (!memId) continue
      counts.set(memId, (counts.get(memId) ?? 0) + 1)
    }
    const top = [...counts].sort((a, b) => b[1] - a[1])[0]
    if (!top || top[1] < REPEAT_MISS_THRESHOLD || alreadyShown.has(top[0])) return null
    const [topId, topCount] = top
    const entry = projectMemory.getById(projectId, topId)
    return entry ? { entry, count: topCount } : null
  } catch {
    return null
  }
}
