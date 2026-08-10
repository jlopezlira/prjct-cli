/**
 * Repair under-recorded reliability signals from existing tables.
 * Does not invent work — only mirrors token_usage → tasks and credits
 * usefulness for memories that were already surfaced.
 */

import prjctDb from '../storage/database'
import { usefulnessService } from './usefulness'

export interface ReliabilityRepairReport {
  tokensMirrored: number
  usefulnessCredited: number
}

/**
 * Mirror token_usage totals onto tasks missing tokens_in/out, and credit
 * fetch usefulness for surface_log rows whose memory has no usefulness yet.
 */
export function repairReliabilitySignals(projectId: string, days = 30): ReliabilityRepairReport {
  const sinceMs = Date.now() - days * 24 * 60 * 60 * 1000
  const sinceIso = new Date(sinceMs).toISOString()
  const mirroredTaskIds: string[] = []
  const creditedMemoryIds: string[] = []

  try {
    const rows = prjctDb.query<{
      work_cycle_id: string
      t_in: number
      t_out: number
    }>(
      projectId,
      `SELECT work_cycle_id,
              SUM(input_tokens) AS t_in,
              SUM(output_tokens) AS t_out
       FROM token_usage
       WHERE measured_at >= ? AND work_cycle_id IS NOT NULL
       GROUP BY work_cycle_id`,
      sinceMs
    )
    for (const r of rows) {
      if (!r.work_cycle_id || r.t_in + r.t_out <= 0) continue
      try {
        prjctDb.run(
          projectId,
          `UPDATE tasks
           SET tokens_in = CASE WHEN COALESCE(tokens_in, 0) = 0 THEN ? ELSE tokens_in END,
               tokens_out = CASE WHEN COALESCE(tokens_out, 0) = 0 THEN ? ELSE tokens_out END
           WHERE id = ?
             AND COALESCE(tokens_in, 0) + COALESCE(tokens_out, 0) = 0`,
          r.t_in,
          r.t_out,
          r.work_cycle_id
        )
        mirroredTaskIds.push(r.work_cycle_id)
      } catch {
        /* best-effort */
      }
    }
  } catch {
    /* older schemas */
  }

  try {
    // Surface without usefulness: the memory was shown and is still uncredited.
    const orphaned = prjctDb.query<{ memory_id: string }>(
      projectId,
      `SELECT DISTINCT s.memory_id AS memory_id
       FROM memory_surface_log s
       LEFT JOIN memory_usefulness u ON u.memory_id = s.memory_id
       WHERE s.created_at >= ?
         AND (u.memory_id IS NULL OR u.score <= 0 OR u.last_used_at IS NULL OR u.last_used_at < ?)`,
      sinceIso,
      sinceIso
    )
    const nowIso = new Date().toISOString()
    for (const row of orphaned) {
      if (!row.memory_id) continue
      usefulnessService.recordFetch(projectId, row.memory_id, nowIso)
      creditedMemoryIds.push(row.memory_id)
    }
  } catch {
    /* best-effort */
  }

  return {
    tokensMirrored: mirroredTaskIds.length,
    usefulnessCredited: creditedMemoryIds.length,
  }
}
