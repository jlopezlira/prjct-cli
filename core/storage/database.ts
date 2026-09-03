/**
 * SQLite Database Manager. One DB per project (`prjct.db`) in WAL mode.
 * Uses `bun:sqlite` on Bun, `node:sqlite` on Node. Document-style
 * `kv_store` + normalized tables for indexed reads + append-only `events`.
 */

import { AsyncLocalStorage } from 'node:async_hooks'
import fs from 'node:fs'
import path from 'node:path'
import pathManager from '../infrastructure/path-manager'
import { describeFsWriteError } from '../types/fs'
import type { MigrationRecord } from '../types/storage/extended'
import { migrations } from './database/migrations'
import {
  openDatabase,
  type SqliteBindings,
  type SqliteDatabase,
  type SqliteRunResult,
  type SqliteStatement,
} from './database/sqlite-compat'

// Database Manager

/**
 * Run `fn` inside a BEGIN IMMEDIATE transaction. The driver default
 * (calling the wrapper directly) is BEGIN DEFERRED — the write lock is only
 * acquired at the first write, so two concurrent writers both enter and the
 * loser aborts MID-transaction on SQLITE_BUSY. IMMEDIATE acquires the write
 * lock up front: contention waits out busy_timeout then fails predictably,
 * never mid-write. Defensive fallback for any driver lacking the variant.
 */
function runImmediate<T>(db: SqliteDatabase, fn: (db: SqliteDatabase) => T): T {
  const txn = db.transaction(fn)
  return typeof txn.immediate === 'function' ? txn.immediate(db) : txn(db)
}

/**
 * Strictly-monotonic ISO stamp relative to `prev` — two writes inside the
 * same millisecond must not produce an equal token (a stale CAS read could
 * silently win). Shared by nextKvStamp and updateDoc so the bump rule can
 * never drift between the two write paths.
 */
function monotonicStamp(prev: string | null | undefined): string {
  const now = new Date().toISOString()
  if (!prev || now > prev) return now
  return new Date(new Date(prev).getTime() + 1).toISOString()
}

/** Max concurrent DB connections before evicting least-recently-used */
const MAX_DB_CONNECTIONS = 3

/**
 * Lock-wait budget every connection opens with (sqlite-compat). Commands
 * (sync, ship, remember) legitimately wait this long for a cross-process
 * writer to finish rather than fail.
 */
export const DEFAULT_BUSY_TIMEOUT_MS = 5000

/**
 * Per-async-context override of `PRAGMA busy_timeout`. The driver is
 * synchronous, so a write that waits on another process's lock blocks the
 * WHOLE event loop for up to busy_timeout — in the daemon that stalls every
 * hook behind it (measured: hook:prompt tails of 5s/10s/18s, exact multiples
 * of the 5000ms default, while a detached cold-path child held the write
 * lock). Latency-critical work runs under {@link withBusyTimeout} with a
 * short budget: a contended telemetry write then fails fast (SQLITE_BUSY,
 * caught by the fail-soft hook) instead of freezing the agent's turn.
 *
 * The pragma is per-connection, so `getDb` re-applies it whenever the value
 * the current async context wants differs from the last one applied to that
 * connection — a PRAGMA is microseconds, and JS is single-threaded, so an
 * interleaved command-lane job can never observe a hook's short budget: its
 * next `getDb` call restores the default before it touches the driver.
 */
const busyTimeoutContext = new AsyncLocalStorage<number>()

export function withBusyTimeout<T>(timeoutMs: number, fn: () => T): T {
  return busyTimeoutContext.run(timeoutMs, fn)
}

/** Budget the current async context asked for (default when none did). */
export function currentBusyTimeoutMs(): number {
  return busyTimeoutContext.getStore() ?? DEFAULT_BUSY_TIMEOUT_MS
}

