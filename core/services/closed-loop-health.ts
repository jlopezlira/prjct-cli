/**
 * Closed-loop health line for harness score / insights — receipts + conflicts.
 * Existing verb surfaces only (no new CLI family).
 */

import { prjctDb } from '../storage/database'
import { countConflictEvents } from './decision-conflict'
import { countReceiptsWritten } from './judgment-receipt'

export interface ClosedLoopHealth {
  receipts7d: number
  conflictWarns7d: number
  conflictDenies7d: number
  preventiveSurfaces7d: number
  /** One scannable line for harness/insights. */
  line: string
}

export function buildClosedLoopHealth(projectId: string): ClosedLoopHealth {
  const since = Date.now() - 7 * 24 * 60 * 60 * 1000
  const receipts7d = countReceiptsWritten(projectId, since)
  const conflictWarns7d = countConflictEvents(projectId, 'warn', since)
  const conflictDenies7d = countConflictEvents(projectId, 'deny', since)
  const preventiveSurfaces7d = (() => {
    try {
      return (
        prjctDb.get<{ c: number }>(
          projectId,
          `SELECT COUNT(*) AS c FROM memory_entries
           WHERE deleted_at IS NULL
             AND created_at >= ?
             AND type IN ('gotcha', 'anti-pattern', 'decision')`,
          since
        )?.c ?? 0
      )
    } catch {
      return 0
    }
  })()

  const line = `Closed-loop judgment (7d): receipts=${receipts7d} · conflict warn/deny=${conflictWarns7d}/${conflictDenies7d} · preventive memories=${preventiveSurfaces7d}`
  return {
    receipts7d,
    conflictWarns7d,
    conflictDenies7d,
    preventiveSurfaces7d,
    line,
  }
}
