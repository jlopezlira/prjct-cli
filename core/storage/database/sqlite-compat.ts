/**
 * SQLite Compatibility Layer (bun:sqlite + node:sqlite)
 *
 * prjct ships ZERO native dependencies. Both supported runtimes provide a
 * built-in synchronous SQLite driver:
 *   - Bun  → `bun:sqlite`   (always present in the Bun runtime)
 *   - Node → `node:sqlite`  (built in since Node 22.5; behind
 *                            `--experimental-sqlite` on 22.5–23.x, unflagged on
 *                            24+). The `bin/prjct` launcher exports that flag so
 *                            the CLI, daemon, and hooks all have it on Node 22.x.
 *
 * Neither needs compilation, a postinstall step, or `node-gyp` — which is
 * exactly why we dropped `better-sqlite3`: a native addon means a postinstall
 * rebuild, and postinstall scripts are a supply-chain liability (blocked by
 * `--ignore-scripts`, npm/corporate policy, locked-down CI). See
 * [[decision_drop_better_sqlite3]].
 *
 * The two built-in drivers share most of their surface. The only real gap is
 * `Database.transaction()`: bun:sqlite has it, node:sqlite does NOT — so we
 * shim it for the Node path (BEGIN/COMMIT/ROLLBACK with SAVEPOINT nesting and
 * the `.deferred`/`.immediate`/`.exclusive` variants better-sqlite3 callers
 * relied on).
 */

import { isBun } from '../../utils/runtime'

/** Bind parameter types accepted by both drivers */
export type SqliteBindings = string | number | bigint | Buffer | null | undefined

/**
 * Result of executing a prepared statement that mutates rows.
 * Both bun:sqlite and node:sqlite return this shape natively from
 * `Statement.run(...)`. Required by the optimistic-CAS path in spec-storage
 * (`UPDATE … WHERE updated_at=?` only succeeds when `changes === 1`).
 */
export interface SqliteRunResult {
  changes: number
  /**
   * Both bun:sqlite and node:sqlite expose the rowid of an `INSERT` here —
   * bun returns `number`, node returns `number` (or `bigint` for values past
   * 2^53). Callers needing it should normalize via `Number(...)` and tolerate
   * `undefined` for non-INSERT statements.
   */
  lastInsertRowid?: number | bigint
}

/** Minimal prepared-statement interface shared by both drivers */
export interface SqliteStatement {
  get(...params: SqliteBindings[]): unknown
  all(...params: SqliteBindings[]): unknown[]
  run(...params: SqliteBindings[]): SqliteRunResult
}

/**
 * A transaction wrapper. Both bun:sqlite and the node:sqlite shim return a
 * callable that ALSO carries `.deferred`/`.immediate`/`.exclusive` variants.
 * Default (calling it directly) is DEFERRED — the write lock is only taken at
 * the first write, so two concurrent writers can both enter and then collide,
 * aborting one MID-transaction on SQLITE_BUSY. `.immediate` takes the write
 * lock up front: contention fails fast/predictably (or waits out
 * busy_timeout), never mid-write.
 */
export interface SqliteTransaction<T> {
  (...args: SqliteDatabase[]): T
  deferred: (...args: SqliteDatabase[]) => T
  immediate: (...args: SqliteDatabase[]) => T
  exclusive: (...args: SqliteDatabase[]) => T
}

/** Minimal database interface shared by bun:sqlite and node:sqlite */
export interface SqliteDatabase {
  prepare(sql: string): SqliteStatement
  run(sql: string): void
  close(): void
  transaction<T>(fn: (...args: SqliteDatabase[]) => T): SqliteTransaction<T>
}

/**
 * Open a SQLite database using the runtime-appropriate built-in driver.
 * bun:sqlite on Bun, node:sqlite on Node.js.
 *
 * Every connection is opened with the correctness PRAGMAs baked in:
 *   - journal_mode = WAL       — concurrent reads + single writer
 *   - busy_timeout = 5000      — wait on lock contention instead of hanging
 *                                silently when the daemon holds an overlapping
 *                                connection (see [[gotcha_sync_hang]])
 *
 * Performance-tuning PRAGMAs (synchronous, cache_size, mmap_size, …) remain
 * the caller's responsibility — they differ per database (per-project vs
 * system) and aren't correctness-critical.
 */
