/**
 * Ideas Storage
 *
 * Schema v2: ideas live in the typed `ideas` table — hot fields as columns
 * (text, status, priority, added_at, converted_to, details), the tag list in
 * the cold `tags` JSON column (never key-queried), and the rare extras
 * (painPoints/solutions/filesAffected/impactEffort) in the cold `data`
 * column. The legacy `kv_store['ideas']` blob was backfilled and retired by
 * migration 55.
 *
 * Extends StorageManager solely for `publishEvent` (the cloud-sync wire).
 */

import { IdeasJsonSchema } from '../schemas/ideas'
import { generateUUID } from '../schemas/schemas'
import type { Idea, IdeaPriority, IdeaStatus, IdeasJson } from '../types/storage'
import { getDaysAgo, getTimestamp } from '../utils/date-helper'
import { ARCHIVE_POLICIES, archiveStorage } from './archive-storage'
import { prjctDb } from './database'
import { StorageManager } from './storage-manager'

/** A row of the typed `ideas` table. */
interface IdeaRow {
  id: string
  text: string
  status: string
  priority: string
  tags: string | null
  added_at: string
  converted_to: string | null
  details: string | null
  data: string | null
}

function rowToIdea(r: IdeaRow): Idea {
  const tags = (() => {
    if (!r.tags) return []
    try {
      const parsed = JSON.parse(r.tags)
      return Array.isArray(parsed) ? parsed : []
    } catch {
      return []
    }
  })()
  const extra = (() => {
    if (!r.data) return {}
    try {
      return JSON.parse(r.data) as Partial<Idea>
    } catch {
      return {}
    }
  })()
  const idea: Idea = {
    ...extra,
    id: r.id,
    text: r.text,
    status: r.status as IdeaStatus,
    priority: r.priority as IdeaPriority,
    tags,
    addedAt: r.added_at,
  }
  if (r.converted_to != null) idea.convertedTo = r.converted_to
  if (r.details != null) idea.details = r.details
  return idea
}

class IdeasStorage extends StorageManager<IdeasJson> {
  constructor() {
    super('ideas.json', IdeasJsonSchema)
  }

  // Vestigial abstract-method implementations — the blob path is unused; kept
  // only so `publishEvent` (the sync surface) stays available.
  protected getDefault(): IdeasJson {
    return { ideas: [], lastUpdated: '' }
  }

  protected getEventType(action: 'update' | 'create' | 'delete'): string {
    return `ideas.${action}d`
  }

  // =========== Domain Methods ===========

  /** All ideas, newest first. */
  async getAll(projectId: string): Promise<Idea[]> {
    return prjctDb
      .query<IdeaRow>(projectId, 'SELECT * FROM ideas ORDER BY added_at DESC')
      .map(rowToIdea)
  }

  /** Pending ideas, newest first. */
  async getPending(projectId: string): Promise<Idea[]> {
    return prjctDb
      .query<IdeaRow>(
        projectId,
        "SELECT * FROM ideas WHERE status = 'pending' ORDER BY added_at DESC"
      )
      .map(rowToIdea)
  }

  /** Add a new idea. */
  async addIdea(
    projectId: string,
    text: string,
    options: { tags?: string[]; priority?: IdeaPriority } = {}
  ): Promise<Idea> {
    const idea: Idea = {
      id: generateUUID(),
      text,
      status: 'pending',
      priority: options.priority || 'medium',
      tags: options.tags || [],
      addedAt: getTimestamp(),
    }
    prjctDb.run(
      projectId,
      `INSERT INTO ideas (id, text, status, priority, tags, added_at, converted_to, details, data)
       VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL)`,
      idea.id,
      idea.text,
      idea.status,
      idea.priority,
      idea.tags.length ? JSON.stringify(idea.tags) : null,
      idea.addedAt
    )

    await this.publishEvent(projectId, 'idea.created', {
      ideaId: idea.id,
      text: idea.text,
      priority: idea.priority,
    })

    return idea
  }

  /**
   * Upsert an idea by id — the sync-pull apply path (replaces the handler's
   * blob read-modify-write). Preserves the local addedAt when present.
   */
  async upsertIdea(
    projectId: string,
    fields: {
      id: string
      text: string
      priority: IdeaPriority
      status: IdeaStatus
      addedAt: string
    }
  ): Promise<void> {
    prjctDb.run(
      projectId,
      `INSERT INTO ideas (id, text, status, priority, tags, added_at)
       VALUES (?, ?, ?, ?, NULL, ?)
       ON CONFLICT(id) DO UPDATE SET
         text = excluded.text,
         status = excluded.status,
         priority = excluded.priority`,
      fields.id,
      fields.text,
      fields.status,
      fields.priority,
      fields.addedAt
    )
  }

