/**
 * Spec Storage — SQLite-direct CRUD for the `specs` table (migration 16).
 *
 * Same shape as `custom-workflow-storage.ts`: thin domain methods over
 * `prjctDb.run/query/get`, no abstraction layer. Service layer
 * (`spec-service`) handles validation + side effects (vault render).
 */

import { generateUUID } from '../schemas/schemas'
import { publishCRUDSync } from '../sync/publish-helper'
import {
  SPEC_STATUSES,
  type Spec,
  type SpecContent,
  SpecContentSchema,
  type SpecStatus,
} from '../types/spec'
import { getTimestamp } from '../utils/date-helper'
import prjctDb from './database'
import type { SqliteBindings } from './database/sqlite-compat'

interface SpecRow {
  id: string
  title: string
  status: string
  content: string
  tags: string | null
  created_at: string
  updated_at: string
  shipped_at: string | null
  shipped_pr: number | null
  shipped_sha: string | null
  archived_at: string | null
}

/**
 * Schema v2 (C6): project a spec's list fields into the normalized child tables
 * so the spec — and its gate (selected reviewers + verdicts) — is queryable as
 * relational records, not only a JSON blob. Clears + reinserts (content fully
 * replaces on each write). The `specs.content` blob is retained for the typed
 * full-object readers until they cut over.
 */
function projectSpecRelational(projectId: string, id: string, content: SpecContent): void {
  try {
    // Only the GATE state is projected relationally (spec_review +
    // spec_selected_reviewer) — that's the one consumer (reviewsGatePassedRelational).
    // The rest of the spec (criteria/scope/risks/test_plan/links/tags) stays in
    // the specs.content aggregate blob, which is the sync aggregate root and the
    // read source of truth. No redundant write-only child tables.
    prjctDb.run(projectId, 'DELETE FROM spec_review WHERE spec_id = ?', id)
    prjctDb.run(projectId, 'DELETE FROM spec_selected_reviewer WHERE spec_id = ?', id)
    for (const [lens, review] of Object.entries(content.reviews ?? {})) {
      prjctDb.run(
        projectId,
        'INSERT INTO spec_review (id, spec_id, lens, verdict, notes, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        `${id}-rev-${lens}`,
        id,
        lens,
        review.verdict,
        review.notes ?? null,
        Date.now()
      )
    }
    for (const lens of content.selected_reviewers) {
      prjctDb.run(
        projectId,
        'INSERT OR IGNORE INTO spec_selected_reviewer (spec_id, lens) VALUES (?, ?)',
        id,
        lens
      )
    }
  } catch {
    // Best-effort projection — the content blob stays the source of truth.
  }
}

class SpecStorage {
  /**
   * Strictly-monotonic `updated_at` for a spec row.
   *
   * `updated_at` doubles as the optimistic-concurrency token in
   * `casUpdate`. `getTimestamp()` is ISO8601 millisecond precision, so
   * two writes to the same row inside one millisecond would produce an
   * EQUAL token — a stale CAS read (`WHERE updated_at = <oldToken>`)
   * would still match and silently succeed (last-write-wins; the
   * conflict goes undetected). Forcing the new stamp strictly greater
   * than the row's current one closes that sub-millisecond hole without
   * a schema change. ISO8601 sorts chronologically as a string, so the
   * `>` comparison and the `< vs >` SQL CAS stay correct.
   */
  private nextUpdatedAt(projectId: string, id: string): string {
    const now = getTimestamp()
    const row = prjctDb.get<{ updated_at: string }>(
      projectId,
      'SELECT updated_at FROM specs WHERE id = ?',
      id
    )
    const prev = row?.updated_at
    if (!prev || now > prev) return now
    return new Date(new Date(prev).getTime() + 1).toISOString()
  }

  /**
   * Create a new spec. Returns the spec id.
   */
  create(
    projectId: string,
    args: {
      title: string
      content: SpecContent
      tags?: Record<string, string>
    }
  ): Spec {
    const id = generateUUID()
    const now = getTimestamp()
    const validatedContent = SpecContentSchema.parse(args.content)

    prjctDb.run(
      projectId,
      `INSERT INTO specs (id, title, status, content, tags, created_at, updated_at)
       VALUES (?, ?, 'draft', ?, ?, ?, ?)`,
      id,
      args.title,
      JSON.stringify(validatedContent),
      args.tags ? JSON.stringify(args.tags) : null,
      now,
      now
    )
    projectSpecRelational(projectId, id, validatedContent)

    const spec: Spec = {
      id,
      title: args.title,
      status: 'draft',
      content: validatedContent,
      tags: args.tags ?? {},
      createdAt: now,
      updatedAt: now,
      shippedAt: null,
      shippedPr: null,
      shippedSha: null,
      archivedAt: null,
    }
    this.publishSync(projectId, spec)
    return spec
  }

