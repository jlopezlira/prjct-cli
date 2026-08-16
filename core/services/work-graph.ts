/**
 * The work graph — typed dependencies between work items, the ready frontier,
 * atomic claiming, topological phases, and the decomposition record.
 *
 * Harness research (2026-07, beads + Task Master + BMAD) converged on this as
 * the organ prjct lacked: agents should answer "what can I work on NOW" with
 * a ~10ms structural query, not by re-reading plans as prose. prjct's twist:
 * the frontier is served WITH the orchestration directive (model tier/effort/
 * ceremony) the triage engine already computes — none of the three have that.
 *
 * Item ids may reference queue_tasks (backlog) or tasks (work cycles):
 * blocking is resolved against whichever table knows the id. Edges are
 * beads-style typed:
 *   blocks          — gates readiness
 *   parent          — epic membership, gates readiness
 *   related         — informational only
 *   discovered-from — provenance ("found while working on X"); feeds the
 *                     scope-creep signal in velocity, never gates
 */

import { prjctDb } from '../storage/database'

export type DepType = 'blocks' | 'parent' | 'related' | 'discovered-from'
const GATING: DepType[] = ['blocks', 'parent']

export interface ReadyItem {
  id: string
  description: string
  type: string | null
  priority: string | null
  section: string | null
  claimedBy: string | null
  createdAt: string
  /** Open items this one gates (motivation: finishing it unblocks N others). */
  unblocks: number
}

interface ReadyItemRow {
  id: string
  description: string
  type: string | null
  priority: string | null
  section: string | null
  claimed_by: string | null
  created_at: string
}

/** Map a queue_tasks row to a `ReadyItem`. `unblocks` defaults to 0 for callers (like `allOpen`) that don't compute it. */
function rowToReadyItem(r: ReadyItemRow, unblocks = 0): ReadyItem {
  return {
    id: r.id,
    description: r.description,
    type: r.type,
    priority: r.priority,
    section: r.section,
    claimedBy: r.claimed_by,
    createdAt: r.created_at,
    unblocks,
  }
}

/** True when the referenced item is finished, whichever table owns it. */
const OPEN_BLOCKER_SQL = `
  SELECT d.from_id FROM work_dependencies d
  WHERE d.dep_type IN ('blocks', 'parent')
    AND (
      EXISTS (SELECT 1 FROM queue_tasks q WHERE q.id = d.to_id AND q.completed = 0)
      OR EXISTS (SELECT 1 FROM tasks t WHERE t.id = d.to_id
                 AND t.status NOT IN ('completed', 'shipped', 'cancelled'))
    )`

class WorkGraph {
  /**
   * Add a typed edge. Gating edges are cycle-checked (a blocks-cycle would
   * freeze the frontier forever); informational edges are not.
   */
  addDependency(projectId: string, fromId: string, toId: string, depType: DepType): void {
    if (fromId === toId) throw new Error('an item cannot depend on itself')
    if (GATING.includes(depType) && this.wouldCycle(projectId, fromId, toId)) {
      throw new Error(`dependency ${fromId} → ${toId} would create a blocking cycle`)
    }
    prjctDb.run(
      projectId,
      `INSERT OR IGNORE INTO work_dependencies (from_id, to_id, dep_type, created_at)
       VALUES (?, ?, ?, ?)`,
      fromId,
      toId,
      depType,
      new Date().toISOString()
    )
  }

  /** Would adding from→to close a gating cycle? (to already depends on from) */
  private wouldCycle(projectId: string, fromId: string, toId: string): boolean {
    const row = prjctDb.get<{ found: number }>(
      projectId,
      `WITH RECURSIVE chain(id) AS (
         SELECT ?
         UNION
         SELECT d.to_id FROM work_dependencies d JOIN chain c ON d.from_id = c.id
         WHERE d.dep_type IN ('blocks', 'parent')
       )
       SELECT 1 AS found FROM chain WHERE id = ? LIMIT 1`,
      toId,
      fromId
    )
    return row != null
  }

  /**
   * The ready frontier: open backlog items with zero open gating blockers,
   * ranked by how much they unblock, then priority, then age.
   */
  ready(projectId: string, opts?: { unclaimedOnly?: boolean; limit?: number }): ReadyItem[] {
    const rows = prjctDb.query<ReadyItemRow & { unblocks: number }>(
      projectId,
      `SELECT q.id, q.description, q.type, q.priority, q.section, q.claimed_by, q.created_at,
              (SELECT COUNT(*) FROM work_dependencies u
                WHERE u.to_id = q.id AND u.dep_type IN ('blocks', 'parent')) AS unblocks
       FROM queue_tasks q
       WHERE q.completed = 0
         AND q.id NOT IN (${OPEN_BLOCKER_SQL})
         ${opts?.unclaimedOnly ? 'AND q.claimed_by IS NULL' : ''}
       ORDER BY unblocks DESC,
                CASE q.priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END,
                q.created_at ASC
       LIMIT ?`,
      opts?.limit ?? 20
    )
    return rows.map((r) => rowToReadyItem(r, r.unblocks))
  }

