/**
 * Queue Storage
 *
 * Schema v2: the GTD queue lives in the typed `queue_tasks` table — indexed
 * reads (`getActiveTasks` runs on EVERY prompt via hooks/prompt.ts) and
 * row-level writes. The legacy `kv_store['queue']` blob was parsed whole per
 * prompt (1.08MB on the reference project) and rewritten whole per mutation;
 * migration 53 backfilled it into this table and retired the key.
 *
 * Still extends StorageManager solely for `publishEvent` (the cloud-sync
 * wire) — the blob read/write path is unused.
 */

import { generateUUID } from '../schemas/schemas'
import type { Priority, QueueJson, QueueTask, TaskSection } from '../schemas/state'
import { QueueJsonSchema } from '../schemas/state'
import { sortBySectionAndPriority } from '../utils/collection-filters'
import { getDaysAgo, getTimestamp } from '../utils/date-helper'
import { ARCHIVE_POLICIES, archiveStorage } from './archive-storage'
import { prjctDb } from './database'
import { StorageManager } from './storage-manager'

/** A row of the typed `queue_tasks` table. */
interface QueueTaskRow {
  id: string
  description: string
  type: string | null
  priority: string | null
  section: string | null
  created_at: string
  completed: number
  completed_at: string | null
  feature_id: string | null
  feature_name: string | null
  body: string | null
  agent: string | null
  group_name: string | null
  group_id: string | null
}

function rowToTask(r: QueueTaskRow): QueueTask {
  const task: QueueTask = {
    id: r.id,
    description: r.description,
    priority: (r.priority ?? 'medium') as QueueTask['priority'],
    type: (r.type ?? 'feature') as QueueTask['type'],
    section: (r.section ?? 'backlog') as QueueTask['section'],
    completed: r.completed === 1,
    createdAt: r.created_at,
  }
  if (r.completed_at != null) task.completedAt = r.completed_at
  if (r.feature_id != null) task.featureId = r.feature_id
  if (r.feature_name != null) task.originFeature = r.feature_name
  if (r.body != null) task.body = r.body
  if (r.agent != null) task.agent = r.agent
  if (r.group_name != null) task.groupName = r.group_name
  if (r.group_id != null) task.groupId = r.group_id
  return task
}

const INSERT_SQL = `INSERT INTO queue_tasks
   (id, description, type, priority, section, created_at, completed, completed_at,
    feature_id, feature_name, body, agent, group_name, group_id)
 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`

function insertParams(t: QueueTask): (string | number | null)[] {
  return [
    t.id,
    t.description,
    t.type ?? null,
    t.priority ?? null,
    t.section ?? 'backlog',
    t.createdAt,
    t.completed ? 1 : 0,
    t.completedAt ?? null,
    t.featureId ?? null,
    t.originFeature ?? null,
    t.body ?? null,
    t.agent ?? null,
    t.groupName ?? null,
    t.groupId ?? null,
  ]
}

class QueueStorage extends StorageManager<QueueJson> {
  constructor() {
    super('queue.json', QueueJsonSchema)
  }

  // Vestigial abstract-method implementations — the base blob path is unused;
  // kept only so `publishEvent` (the sync surface) stays available.
  protected getDefault(): QueueJson {
    return { tasks: [], lastUpdated: '' }
  }

  protected getEventType(action: 'update' | 'create' | 'delete'): string {
    return `queue.${action}d`
  }

  // =========== Domain Methods ===========

  /** All tasks, insertion order. */
  async getTasks(projectId: string): Promise<QueueTask[]> {
    return prjctDb
      .query<QueueTaskRow>(projectId, 'SELECT * FROM queue_tasks ORDER BY created_at ASC')
      .map(rowToTask)
  }

  /** Active (non-backlog, incomplete) tasks — the per-prompt hot read. */
  async getActiveTasks(projectId: string): Promise<QueueTask[]> {
    return prjctDb
      .query<QueueTaskRow>(
        projectId,
        "SELECT * FROM queue_tasks WHERE section = 'active' AND completed = 0 ORDER BY created_at ASC"
      )
      .map(rowToTask)
  }