  get(projectId: string, id: string): Spec | null {
    const row = prjctDb.get<SpecRow>(projectId, 'SELECT * FROM specs WHERE id = ?', id)
    return row ? this.rowToSpec(row) : null
  }

  list(projectId: string, filter: { status?: SpecStatus; includeArchived?: boolean } = {}): Spec[] {
    const params: SqliteBindings[] = []
    if (filter.status) params.push(filter.status)
    const statusClause = filter.status
      ? ' AND status = ?'
      : !filter.includeArchived
        ? " AND status != 'archived'"
        : ''
    const sql = `SELECT * FROM specs WHERE 1=1${statusClause} ORDER BY created_at DESC`
    const rows = prjctDb.query<SpecRow>(projectId, sql, ...params)
    return rows.map((r) => this.rowToSpec(r))
  }

  /**
   * Fuzzy-match title or content. Falls back to LIKE — for serious
   * search the FTS5 `memory_entries_fts` table is the better surface.
   */
  search(projectId: string, query: string): Spec[] {
    const like = `%${query}%`
    const rows = prjctDb.query<SpecRow>(
      projectId,
      `SELECT * FROM specs WHERE title LIKE ? OR content LIKE ? ORDER BY created_at DESC`,
      like,
      like
    )
    return rows.map((r) => this.rowToSpec(r))
  }

  updateContent(projectId: string, id: string, content: SpecContent): Spec | null {
    const validated = SpecContentSchema.parse(content)
    const now = this.nextUpdatedAt(projectId, id)
    prjctDb.run(
      projectId,
      'UPDATE specs SET content = ?, updated_at = ? WHERE id = ?',
      JSON.stringify(validated),
      now,
      id
    )
    projectSpecRelational(projectId, id, validated)
    const spec = this.get(projectId, id)
    if (spec) this.publishSync(projectId, spec)
    return spec
  }

  /**
   * Optimistic-concurrency UPDATE on `specs.content`. Returns `true` iff
   * the row's `updated_at` still matched `expectedUpdatedAt` at write time
   * (i.e. nobody else has written since the caller read). Returns `false`
   * on stale read (caller should re-read and retry).
   *
   * Used by recordReview (and breakdownSpecToTasks marker write) to
   * serialize concurrent writers without pulling async work inside a sync
   * SQLite transaction. See spec a50b32d1 AC #12.
   */
  casUpdate(
    projectId: string,
    id: string,
    content: SpecContent,
    expectedUpdatedAt: string
  ): boolean {
    const validated = SpecContentSchema.parse(content)
    const now = this.nextUpdatedAt(projectId, id)
    const result = prjctDb.run(
      projectId,
      'UPDATE specs SET content = ?, updated_at = ? WHERE id = ? AND updated_at = ?',
      JSON.stringify(validated),
      now,
      id,
      expectedUpdatedAt
    )
    const ok = result.changes === 1
    if (ok) {
      projectSpecRelational(projectId, id, validated)
      const spec = this.get(projectId, id)
      if (spec) this.publishSync(projectId, spec)
    }
    return ok
  }

  setStatus(projectId: string, id: string, status: SpecStatus): Spec | null {
    if (!SPEC_STATUSES.includes(status)) {
      throw new Error(`invalid spec status: ${status}`)
    }
    const now = this.nextUpdatedAt(projectId, id)
    const extras: string[] = []
    const params: SqliteBindings[] = [status, now]
    if (status === 'shipped') {
      extras.push('shipped_at = ?')
      params.push(now)
    }
    if (status === 'archived') {
      extras.push('archived_at = ?')
      params.push(now)
    }
    const setClause = ['status = ?', 'updated_at = ?', ...extras].join(', ')
    params.push(id)
    prjctDb.run(projectId, `UPDATE specs SET ${setClause} WHERE id = ?`, ...params)
    const spec = this.get(projectId, id)
    if (spec) this.publishSync(projectId, spec)
    return spec
  }

  setShippedPr(projectId: string, id: string, pr: number): Spec | null {
    prjctDb.run(
      projectId,
      'UPDATE specs SET shipped_pr = ?, updated_at = ? WHERE id = ?',
      pr,
      this.nextUpdatedAt(projectId, id),
      id
    )
    const spec = this.get(projectId, id)
    if (spec) this.publishSync(projectId, spec)
    return spec
  }

  /**
   * Capture the git HEAD sha at ship time. Phase 1.6 / B-DRIFT-ANCHOR:
   * inventory uses this as the diff base for drift detection (not the
   * shipped_at timestamp, which is fragile under rebases).
   */
  setShippedSha(projectId: string, id: string, sha: string): Spec | null {
    prjctDb.run(
      projectId,
      'UPDATE specs SET shipped_sha = ?, updated_at = ? WHERE id = ?',
      sha,
      this.nextUpdatedAt(projectId, id),
      id
    )
    const spec = this.get(projectId, id)
    if (spec) this.publishSync(projectId, spec)
    return spec
  }