  /** Get idea by ID. */
  async getById(projectId: string, id: string): Promise<Idea | undefined> {
    const row = prjctDb.get<IdeaRow>(projectId, 'SELECT * FROM ideas WHERE id = ?', id)
    return row ? rowToIdea(row) : undefined
  }

  /** Convert idea to feature. */
  async convertToFeature(projectId: string, ideaId: string, featureId: string): Promise<void> {
    prjctDb.run(
      projectId,
      "UPDATE ideas SET status = 'converted', converted_to = ? WHERE id = ?",
      featureId,
      ideaId
    )
    await this.publishEvent(projectId, 'idea.converted', { ideaId, featureId })
  }

  /** Archive an idea. */
  async archive(projectId: string, ideaId: string): Promise<void> {
    prjctDb.run(projectId, "UPDATE ideas SET status = 'archived' WHERE id = ?", ideaId)
    await this.publishEvent(projectId, 'idea.archived', { ideaId })
  }

  /** Set priority. */
  async setPriority(projectId: string, ideaId: string, priority: IdeaPriority): Promise<void> {
    prjctDb.run(projectId, 'UPDATE ideas SET priority = ? WHERE id = ?', priority, ideaId)
  }

  /** Add tags to an idea (deduped union — tags are a cold JSON list). */
  async addTags(projectId: string, ideaId: string, tags: string[]): Promise<void> {
    const idea = await this.getById(projectId, ideaId)
    if (!idea) return
    const merged = [...new Set([...idea.tags, ...tags])]
    prjctDb.run(
      projectId,
      'UPDATE ideas SET tags = ? WHERE id = ?',
      merged.length ? JSON.stringify(merged) : null,
      ideaId
    )
  }

  /** Remove an idea. */
  async removeIdea(projectId: string, ideaId: string): Promise<void> {
    prjctDb.run(projectId, 'DELETE FROM ideas WHERE id = ?', ideaId)
  }

  /** Counts by status — SQL aggregate. */
  async getCounts(
    projectId: string
  ): Promise<{ pending: number; converted: number; archived: number }> {
    const rows = prjctDb.query<{ status: string; c: number }>(
      projectId,
      'SELECT status, COUNT(*) AS c FROM ideas GROUP BY status'
    )
    const by = new Map(rows.map((r) => [r.status, r.c]))
    return {
      pending: by.get('pending') ?? 0,
      converted: by.get('converted') ?? 0,
      archived: by.get('archived') ?? 0,
    }
  }

  /** Cleanup old archived ideas (keep newest 50). */
  async cleanup(projectId: string): Promise<{ removed: number }> {
    const result = prjctDb.run(
      projectId,
      `DELETE FROM ideas WHERE status = 'archived' AND id NOT IN (
         SELECT id FROM ideas WHERE status = 'archived' ORDER BY added_at DESC LIMIT 50
       )`
    )
    return { removed: result.changes }
  }

  /**
   * Mark pending ideas older than retention period as dormant (PRJ-267).
   * Dormant ideas are excluded from LLM context but remain queryable.
   */
  async markDormantIdeas(projectId: string): Promise<number> {
    const thresholdIso = getDaysAgo(ARCHIVE_POLICIES.IDEA_DORMANT_DAYS).toISOString()
    const stale = prjctDb
      .query<IdeaRow>(
        projectId,
        "SELECT * FROM ideas WHERE status = 'pending' AND added_at < ?",
        thresholdIso
      )
      .map(rowToIdea)
    if (stale.length === 0) return 0

    archiveStorage.archiveMany(
      projectId,
      stale.map((idea) => ({
        entityType: 'idea' as const,
        entityId: idea.id,
        entityData: idea,
        summary: idea.text,
        reason: 'dormant',
      }))
    )

    prjctDb.run(
      projectId,
      "UPDATE ideas SET status = 'dormant' WHERE status = 'pending' AND added_at < ?",
      thresholdIso
    )

    await this.publishEvent(projectId, 'ideas.dormant', { count: stale.length })
    return stale.length
  }
}

export const ideasStorage = new IdeasStorage()