export function openDatabase(dbPath: string): SqliteDatabase {
  const db = openRaw(dbPath)
  db.run('PRAGMA journal_mode = WAL')
  db.run('PRAGMA busy_timeout = 5000')
  return db
}

function openRaw(dbPath: string): SqliteDatabase {
  if (isBun()) {
    const { Database } = require('bun:sqlite')
    return new Database(dbPath, { create: true }) as SqliteDatabase
  }
  // node:sqlite — built into Node, no native addon, no postinstall.
  const DatabaseSync = (() => {
    try {
      return (require('node:sqlite') as { DatabaseSync: new (path: string) => NodeSqliteDatabase })
        .DatabaseSync
    } catch (err) {
      // Node < 22.5 (no node:sqlite at all), or 22.5–23.x launched WITHOUT
      // `--experimental-sqlite`. The bin/prjct shim sets that flag; a bare
      // `node dist/bin/prjct.mjs` won't. Fail with an actionable message
      // instead of a cryptic ERR_UNKNOWN_BUILTIN_MODULE.
      throw new Error(
        'prjct needs SQLite: run on Bun, or Node >=22.5 with --experimental-sqlite ' +
          '(the `prjct` launcher sets this automatically — invoke `prjct`, not ' +
          `\`node dist/bin/prjct.mjs\` directly). Underlying error: ${
            err instanceof Error ? err.message : String(err)
          }`
      )
    }
  })()
  const raw = new DatabaseSync(dbPath)
  return adaptNodeSqlite(raw)
}

/**
 * Wrap a node:sqlite `DatabaseSync` in the runtime-agnostic interface.
 * `prepare`/`get`/`all`/`run` map straight through (node:sqlite's
 * `StatementSync` already returns `{ changes, lastInsertRowid }` from `run`).
 * Raw SQL uses `exec`. The only thing we synthesize is `transaction`.
 */
function adaptNodeSqlite(raw: NodeSqliteDatabase): SqliteDatabase {
  // Per-connection transaction state (node:sqlite exposes none of its own).
  const transactionState = { depth: 0, savepointSequence: 0 }

  const wrapper: SqliteDatabase = {
    prepare: (sql: string) => raw.prepare(sql) as unknown as SqliteStatement,
    run: (sql: string) => {
      raw.exec(sql)
    },
    close: () => raw.close(),
    transaction: <T>(fn: (...args: SqliteDatabase[]) => T): SqliteTransaction<T> => {
      // One runner per BEGIN mode. Nesting an active transaction switches to a
      // SAVEPOINT (mirrors better-sqlite3) so callers can compose freely.
      const make =
        (begin: string) =>
        (...args: SqliteDatabase[]): T => {
          if (transactionState.depth > 0) {
            transactionState.savepointSequence++
            const sp = `prjct_sp_${transactionState.savepointSequence}`
            raw.exec(`SAVEPOINT ${sp}`)
            transactionState.depth++
            try {
              const result = fn(...(args.length ? args : [wrapper]))
              raw.exec(`RELEASE ${sp}`)
              return result
            } catch (err) {
              raw.exec(`ROLLBACK TO ${sp}`)
              raw.exec(`RELEASE ${sp}`)
              throw err
            } finally {
              transactionState.depth--
            }
          }
          raw.exec(begin)
          transactionState.depth++
          try {
            const result = fn(...(args.length ? args : [wrapper]))
            raw.exec('COMMIT')
            return result
          } catch (err) {
            raw.exec('ROLLBACK')
            throw err
          } finally {
            transactionState.depth--
          }
        }

      // Default call == DEFERRED (driver default), matching better-sqlite3.
      const txn = make('BEGIN') as SqliteTransaction<T>
      txn.deferred = make('BEGIN DEFERRED')
      txn.immediate = make('BEGIN IMMEDIATE')
      txn.exclusive = make('BEGIN EXCLUSIVE')
      return txn
    },
  }

  return wrapper
}

/** Minimal shape of node:sqlite's `DatabaseSync` we depend on. */
interface NodeSqliteDatabase {
  prepare(sql: string): unknown
  exec(sql: string): void
  close(): void
}