  /**
   * Append a task id to the spec's `linked_tasks`. Idempotent.
   */
  linkTask(projectId: string, specId: string, taskId: string): Spec | null {
    const spec = this.get(projectId, specId)
    if (!spec) return null
    if (spec.content.linked_tasks.includes(taskId)) return spec
    const next: SpecContent = {
      ...spec.content,
      linked_tasks: [...spec.content.linked_tasks, taskId],
    }
    return this.updateContent(projectId, specId, next)
  }

  delete(projectId: string, id: string): boolean {
    const before = this.get(projectId, id)
    if (!before) return false
    prjctDb.run(projectId, 'DELETE FROM specs WHERE id = ?', id)
    this.publishSync(projectId, before, 'delete')
    return true
  }

  /**
   * Apply a spec pulled from the cloud — ADDITIVE ONLY. Inserts a spec that
   * doesn't exist locally yet; if the id already exists locally it is left
   * UNTOUCHED. Local data is sacred: sync never modifies or deletes a local
   * record, it only fills in what's missing. Does NOT re-publish (no echo) and
   * preserves the remote timestamps. Used by the sync apply handler only.
   */
  applyRemote(
    projectId: string,
    spec: {
      id: string
      title?: string
      status?: string
      content: unknown
      tags?: Record<string, string> | string | null
      created_at?: string
      updated_at?: string
    }
  ): void {
    if (!spec.id) return
    const content =
      typeof spec.content === 'string' ? spec.content : JSON.stringify(spec.content ?? {})
    const status = SPEC_STATUSES.includes(spec.status as SpecStatus) ? spec.status : 'draft'
    const tags =
      spec.tags == null
        ? null
        : typeof spec.tags === 'string'
          ? spec.tags
          : JSON.stringify(spec.tags)
    const now = getTimestamp()
    const result = prjctDb.run(
      projectId,
      `INSERT INTO specs (id, title, status, content, tags, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO NOTHING`,
      spec.id,
      spec.title ?? '',
      status,
      content,
      tags,
      spec.created_at || now,
      spec.updated_at || now
    )
    // Project the relational gate state (spec_review/spec_selected_reviewer)
    // ONLY when this INSERT actually landed a new spec (result.changes > 0).
    // "Local data is never modified by sync" — ON CONFLICT DO NOTHING above
    // means an existing local spec's content is untouched, so a brand-new spec
    // has no local gate rows yet and this projection is purely additive.
    // Without this, a spec pulled from another machine kept its full reviewed
    // content in the blob but reviewsGatePassedRelational read empty tables and
    // reported "not reviewed" for a spec that was already fully approved.
    if (result.changes > 0) {
      try {
        const parsed = SpecContentSchema.parse(JSON.parse(content))
        projectSpecRelational(projectId, spec.id, parsed)
      } catch {
        // Malformed/legacy remote content — the blob still landed; the
        // relational gate projection is best-effort, not a hard dependency.
      }
    }
  }

  count(projectId: string): { total: number; draft: number; shipped: number } {
    const rows = prjctDb.query<{ status: string; n: number }>(
      projectId,
      'SELECT status, COUNT(*) AS n FROM specs GROUP BY status'
    )
    const out = { total: 0, draft: 0, shipped: 0 }
    for (const r of rows) {
      out.total += r.n
      if (r.status === 'draft') out.draft = r.n
      if (r.status === 'shipped') out.shipped = r.n
    }
    return out
  }

  /**
   * Mirror a spec write into the sync queue so the cloud vault stays a
   * complete picture of the project (SDD specs are first-class knowledge).
   * Best-effort — `publishCRUDSync` swallows errors; local CRUD never fails
   * because of sync.
   */
  private publishSync(
    projectId: string,
    spec: Spec,
    eventType: 'upsert' | 'delete' = 'upsert'
  ): void {
    publishCRUDSync({
      projectId,
      entityType: 'specs',
      entityId: spec.id,
      eventType,
      data: {
        id: spec.id,
        title: spec.title,
        status: spec.status,
        content: spec.content,
        tags: spec.tags,
        created_at: spec.createdAt,
        updated_at: spec.updatedAt,
        shipped_at: spec.shippedAt,
        shipped_pr: spec.shippedPr,
        shipped_sha: spec.shippedSha,
        archived_at: spec.archivedAt,
      },
    })
  }

  private rowToSpec(row: SpecRow): Spec {
    return {
      id: row.id,
      title: row.title,
      status: (SPEC_STATUSES as readonly string[]).includes(row.status)
        ? (row.status as SpecStatus)
        : 'draft',
      content: SpecContentSchema.parse(JSON.parse(row.content)),
      tags: row.tags ? (JSON.parse(row.tags) as Record<string, string>) : {},
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      shippedAt: row.shipped_at,
      shippedPr: row.shipped_pr,
      shippedSha: row.shipped_sha,
      archivedAt: row.archived_at,
    }
  }
}

export const specStorage = new SpecStorage()
export type { SpecStorage }