  /** Backlog (incomplete) tasks. */
  async getBacklog(projectId: string): Promise<QueueTask[]> {
    return prjctDb
      .query<QueueTaskRow>(
        projectId,
        "SELECT * FROM queue_tasks WHERE section = 'backlog' AND completed = 0 ORDER BY created_at ASC"
      )
      .map(rowToTask)
  }

  /** Next task (highest-priority incomplete active). */
  async getNextTask(projectId: string): Promise<QueueTask | null> {
    const tasks = await this.getActiveTasks(projectId)
    return sortBySectionAndPriority(tasks)[0] || null
  }

  /** Add a task to the queue. */
  async addTask(
    projectId: string,
    task: Omit<QueueTask, 'id' | 'createdAt' | 'completed' | 'completedAt'>
  ): Promise<QueueTask> {
    const newTask: QueueTask = {
      ...task,
      id: generateUUID(),
      createdAt: getTimestamp(),
      completed: false,
    }
    prjctDb.run(projectId, INSERT_SQL, ...insertParams(newTask))

    await this.publishEvent(projectId, 'queue.task_added', {
      taskId: newTask.id,
      description: newTask.description,
      priority: newTask.priority,
      section: newTask.section,
      created_at: newTask.createdAt,
    })

    return newTask
  }

  /** Add multiple tasks. */
  async addTasks(
    projectId: string,
    tasks: Omit<QueueTask, 'id' | 'createdAt' | 'completed' | 'completedAt'>[]
  ): Promise<QueueTask[]> {
    const now = getTimestamp()
    const newTasks: QueueTask[] = tasks.map((task) => ({
      ...task,
      id: generateUUID(),
      createdAt: now,
      completed: false,
    }))
    for (const t of newTasks) prjctDb.run(projectId, INSERT_SQL, ...insertParams(t))

    await this.publishEvent(projectId, 'queue.tasks_added', {
      count: newTasks.length,
      tasks: newTasks.map((t) => ({
        id: t.id,
        description: t.description,
        created_at: t.createdAt,
      })),
    })

    return newTasks
  }

  /**
   * Upsert a task by id — the sync-pull apply path. Field merge matches the
   * legacy handler: incoming values win, locally-only fields survive.
   */
  async upsertTask(
    projectId: string,
    task: Pick<QueueTask, 'id' | 'description'> & Partial<QueueTask>
  ): Promise<void> {
    const existing = await this.getTask(projectId, task.id)
    if (existing) {
      // Field-presence merge: only keys the caller EXPLICITLY sent overwrite
      // local values. Spreading fabricated defaults here once let a cloud
      // echo of a minimal payload reset a local 'active/high' task to
      // 'backlog/medium' — vanishing it from the per-prompt active read.
      const merged = { ...existing }
      for (const k of ['description', 'type', 'priority', 'section'] as const) {
        if (task[k] !== undefined) (merged as Record<string, unknown>)[k] = task[k]
      }
      prjctDb.run(
        projectId,
        `UPDATE queue_tasks SET description = ?, type = ?, priority = ?, section = ?
         WHERE id = ?`,
        merged.description,
        merged.type ?? null,
        merged.priority ?? null,
        merged.section ?? 'backlog',
        task.id
      )
      return
    }
    const row: QueueTask = {
      ...task,
      id: task.id,
      description: task.description,
      priority: task.priority ?? 'medium',
      type: task.type ?? 'feature',
      section: task.section ?? 'backlog',
      completed: task.completed ?? false,
      createdAt: task.createdAt ?? getTimestamp(),
    }
    prjctDb.run(projectId, INSERT_SQL, ...insertParams(row))
  }

  /** Remove a task. */
  async removeTask(projectId: string, taskId: string): Promise<void> {
    prjctDb.run(projectId, 'DELETE FROM queue_tasks WHERE id = ?', taskId)
    await this.publishEvent(projectId, 'queue.task_removed', { taskId })
  }

