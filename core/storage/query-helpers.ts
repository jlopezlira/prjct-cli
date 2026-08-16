/**
 * Thin `prjctDb` wrappers with try/catch → safe defaults (0 / []), shared by
 * every service that runs a simple scalar-count or read-only SQL query.
 */

import prjctDb from './database'
import type { SqliteBindings } from './database/sqlite-compat'

interface CountRow {
  value: number
}

export function count(projectId: string, sql: string, ...params: SqliteBindings[]): number {
  try {
    return Number(prjctDb.get<CountRow>(projectId, sql, ...params)?.value ?? 0)
  } catch {
    return 0
  }
}

export function query<T>(projectId: string, sql: string, ...params: SqliteBindings[]): T[] {
  try {
    return prjctDb.query<T>(projectId, sql, ...params)
  } catch {
    return []
  }
}
