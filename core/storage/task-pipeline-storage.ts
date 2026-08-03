import type { TaskPipelineClassification, TaskPipelineStation } from '../services/task-pipeline'
import { getTimestamp } from '../utils/date-helper'
import { prjctDb } from './database'

export interface TaskPipelineStateInput {
  taskId: string
  workspaceId: string
  classification: TaskPipelineClassification
  station: TaskPipelineStation
  requiresSpec: boolean
  requiresTestsFirst: boolean
  reason: string
  linkedSpecId?: string | null
}

export interface TaskPipelineState extends TaskPipelineStateInput {
  projectId: string
  createdAt: string
  updatedAt: string
}

interface TaskPipelineRow {
  project_id: string
  task_id: string
  workspace_id: string
  classification: string
  station: string
  requires_spec: number
  requires_tests_first: number
  reason: string
  linked_spec_id: string | null
  created_at: string
  updated_at: string
}

function toState(row: TaskPipelineRow): TaskPipelineState {
  return {
    projectId: row.project_id,
    taskId: row.task_id,
    workspaceId: row.workspace_id,
    classification: row.classification as TaskPipelineClassification,
    station: row.station as TaskPipelineStation,
    requiresSpec: row.requires_spec === 1,
    requiresTestsFirst: row.requires_tests_first === 1,
    reason: row.reason,
    linkedSpecId: row.linked_spec_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export function upsertTaskPipelineState(
  projectId: string,
  input: TaskPipelineStateInput
): TaskPipelineState {
  const now = getTimestamp()

  const rows = prjctDb.query<TaskPipelineRow>(
    projectId,
    `INSERT INTO task_pipeline_state (
      project_id, task_id, workspace_id, classification, station,
      requires_spec, requires_tests_first, reason, linked_spec_id,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(project_id, task_id, workspace_id) DO UPDATE SET
      classification = excluded.classification,
      station = excluded.station,
      requires_spec = excluded.requires_spec,
      requires_tests_first = excluded.requires_tests_first,
      reason = excluded.reason,
      linked_spec_id = excluded.linked_spec_id,
      updated_at = excluded.updated_at
    RETURNING *`,
    projectId,
    input.taskId,
    input.workspaceId,
    input.classification,
    input.station,
    input.requiresSpec ? 1 : 0,
    input.requiresTestsFirst ? 1 : 0,
    input.reason,
    input.linkedSpecId ?? null,
    now,
    now
  )

  const row = rows[0]
  if (!row) throw new Error('Task pipeline state upsert returned no row')
  return toState(row)
}

export function getTaskPipelineState(
  projectId: string,
  taskId: string,
  workspaceId: string
): TaskPipelineState | null {
  const rows = prjctDb.query<TaskPipelineRow>(
    projectId,
    `SELECT * FROM task_pipeline_state
     WHERE project_id = ? AND task_id = ? AND workspace_id = ?
     LIMIT 1`,
    projectId,
    taskId,
    workspaceId
  )
  const row = rows[0]
  return row ? toState(row) : null
}
