/**
 * `withBusyTimeout` — the per-async-context SQLite lock-wait budget.
 *
 * The driver is synchronous, so a contended write blocks the event loop for
 * the connection's busy_timeout. The daemon runs hooks under a short budget
 * so a cross-process writer can never freeze an agent turn for 5s; commands
 * keep the default. This pins: the pragma follows the context, propagates
 * across awaits, restores on exit, and a contended write fails fast.
 */

import { describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import prjctDb, {
  currentBusyTimeoutMs,
  DEFAULT_BUSY_TIMEOUT_MS,
  withBusyTimeout,
} from '../../storage/database'
import { openDatabase } from '../../storage/database/sqlite-compat'

function pragmaBusyTimeout(projectId: string): number {
  const row = prjctDb.query<{ timeout: number }>(projectId, 'PRAGMA busy_timeout')[0]
  return row?.timeout ?? -1
}

describe('withBusyTimeout', () => {
  test('the connection pragma follows the async context and restores the default on exit', async () => {
    const projectId = randomUUID()
    expect(currentBusyTimeoutMs()).toBe(DEFAULT_BUSY_TIMEOUT_MS)
    expect(pragmaBusyTimeout(projectId)).toBe(DEFAULT_BUSY_TIMEOUT_MS)

    const inside = await withBusyTimeout(75, async () => {
      const before = pragmaBusyTimeout(projectId)
      await new Promise((resolve) => setTimeout(resolve, 5))
      // Survives an await: the budget is bound to the async context, not to
      // the synchronous call frame.
      return { before, after: pragmaBusyTimeout(projectId), current: currentBusyTimeoutMs() }
    })
    expect(inside).toEqual({ before: 75, after: 75, current: 75 })

    expect(currentBusyTimeoutMs()).toBe(DEFAULT_BUSY_TIMEOUT_MS)
    expect(pragmaBusyTimeout(projectId)).toBe(DEFAULT_BUSY_TIMEOUT_MS)
    prjctDb.close(projectId)
  })

  test('a contended write under a short budget fails fast instead of waiting out the default', () => {
    const projectId = randomUUID()
    prjctDb.getDb(projectId)
    // A second connection to the same file holds the write lock, exactly
    // like a detached cold-path child or a CLI `remember` in another process.
    const holder = openDatabase(prjctDb.getDbPath(projectId))
    holder.run('BEGIN IMMEDIATE')
    try {
      const started = performance.now()
      expect(() =>
        withBusyTimeout(60, () =>
          prjctDb.run(
            projectId,
            'INSERT INTO kv_store (key, data, updated_at) VALUES (?, ?, ?)',
            'busy-probe',
            '{}',
            new Date().toISOString()
          )
        )
      ).toThrow()
      const elapsed = performance.now() - started
      expect(elapsed).toBeGreaterThanOrEqual(40)
      expect(elapsed).toBeLessThan(DEFAULT_BUSY_TIMEOUT_MS / 2)
    } finally {
      holder.run('ROLLBACK')
      holder.close()
      prjctDb.close(projectId)
    }
  })
})
