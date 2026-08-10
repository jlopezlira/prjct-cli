/**
 * Distill-then-discard — Rho for historical noise.
 *
 * If raw history has no future value (not even statistical), we:
 *   1. Analyze the batch (types, sources, top phrases, counts)
 *   2. Write ONE compact synthesis into the model (topic upsert)
 *   3. HARD-delete the raw rows (no soft-delete purgatory, no archive)
 *
 * Deterministic, 0 tokens. The digest is the only durable residue.
 */

import type { MemoryEntry } from '../../memory/entries'
import { deriveTitle } from '../../memory/format'
import { projectMemory } from '../../memory/project-memory'
import prjctDb from '../../storage/database'
import { isAutoSource } from './purge'

export interface DistillDiscardResult {
  /** Raw rows hard-deleted. */
  discarded: number
  /** Whether a digest entry was written/updated. */
  digested: boolean
  digestTopic?: string
}

const MAX_DIGEST_BULLETS = 8
const MAX_BULLET_CHARS = 140

/** Hard-delete live or soft-deleted memory_entries by id (and embeddings). */
export function hardDeleteEntries(projectId: string, ids: string[]): number {
  if (ids.length === 0) return 0
  const deleted: string[] = []
  try {
    prjctDb.transaction(projectId, (db) => {
      const delEmb = db.prepare('DELETE FROM memory_embeddings WHERE memory_id = ?')
      const delEntry = db.prepare('DELETE FROM memory_entries WHERE id = ?')
      // Drop remember event if mem_N
      const delEv = db.prepare("DELETE FROM events WHERE id = ? AND type LIKE 'memory.remember.%'")
      for (const id of ids) {
        try {
          delEmb.run(id)
        } catch {
          /* ok */
        }
        const r = delEntry.run(id)
        if ((r as { changes?: number }).changes) deleted.push(id)
        const m = id.match(/^mem_(\d+)$/)
        if (m) {
          try {
            delEv.run(Number(m[1]))
          } catch {
            /* ok */
          }
        }
      }
    })
  } catch {
    return deleted.length
  }
  return deleted.length
}

/**
 * Build a deterministic one-entry digest from a batch of low-value rows.
 * Captures counts + a few title cues — enough for a human/agent later,
 * not a second copy of the noise.
 */
export function buildDistillContent(
  sourceKey: string,
  batch: MemoryEntry[],
  nowIso: string
): string {
  const byType = new Map<string, number>()
  for (const e of batch) {
    byType.set(e.type, (byType.get(e.type) ?? 0) + 1)
  }
  const typeLine = [...byType.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([t, c]) => `${t}×${c}`)
    .join(', ')

  // Prefer longer / more structured titles as bullets
  const bullets = batch
    .map((e) => deriveTitle(e).replace(/\s+/g, ' ').trim())
    .filter((t) => t.length > 20)
    .slice(0, MAX_DIGEST_BULLETS)
    .map((t) => `- ${t.length > MAX_BULLET_CHARS ? `${t.slice(0, MAX_BULLET_CHARS - 1)}…` : t}`)

  const parts = [
    `Distill of discarded auto-history (${sourceKey}).`,
    `Context synthesis: ${batch.length} low-value rows collapsed — raw history deleted; only this digest remains for the project model.`,
    `Key data: source=retention-distill; discarded=${batch.length}; types=${typeLine}; at=${nowIso}`,
    `What happened: purged auto-generated / redundant captures that added no excess vs the reference model.`,
    `Why it mattered: prevent vault bloat; agents must not re-read detector noise.`,
    `Outcome: ${batch.length} raw entries hard-deleted after distillation.`,
    `Next implication: prefer high-excess judgment; re-run detectors only when code/model changes.`,
  ]
  if (bullets.length > 0) {
    parts.push(`Sample cues (not full bodies):\n${bullets.join('\n')}`)
  }
  return parts.join(' ')
}

/**
 * For one auto-source bucket: keep at most `keep` newest, distill the rest
 * into a single topic entry, hard-delete overflow (no archive).
 */
export async function distillAndDiscardAutoSource(
  projectPath: string,
  projectId: string,
  source: string,
  entries: MemoryEntry[],
  keep: number
): Promise<DistillDiscardResult> {
  if (entries.length <= keep) {
    return { discarded: 0, digested: false }
  }

  const sorted = [...entries].sort((a, b) => b.rememberedAt.localeCompare(a.rememberedAt))
  const overflow = sorted.slice(keep)
  if (overflow.length === 0) return { discarded: 0, digested: false }

  const nowIso = new Date().toISOString()
  const topic = `auto-distill:${source}`
  const content = buildDistillContent(source, overflow, nowIso)

  const digested = await projectMemory
    .remember(projectPath, {
      type: 'learning',
      content,
      tags: {
        source: 'retention-distill',
        topic,
        capture: 'distill-discard-v1',
        context_schema: 'living-v2',
        synthesis: 'deterministic',
        discarded_count: String(overflow.length),
        auto_source: source,
      },
      provenance: 'inferred',
      projectId,
    })
    .then(() => true)
    .catch(() => false)

  // Hard-delete overflow — no soft-delete, no archives table.
  // Exclude the digest if remember re-used an id (won't be in overflow).
  const ids = overflow.map((e) => e.id)
  const discarded = hardDeleteEntries(projectId, ids)

  return { discarded, digested, digestTopic: topic }
}

/**
 * Distill all auto-source groups over `maxLive`, then hard-delete excess.
 */
export async function distillAndDiscardAllAutoSources(
  projectPath: string,
  projectId: string,
  maxLive: number
): Promise<{ discarded: number; digests: number }> {
  const all = projectMemory.allEntriesForIndex(projectId)
  const bySource = new Map<string, MemoryEntry[]>()
  for (const e of all) {
    const src = e.tags?.source
    if (!isAutoSource(src)) continue
    // Never distill the distill digests themselves
    if (src === 'retention-distill' || e.tags?.source === 'retention-distill') continue
    const list = bySource.get(src!) ?? []
    list.push(e)
    bySource.set(src!, list)
  }

  const results: DistillDiscardResult[] = []
  for (const [source, list] of bySource) {
    if (list.length <= maxLive) continue
    const r = await distillAndDiscardAutoSource(projectPath, projectId, source, list, maxLive)
    results.push(r)
  }
  return {
    discarded: results.reduce((total, result) => total + result.discarded, 0),
    digests: results.filter((result) => result.digested).length,
  }
}

/**
 * Soft-deleted rows with no future value: hard-delete immediately when
 * already past grace, without re-summarizing (they were already judged
 * low-value by retention/forget). Optional mini-digest when batch is large.
 */
export function eliminateSoftDeletedNoValue(
  projectId: string,
  olderThanDays: number,
  maxRows: number = 1000
): { purged: number; digested: boolean } {
  const cutoff = Date.now() - olderThanDays * 86_400_000
  try {
    const rows = prjctDb.query<{ id: string; type: string; content: string }>(
      projectId,
      `SELECT id, type, content FROM memory_entries
       WHERE deleted_at IS NOT NULL AND deleted_at < ?
       ORDER BY deleted_at ASC
       LIMIT ?`,
      cutoff,
      maxRows
    )
    if (rows.length === 0) return { purged: 0, digested: false }

    // No statistical residue: hard delete. Digests already exist from
    // retention-distill when auto-source was the path; soft-deleted judgment
    // clones need no second essay.
    const n = hardDeleteEntries(
      projectId,
      rows.map((r) => r.id)
    )
    return { purged: n, digested: false }
  } catch {
    return { purged: 0, digested: false }
  }
}