  /**
   * Remove every task whose `featureId` matches. Returns rows-deleted.
   * NOT `linkedSpecId` — that field is reserved for `prjct work --spec`
   * invocations. breakdownSpecToTasks no longer calls this: its recovery
   * reconciles by adoption instead of wiping (orphans stay visible in
   * the queue). Kept as storage-level API.
   * See spec a50b32d1 AC #13.
   */
  async deleteByFeatureId(projectId: string, featureId: string): Promise<number> {
    const result = prjctDb.run(projectId, 'DELETE FROM queue_tasks WHERE feature_id = ?', featureId)
    const deleted = result.changes
    if (deleted > 0) {
      await this.publishEvent(projectId, 'queue.tasks_removed_by_feature', {
        featureId,
        count: deleted,
      })
    }
    return deleted
  }

  /** Mark a task as completed. */
  async completeTask(projectId: string, taskId: string): Promise<QueueTask | null> {
    const completedAt = getTimestamp()
    const result = prjctDb.run(
      projectId,
      'UPDATE queue_tasks SET completed = 1, completed_at = ? WHERE id = ? AND completed = 0',
      completedAt,
      taskId
    )
    if (result.changes === 0) return null

    const task = await this.getTask(projectId, taskId)
    if (task) {
      await this.publishEvent(projectId, 'queue.task_completed', {
        taskId,
        description: task.description,
        completedAt: task.completedAt,
      })
    }
    return task
  }

  /** Move task to a different section. */
  async moveToSection(projectId: string, taskId: string, section: TaskSection): Promise<void> {
    prjctDb.run(projectId, 'UPDATE queue_tasks SET section = ? WHERE id = ?', section, taskId)
  }

  /** Set task priority. */
  async setPriority(projectId: string, taskId: string, priority: Priority): Promise<void> {
    prjctDb.run(projectId, 'UPDATE queue_tasks SET priority = ? WHERE id = ?', priority, taskId)
  }

  /** Get a single task by ID. */
  async getTask(projectId: string, taskId: string): Promise<QueueTask | null> {
    const row = prjctDb.get<QueueTaskRow>(
      projectId,
      'SELECT * FROM queue_tasks WHERE id = ?',
      taskId
    )
    return row ? rowToTask(row) : null
  }

  /** Update task fields (description, body, type, priority, section). */
  async updateTask(
    projectId: string,
    taskId: string,
    updates: Partial<Pick<QueueTask, 'description' | 'body' | 'type' | 'priority' | 'section'>>
  ): Promise<QueueTask | null> {
    const existing = await this.getTask(projectId, taskId)
    if (!existing) return null

    const merged = { ...existing, ...updates }
    prjctDb.run(
      projectId,
      'UPDATE queue_tasks SET description = ?, body = ?, type = ?, priority = ?, section = ? WHERE id = ?',
      merged.description,
      merged.body ?? null,
      merged.type ?? null,
      merged.priority ?? null,
      merged.section ?? 'backlog',
      taskId
    )
    await this.publishEvent(projectId, 'queue.task_updated', { taskId })
    return merged
  }

  /** Clear completed tasks. Returns count removed. */
  async clearCompleted(projectId: string): Promise<number> {
    return prjctDb.run(projectId, 'DELETE FROM queue_tasks WHERE completed = 1').changes
  }

  /**
   * Remove completed tasks older than retention period (PRJ-267).
   * Archives them to SQLite before removal. Returns count removed.
   */
  async removeStaleCompleted(projectId: string): Promise<number> {
    const thresholdIso = getDaysAgo(ARCHIVE_POLICIES.QUEUE_COMPLETED_DAYS).toISOString()

    const stale = prjctDb
      .query<QueueTaskRow>(
        projectId,
        'SELECT * FROM queue_tasks WHERE completed = 1 AND completed_at IS NOT NULL AND completed_at < ?',
        thresholdIso
      )
      .map(rowToTask)
    if (stale.length === 0) return 0

    archiveStorage.archiveMany(
      projectId,
      stale.map((t) => ({
        entityType: 'queue_task' as const,
        entityId: t.id,
        entityData: t,
        summary: t.description,
        reason: 'age',
      }))
    )

    prjctDb.run(
      projectId,
      'DELETE FROM queue_tasks WHERE completed = 1 AND completed_at IS NOT NULL AND completed_at < ?',
      thresholdIso
    )

    await this.publishEvent(projectId, 'queue.stale_removed', { count: stale.length })
    return stale.length
  }
}

export const queueStorage = new QueueStorage()