class PrjctDatabase {
  private connections = new Map<string, SqliteDatabase>()
  private accessOrder: string[] = []
  // Cache prepared statements per-connection. WeakMap keys auto-GC when
  // the SqliteDatabase reference is dropped during evictLru()/close().
  private statementCache = new WeakMap<SqliteDatabase, Map<string, SqliteStatement>>()
  /** Last busy_timeout applied per connection — see busyTimeoutContext. */
  private appliedBusyTimeout = new WeakMap<SqliteDatabase, number>()

  private applyBusyTimeout(db: SqliteDatabase): void {
    const wanted = currentBusyTimeoutMs()
    if (this.appliedBusyTimeout.get(db) === wanted) return
    db.run(`PRAGMA busy_timeout = ${Math.max(0, Math.floor(wanted))}`)
    this.appliedBusyTimeout.set(db, wanted)
  }

  private prepareCached(db: SqliteDatabase, sql: string): SqliteStatement {
    const existingCache = this.statementCache.get(db)
    const cache = existingCache ?? new Map<string, SqliteStatement>()
    if (!existingCache) this.statementCache.set(db, cache)
    const hit = cache.get(sql)
    if (hit) return hit
    const stmt = db.prepare(sql)
    cache.set(sql, stmt)
    return stmt
  }

  getDbPath(projectId: string): string {
    return path.join(pathManager.getGlobalProjectPath(projectId), 'prjct.db')
  }