  /** Deterministic "what now": top unclaimed item of the frontier. */
  next(projectId: string): ReadyItem | null {
    return this.ready(projectId, { unclaimedOnly: true, limit: 1 })[0] ?? null
  }

  /**
   * Race-free claim (beads' `--claim`): succeeds only if unclaimed. SQLite's
   * single-writer transaction makes the check-and-set atomic.
   */
  claim(projectId: string, taskId: string, claimant: string): boolean {
    prjctDb.run(
      projectId,
      `UPDATE queue_tasks SET claimed_by = ?, claimed_at = ?
       WHERE id = ? AND completed = 0 AND claimed_by IS NULL`,
      claimant,
      new Date().toISOString(),
      taskId
    )
    const row = prjctDb.get<{ claimed_by: string }>(
      projectId,
      'SELECT claimed_by FROM queue_tasks WHERE id = ?',
      taskId
    )
    return row?.claimed_by === claimant
  }

  release(projectId: string, taskId: string): void {
    prjctDb.run(
      projectId,
      'UPDATE queue_tasks SET claimed_by = NULL, claimed_at = NULL WHERE id = ?',
      taskId
    )
  }

  /**
   * Topological phases (Task Master "clusters"): phase(item) = 1 + max phase
   * of its open gating dependencies. Items in the same phase have no path
   * between them → safe to run in parallel. Only open items participate.
   */
  phases(projectId: string): Array<{ phase: number; items: ReadyItem[] }> {
    const rows = prjctDb.query<{ id: string; phase: number }>(
      projectId,
      `WITH RECURSIVE lvl(id, phase) AS (
         SELECT q.id, 1 FROM queue_tasks q
         WHERE q.completed = 0 AND q.id NOT IN (${OPEN_BLOCKER_SQL})
         UNION
         SELECT d.from_id, lvl.phase + 1
         FROM work_dependencies d
         JOIN lvl ON d.to_id = lvl.id
         JOIN queue_tasks q ON q.id = d.from_id AND q.completed = 0
         WHERE d.dep_type IN ('blocks', 'parent')
       )
       SELECT id, MAX(phase) AS phase FROM lvl GROUP BY id ORDER BY phase, id`
    )
    if (rows.length === 0) return []
    const byId = new Map(rows.map((r) => [r.id, r.phase]))
    const items = this.allOpen(projectId).filter((i) => byId.has(i.id))
    const grouped = new Map<number, ReadyItem[]>()
    for (const item of items) {
      const phase = byId.get(item.id) ?? 1
      const bucket = grouped.get(phase) ?? []
      bucket.push(item)
      grouped.set(phase, bucket)
    }
    return [...grouped.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([phase, its]) => ({ phase, items: its }))
  }

  private allOpen(projectId: string): ReadyItem[] {
    const rows = prjctDb.query<ReadyItemRow>(
      projectId,
      'SELECT id, description, type, priority, section, claimed_by, created_at FROM queue_tasks WHERE completed = 0'
    )
    return rows.map((r) => rowToReadyItem(r))
  }

  /** Persist the triage-time decomposition record (Task Master's report). */
  recordComplexity(
    projectId: string,
    taskId: string,
    rec: {
      score: number
      recommendedSubtasks: number
      expansionPrompt?: string
      reasoning?: string
    }
  ): void {
    prjctDb.run(
      projectId,
      `INSERT INTO task_complexity (task_id, score, recommended_subtasks, expansion_prompt, reasoning, created_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(task_id) DO UPDATE SET
         score = excluded.score,
         recommended_subtasks = excluded.recommended_subtasks,
         expansion_prompt = excluded.expansion_prompt,
         reasoning = excluded.reasoning`,
      taskId,
      rec.score,
      rec.recommendedSubtasks,
      rec.expansionPrompt ?? null,
      rec.reasoning ?? null,
      new Date().toISOString()
    )
  }

  getComplexity(
    projectId: string,
    taskId: string
  ): {
    score: number
    recommendedSubtasks: number
    expansionPrompt: string | null
    reasoning: string | null
  } | null {
    const r = prjctDb.get<{
      score: number
      recommended_subtasks: number
      expansion_prompt: string | null
      reasoning: string | null
    }>(projectId, 'SELECT * FROM task_complexity WHERE task_id = ?', taskId)
    return r
      ? {
          score: r.score,
          recommendedSubtasks: r.recommended_subtasks,
          expansionPrompt: r.expansion_prompt,
          reasoning: r.reasoning,
        }
      : null
  }

  /** Edges touching an item (for display + provenance). */
  dependenciesOf(
    projectId: string,
    itemId: string
  ): Array<{ fromId: string; toId: string; depType: DepType }> {
    return prjctDb
      .query<{ from_id: string; to_id: string; dep_type: DepType }>(
        projectId,
        'SELECT from_id, to_id, dep_type FROM work_dependencies WHERE from_id = ? OR to_id = ?',
        itemId,
        itemId
      )
      .map((r) => ({ fromId: r.from_id, toId: r.to_id, depType: r.dep_type }))
  }
}

export const workGraph = new WorkGraph()
