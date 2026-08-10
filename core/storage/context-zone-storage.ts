/**
 * Context Zone Storage
 *
 * Persists zone transitions and compaction events for context health analytics.
 * Used by the dashboard to show zone distribution and compaction frequency.
 */

import type { ContextZone, ZoneTransition } from '../types/agentic/templates-orchestration'
import { prjctDb } from './database'

/** Validate a stored zone string against the union, defaulting to 'smart'. */
const CONTEXT_ZONES: ReadonlyArray<ContextZone> = ['smart', 'warning', 'dumb']
function toZone(value: string): ContextZone {
  return (CONTEXT_ZONES as readonly string[]).includes(value) ? (value as ContextZone) : 'smart'
}

// Types

interface ZoneEventRow {
  id: number
  project_id: string
  session_id: string | null
  zone_from: string
  zone_to: string
  usage_percent: number
  action: string | null
  timestamp: string
}

interface ContextHealthSummary {
  smartPercent: number
  warningPercent: number
  dumbPercent: number
  compactions: number
}

// Context Zone Storage

class ContextZoneStorage {
  /**
   * Record a zone transition event.
   */
  recordTransition(projectId: string, transition: ZoneTransition, sessionId?: string): void {
    prjctDb.run(
      projectId,
      `INSERT INTO context_zone_events (project_id, session_id, zone_from, zone_to, usage_percent, action, timestamp)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      projectId,
      sessionId ?? null,
      transition.from,
      transition.to,
      transition.usagePercent,
      transition.action ?? null,
      transition.timestamp
    )
  }

  /**
   * Record a compaction event.
   */
  recordCompaction(
    projectId: string,
    format: string,
    originalTurns: number,
    filesCount: number
  ): void {
    prjctDb.run(
      projectId,
      `INSERT INTO context_compactions (project_id, format, original_turns, files_count, timestamp)
       VALUES (?, ?, ?, ?, ?)`,
      projectId,
      format,
      originalTurns,
      filesCount,
      new Date().toISOString()
    )
  }

  /**
   * Get recent zone transitions.
   */
  getTransitions(projectId: string, limit = 20): ZoneTransition[] {
    const rows = prjctDb.query<ZoneEventRow>(
      projectId,
      'SELECT * FROM context_zone_events WHERE project_id = ? ORDER BY id DESC LIMIT ?',
      projectId,
      limit
    )

    return rows.map((row) => ({
      from: toZone(row.zone_from),
      to: toZone(row.zone_to),
      usagePercent: row.usage_percent,
      timestamp: row.timestamp,
      action: row.action,
    }))
  }

  /**
   * Get context health summary for a time period.
   * Returns zone distribution percentages and compaction count.
   */
  getSummary(projectId: string, days = 7): ContextHealthSummary {
    const since = new Date(Date.now() - days * 86400000).toISOString()

    // Count transitions per target zone
    const transitions = prjctDb.query<{ zone_to: string; cnt: number }>(
      projectId,
      `SELECT zone_to, COUNT(*) as cnt FROM context_zone_events
       WHERE project_id = ? AND timestamp >= ?
       GROUP BY zone_to`,
      projectId,
      since
    )

    const counts: Record<string, number> = { smart: 0, warning: 0, dumb: 0 }
    for (const row of transitions) {
      counts[row.zone_to] = row.cnt
    }
    const total = transitions.reduce((sum, row) => sum + row.cnt, 0)

    // Count compactions
    const compactionRows = prjctDb.query<{ cnt: number }>(
      projectId,
      `SELECT COUNT(*) as cnt FROM context_compactions
       WHERE project_id = ? AND timestamp >= ?`,
      projectId,
      since
    )
    const compactions = compactionRows[0]?.cnt ?? 0

    if (total === 0) {
      return { smartPercent: 100, warningPercent: 0, dumbPercent: 0, compactions }
    }

    return {
      smartPercent: Math.round((counts.smart / total) * 100),
      warningPercent: Math.round((counts.warning / total) * 100),
      dumbPercent: Math.round((counts.dumb / total) * 100),
      compactions,
    }
  }
}

// Singleton Export

export const contextZoneStorage = new ContextZoneStorage()
export { ContextZoneStorage }