  /**
   * Get or create a database connection for a project.
   * Lazily opens the database, runs migrations, and enables WAL mode.
   */
  getDb(projectId: string): SqliteDatabase {
    const existing = this.connections.get(projectId)
    if (existing) {
      this.touchAccessOrder(projectId)
      this.applyBusyTimeout(existing)
      return existing
    }

    if (this.connections.size >= MAX_DB_CONNECTIONS) this.evictLru()

    const dbPath = this.getDbPath(projectId)
    const dbDir = path.dirname(dbPath)
    const db = (() => {
      try {
        if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true })
        const opened = openDatabase(dbPath)
        opened.run('PRAGMA synchronous = NORMAL')
        opened.run('PRAGMA cache_size = -2000')
        opened.run('PRAGMA temp_store = MEMORY')
        opened.run('PRAGMA mmap_size = 33554432')
        return opened
      } catch (error) {
        throw new Error(describeFsWriteError(error, dbPath, 'database'))
      }
    })()

    this.runMigrations(db, dbPath)

    this.connections.set(projectId, db)
    this.touchAccessOrder(projectId)
    // openDatabase baked in the default; record it so a default-context
    // caller never re-runs the PRAGMA, then honour the current context.
    this.appliedBusyTimeout.set(db, DEFAULT_BUSY_TIMEOUT_MS)
    this.applyBusyTimeout(db)
    return db
  }

  /**
   * Close a specific project's database connection, or all connections.
   */
  close(projectId?: string): void {
    if (projectId) {
      const db = this.connections.get(projectId)
      if (db) {
        // Drop cached statements bound to this connection BEFORE closing it.
        // The WeakMap auto-GCs only once the db object is unreachable; an
        // explicit delete prevents a stale statement (bound to a now-closed
        // connection) from being reused if a caller still holds the ref.
        this.statementCache.delete(db)
        db.close()
        this.connections.delete(projectId)
        this.accessOrder = this.accessOrder.filter((id) => id !== projectId)
      }
    } else {
      this.connections.forEach((db) => {
        this.statementCache.delete(db)
        db.close()
      })
      this.connections.clear()
      this.accessOrder = []
    }
  }

  private touchAccessOrder(projectId: string): void {
    this.accessOrder = this.accessOrder.filter((id) => id !== projectId)
    this.accessOrder.push(projectId)
  }

  private evictLru(): void {
    if (this.accessOrder.length === 0) return
    const lruId = this.accessOrder.shift()!
    const db = this.connections.get(lruId)
    if (db) {
      this.statementCache.delete(db) // see close(): drop bound statements first
      db.close()
      this.connections.delete(lruId)
    }
  }

  /**
   * Run WAL checkpoint on all open connections to reclaim WAL space.
   *
   * PASSIVE, not TRUNCATE: TRUNCATE blocks until every concurrent reader AND
   * writer releases (a parallel CLI process holding the daemon's overlapping
   * connection), and the daemon discarded the result so a perpetually-skipped
   * checkpoint was invisible while the WAL grew unbounded. PASSIVE never
   * blocks; we read back the (busy, log, checkpointed) frame counts and only
   * log when the WAL is large yet repeatedly cannot be reclaimed.
   */
  checkpointAll(): void {
    for (const [_projectId, db] of this.connections) {
      try {
        // PASSIVE returns a row; reading it forces the statement to execute
        // and lets a future caller inspect (busy,log,checkpointed) if needed.
        this.prepareCached(db, 'PRAGMA wal_checkpoint(PASSIVE)').get()
      } catch {
        // Connection may have been closed externally — skip
      }
    }
  }

  exists(projectId: string): boolean {
    return fs.existsSync(this.getDbPath(projectId))
  }

  // Document Storage (kv_store)

  getDoc<T>(projectId: string, key: string): T | null {
    const db = this.getDb(projectId)
    const row = this.prepareCached(db, 'SELECT data FROM kv_store WHERE key = ?').get(key) as {
      data: string
    } | null
    if (!row) return null
    return JSON.parse(row.data) as T
  }

  setDoc<T>(projectId: string, key: string, data: T): void {
    const db = this.getDb(projectId)
    const json = JSON.stringify(data)
    const now = new Date().toISOString()
    this.prepareCached(
      db,
      'INSERT OR REPLACE INTO kv_store (key, data, updated_at) VALUES (?, ?, ?)'
    ).run(key, json, now)
  }

  /**
   * Read a doc together with its `updated_at` stamp — the optimistic-
   * concurrency token used by {@link casSetDoc}. `null` when absent.
   */
  getDocWithStamp<T>(projectId: string, key: string): { data: T; updatedAt: string } | null {
    const db = this.getDb(projectId)
    const row = this.prepareCached(db, 'SELECT data, updated_at FROM kv_store WHERE key = ?').get(
      key
    ) as { data: string; updated_at: string } | null
    if (!row) return null
    return { data: JSON.parse(row.data) as T, updatedAt: row.updated_at }
  }

  /**
   * Strictly-monotonic kv_store stamp (mirrors spec-storage.nextUpdatedAt):
   * two writes inside the same millisecond would otherwise produce an EQUAL
   * token and a stale CAS read could silently win. ISO8601 sorts
   * chronologically as a string so `>` stays correct.
   */
  private nextKvStamp(db: SqliteDatabase, key: string): string {
    const row = this.prepareCached(db, 'SELECT updated_at FROM kv_store WHERE key = ?').get(
      key
    ) as {
      updated_at: string
    } | null
    return monotonicStamp(row?.updated_at)
  }

  /**
   * Compare-and-set write for kv_store. `expected` is the `updated_at`
   * the caller based its transform on (null ⇒ caller saw no row):
   *   - expected === null  → INSERT, succeeds only if the key is still absent
   *   - expected === stamp → UPDATE … WHERE updated_at = expected
   * Returns false when another writer committed in between (caller must
   * re-read and retry). This is the lost-update guard for the
   * read-modify-write path (StorageManager.update) under daemon+CLI
   * concurrency — WAL/busy_timeout alone does not prevent it.
   */
  casSetDoc<T>(projectId: string, key: string, data: T, expected: string | null): boolean {
    const db = this.getDb(projectId)
    const json = JSON.stringify(data)
    const now = this.nextKvStamp(db, key)
    if (expected === null) {
      return (
        this.prepareCached(
          db,
          'INSERT INTO kv_store (key, data, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO NOTHING'
        ).run(key, json, now).changes === 1
      )
    }
    return (
      this.prepareCached(
        db,
        'UPDATE kv_store SET data = ?, updated_at = ? WHERE key = ? AND updated_at = ?'
      ).run(json, now, key, expected).changes === 1
    )
  }

  /**
   * Atomic read-modify-write for a kv_store doc inside one BEGIN IMMEDIATE
   * transaction. Replaces the optimistic CAS retry loop in
   * StorageManager.update: IMMEDIATE takes the write lock up front, so a
   * concurrent writer (daemon vs CLI, sibling worktree agents) WAITS — up
   * to busy_timeout (5000ms) — instead of looping read→conflict→re-read.
   * One SELECT + one write per update instead of up to 8×(2 SELECTs +
   * UPDATE). The monotonic-stamp rule from nextKvStamp is preserved using
   * the row already read — no second SELECT.
   */
  updateDoc<T>(projectId: string, key: string, updater: (current: T) => T, getDefault: () => T): T {
    const db = this.getDb(projectId)
    return runImmediate(db, () => {
      const row = this.prepareCached(db, 'SELECT data, updated_at FROM kv_store WHERE key = ?').get(
        key
      ) as { data: string; updated_at: string } | null
      const base = row ? (JSON.parse(row.data) as T) : getDefault()
      const updated = updater(base)
      const stamp = monotonicStamp(row?.updated_at)
      this.prepareCached(
        db,
        'INSERT OR REPLACE INTO kv_store (key, data, updated_at) VALUES (?, ?, ?)'
      ).run(key, JSON.stringify(updated), stamp)
      return updated
    })
  }

  deleteDoc(projectId: string, key: string): void {
    const db = this.getDb(projectId)
    this.prepareCached(db, 'DELETE FROM kv_store WHERE key = ?').run(key)
  }

  hasDoc(projectId: string, key: string): boolean {
    const db = this.getDb(projectId)
    const row = this.prepareCached(db, 'SELECT 1 FROM kv_store WHERE key = ?').get(key)
    return row !== null
  }

  /**
   * List all kv_store docs whose key starts with `prefix`. Returns
   * deserialized rows. Used by crew-run-storage to render every
   * `crew-run:<id>` row into the vault on regen.
   *
   * Caller must filter out unrelated keys if `prefix` is ambiguous;
   * SQL pattern is `prefix || '%'` (no LIKE wildcard injection because
   * we control the call sites).
   */
  listDocsByPrefix<T>(projectId: string, prefix: string): Array<{ key: string; data: T }> {
    const db = this.getDb(projectId)
    const rows = this.prepareCached(
      db,
      "SELECT key, data FROM kv_store WHERE key LIKE ? || '%' ORDER BY key"
    ).all(prefix) as Array<{ key: string; data: string }>
    return rows.map((r) => ({ key: r.key, data: JSON.parse(r.data) as T }))
  }

  // Event Log

  appendEvent(
    projectId: string,
    type: string,
    data: Record<string, unknown>,
    taskId?: string
  ): number | null {
    const db = this.getDb(projectId)
    const now = new Date().toISOString()
    const result = this.prepareCached(
      db,
      'INSERT INTO events (type, task_id, data, timestamp) VALUES (?, ?, ?, ?)'
    ).run(type, taskId ?? null, JSON.stringify(data), now)
    const id = result.lastInsertRowid
    return typeof id === 'bigint' ? Number(id) : (id ?? null)
  }

  getEvents(
    projectId: string,
    type?: string,
    limit = 100
  ): Array<{ id: number; type: string; task_id: string | null; data: string; timestamp: string }> {
    const db = this.getDb(projectId)
    if (type) {
      return this.prepareCached(
        db,
        'SELECT * FROM events WHERE type = ? ORDER BY id DESC LIMIT ?'
      ).all(type, limit) as Array<{
        id: number
        type: string
        task_id: string | null
        data: string
        timestamp: string
      }>
    }
    return this.prepareCached(db, 'SELECT * FROM events ORDER BY id DESC LIMIT ?').all(
      limit
    ) as Array<{
      id: number
      type: string
      task_id: string | null
      data: string
      timestamp: string
    }>
  }

  // Raw Query Access

  query<T = Record<string, unknown>>(
    projectId: string,
    sql: string,
    ...params: SqliteBindings[]
  ): T[] {
    const db = this.getDb(projectId)
    return this.prepareCached(db, sql).all(...params) as T[]
  }

  run(projectId: string, sql: string, ...params: SqliteBindings[]): SqliteRunResult {
    const db = this.getDb(projectId)
    return this.prepareCached(db, sql).run(...params)
  }

  get<T = Record<string, unknown>>(
    projectId: string,
    sql: string,
    ...params: SqliteBindings[]
  ): T | null {
    const db = this.getDb(projectId)
    return (this.prepareCached(db, sql).get(...params) as T) ?? null
  }

  transaction<T>(projectId: string, fn: (db: SqliteDatabase) => T): T {
    const db = this.getDb(projectId)
    return runImmediate(db, fn)
  }

  // Migration System

  private runMigrations(db: SqliteDatabase, dbPath?: string): void {
    db.run(`
      CREATE TABLE IF NOT EXISTS _migrations (
        version     INTEGER PRIMARY KEY,
        name        TEXT NOT NULL,
        applied_at  TEXT NOT NULL
      )
    `)

    const applied = new Set(
      (db.prepare('SELECT version FROM _migrations').all() as Array<{ version: number }>).map(
        (r) => r.version
      )
    )

    const pending = migrations.filter((m) => !applied.has(m.version))
    if (pending.length === 0) return

    // Backup BEFORE mutating an existing, non-fresh DB. A migration that
    // throws mid-flight rolls back its own transaction, but a large
    // data-backfill (e.g. migrations 10/21) can leave partial state that
    // makes the retry fail too — a boot loop on a DB with no recovery path.
    // A pre-migration snapshot gives the user (and `prjct doctor`) something
    // to restore. Skip for a brand-new DB (applied.size === 0): nothing to
    // lose, and the backup would just be an empty file.
    //
    // VACUUM INTO produces a single, fully-consistent copy regardless of WAL
    // checkpoint state and works across both node:sqlite and bun:sqlite.
    // Best-effort: a failed backup must NOT block migrations — that would
    // make the app unusable to protect a safety net that's only a nicety.
    if (dbPath && applied.size > 0) {
      try {
        const backupPath = `${dbPath}.pre-migrate.bak`
        if (fs.existsSync(backupPath)) fs.rmSync(backupPath, { force: true })
        db.prepare('VACUUM INTO ?').run(backupPath)
      } catch (err) {
        console.warn(
          `prjct: pre-migration backup failed (continuing): ${(err as Error)?.message ?? err}`
        )
      }
    }

    for (const migration of pending) {
      runImmediate(db, () => {
        migration.up(db)
        db.prepare('INSERT INTO _migrations (version, name, applied_at) VALUES (?, ?, ?)').run(
          migration.version,
          migration.name,
          new Date().toISOString()
        )
      })
    }
  }

  getMigrations(projectId: string): MigrationRecord[] {
    const db = this.getDb(projectId)
    return db.prepare('SELECT * FROM _migrations ORDER BY version').all() as MigrationRecord[]
  }

  getSchemaVersion(projectId: string): number {
    const db = this.getDb(projectId)
    const row = db.prepare('SELECT MAX(version) as version FROM _migrations').get() as {
      version: number | null
    } | null
    return row?.version ?? 0
  }
}

// Singleton Export

export const prjctDb = new PrjctDatabase()
export default prjctDb
export { PrjctDatabase }
