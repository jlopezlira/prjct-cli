/**
 * Shared "read persisted `events` rows, safe-parse each one, hand the
 * caller its tags" collector for hot-path detectors (`pattern-detector.ts`,
 * `lean-detector.ts`, `transcript-learner.ts`).
 *
 * Lazily requires the database module (not a top-level import) so
 * importing this file stays cheap on the Stop-hook's warm path — the
 * database only loads once a detector actually runs, matching the
 * lazy-require pattern every caller already used before this extraction.
 */

import type { SqliteBindings } from '../storage/database/sqlite-compat'
import { safeJsonParse } from '../utils/json'

interface PersistedEventRow {
  data: string
}

/**
 * Query `events` rows (`sql`/`params` select + order + limit — caller's
 * responsibility), safe-parse each row's `data` JSON blob, and hand rows
 * that carry a `tags` object to `onRow`. `onRow` returns the value to
 * accumulate, or `undefined` to skip the row. Best-effort: any DB or parse
 * failure returns whatever was collected so far (empty array if the
 * failure happened before the first successful row).
 */
export function collectFromPersistedEvents<T>(
  projectId: string,
  sql: string,
  params: SqliteBindings[],
  onRow: (tags: Record<string, unknown>, parsed: Record<string, unknown>) => T | undefined
): T[] {
  const out: T[] = []
  try {
    const { prjctDb } = require('../storage/database') as typeof import('../storage/database')
    const rows = prjctDb.query<PersistedEventRow>(projectId, sql, ...params)
    for (const row of rows) {
      const parsed = safeJsonParse<Record<string, unknown>>(row.data)
      if (!parsed || typeof parsed !== 'object') continue
      const tags = parsed.tags as Record<string, unknown> | undefined
      if (!tags) continue
      const value = onRow(tags, parsed)
      if (value !== undefined) out.push(value)
    }
  } catch {
    // Best-effort: DB/parse failures return whatever was collected so far.
  }
  return out
}
