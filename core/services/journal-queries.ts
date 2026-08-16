/**
 * Shared `task_log` journal queries used by receipt/synthesis builders
 * (`judgment-receipt.ts`, `land-synthesis.ts`).
 */

import { prjctDb } from '../storage/database'

/** Most recent task_log entries for a project (or a specific cycle), newest first. */
export function recentJournal(projectId: string, cycleId: string | null | undefined): string[] {
  try {
    if (cycleId) {
      return prjctDb
        .query<{ content: string }>(
          projectId,
          'SELECT content FROM task_log WHERE task_id = ? ORDER BY id DESC LIMIT 5',
          cycleId
        )
        .map((r) => r.content)
    }
    return prjctDb
      .query<{ content: string }>(
        projectId,
        'SELECT content FROM task_log ORDER BY id DESC LIMIT 5'
      )
      .map((r) => r.content)
  } catch {
    return []
  }
}
