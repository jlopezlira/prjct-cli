/**
 * Durable task handoffs — multi-agent yield/accept bus over SQLite.
 *
 * `prjct switch <agent>` writes a pending row; `prjct accept` claims it.
 * Hooks inject pending rows so the target terminal can pick up without
 * a shared chat transcript.
 */

import { generateUUID } from '../schemas/schemas'
import { getTimestamp } from '../utils/date-helper'
import { prjctDb } from './database'

export type HandoffStatus = 'pending' | 'accepted' | 'expired' | 'cancelled'

export interface HandoffEvidence {
  turns?: number
  files?: string[]
  pressure?: string
  loopStopped?: boolean
  journal?: string[]
  tried?: string
}

export interface TaskHandoff {
  id: string
  projectId: string
  taskId: string
  taskDescription: string
  fromAgent: string
  fromIdentity: string | null
  toAgent: string
  reason: string
  evidence: HandoffEvidence | null
  status: HandoffStatus
  workspaceId: string | null
  worktreePath: string | null
  branch: string | null
  createdAt: string
  acceptedAt: string | null
  acceptedBy: string | null
  expiresAt: string | null
}

export interface CreateHandoffInput {
  projectId: string
  taskId: string
  taskDescription: string
  fromAgent: string
  fromIdentity?: string | null
  toAgent: string
  reason: string
  evidence?: HandoffEvidence | null
  workspaceId?: string | null
  worktreePath?: string | null
  branch?: string | null
  /** TTL hours; default 24 */
  ttlHours?: number
}

interface HandoffRow {
  id: string
  project_id: string
  task_id: string
  task_description: string
  from_agent: string
  from_identity: string | null
  to_agent: string
  reason: string
  evidence: string | null
  status: string
  workspace_id: string | null
  worktree_path: string | null
  branch: string | null
  created_at: string
  accepted_at: string | null
  accepted_by: string | null
  expires_at: string | null
}

function parseEvidence(raw: string | null): HandoffEvidence | null {
  if (!raw) return null
  try {
    return JSON.parse(raw) as HandoffEvidence
  } catch {
    return null
  }
}

function toHandoff(row: HandoffRow): TaskHandoff {
  return {
    id: row.id,
    projectId: row.project_id,
    taskId: row.task_id,
    taskDescription: row.task_description,
    fromAgent: row.from_agent,
    fromIdentity: row.from_identity,
    toAgent: row.to_agent,
    reason: row.reason,
    evidence: parseEvidence(row.evidence),
    status: row.status as HandoffStatus,
    workspaceId: row.workspace_id,
    worktreePath: row.worktree_path,
    branch: row.branch,
    createdAt: row.created_at,
    acceptedAt: row.accepted_at,
    acceptedBy: row.accepted_by,
    expiresAt: row.expires_at,
  }
}

function expiresAtIso(ttlHours: number): string {
  const d = new Date()
  d.setTime(d.getTime() + Math.max(1, ttlHours) * 3600_000)
  return d.toISOString()
}

export function createHandoff(input: CreateHandoffInput): TaskHandoff {
  const id = `hand_${generateUUID()}`
  const now = getTimestamp()
  const ttl = input.ttlHours ?? 24
  const evidenceJson = input.evidence ? JSON.stringify(input.evidence) : null

  prjctDb.run(
    input.projectId,
    `INSERT INTO task_handoffs (
      id, project_id, task_id, task_description, from_agent, from_identity,
      to_agent, reason, evidence, status, workspace_id, worktree_path, branch,
      created_at, accepted_at, accepted_by, expires_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, NULL, NULL, ?)`,
    id,
    input.projectId,
    input.taskId,
    input.taskDescription,
    input.fromAgent,
    input.fromIdentity ?? null,
    input.toAgent,
    input.reason,
    evidenceJson,
    input.workspaceId ?? null,
    input.worktreePath ?? null,
    input.branch ?? null,
    now,
    expiresAtIso(ttl)
  )

  return {
    id,
    projectId: input.projectId,
    taskId: input.taskId,
    taskDescription: input.taskDescription,
    fromAgent: input.fromAgent,
    fromIdentity: input.fromIdentity ?? null,
    toAgent: input.toAgent,
    reason: input.reason,
    evidence: input.evidence ?? null,
    status: 'pending',
    workspaceId: input.workspaceId ?? null,
    worktreePath: input.worktreePath ?? null,
    branch: input.branch ?? null,
    createdAt: now,
    acceptedAt: null,
    acceptedBy: null,
    expiresAt: expiresAtIso(ttl),
  }
}

export function getHandoff(projectId: string, id: string): TaskHandoff | null {
  const row = prjctDb.get<HandoffRow>(
    projectId,
    'SELECT * FROM task_handoffs WHERE id = ? OR id LIKE ?',
    id,
    `${id}%`
  )
  return row ? toHandoff(row) : null
}

/**
 * Throttle state for expireStaleHandoffs: last sweep time per project.
 * listHandoffs runs on every prompt hook (via formatPendingHandoffCue) in
 * every project — most of which never use handoffs at all — so sweeping on
 * every single call was a write transaction per prompt for a condition
 * that's true almost never. The `pending` read filter below is what keeps
 * results correct between sweeps; this throttle only delays the bookkeeping
 * UPDATE, never the visible data.
 */
const staleHandoffSweepedAt = new Map<string, number>()
const STALE_HANDOFF_SWEEP_INTERVAL_MS = 60 * 1000

/** Expire stale pending rows (lazy, on read paths, throttled per project). */
export function expireStaleHandoffs(projectId: string): number {
  const nowMs = Date.now()
  const last = staleHandoffSweepedAt.get(projectId) ?? 0
  if (nowMs - last < STALE_HANDOFF_SWEEP_INTERVAL_MS) return 0
  staleHandoffSweepedAt.set(projectId, nowMs)
  try {
    prjctDb.run(
      projectId,
      `UPDATE task_handoffs SET status = 'expired'
       WHERE status = 'pending' AND expires_at IS NOT NULL AND expires_at < ?`,
      getTimestamp()
    )
  } catch {
    return 0
  }
  return 0
}

export function listHandoffs(
  projectId: string,
  opts: { status?: HandoffStatus; toAgent?: string; limit?: number } = {}
): TaskHandoff[] {
  expireStaleHandoffs(projectId)
  const limit = opts.limit ?? 20
  const clauses: string[] = []
  const params: Array<string | number> = []
  if (opts.status) {
    clauses.push('status = ?')
    params.push(opts.status)
    // expireStaleHandoffs is throttled (see its docstring) — a row can be
    // logically expired but not yet re-stamped by the UPDATE. Filter
    // "pending" reads by expires_at directly so throttling can never
    // surface an already-expired handoff as pending; other statuses are
    // exact-match only (accepted/cancelled/expired don't self-expire).
    if (opts.status === 'pending') {
      clauses.push('(expires_at IS NULL OR expires_at >= ?)')
      params.push(getTimestamp())
    }
  }
  if (opts.toAgent) {
    clauses.push('to_agent = ?')
    params.push(opts.toAgent)
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''
  const rows = prjctDb.query<HandoffRow>(
    projectId,
    `SELECT * FROM task_handoffs ${where} ORDER BY created_at DESC LIMIT ?`,
    ...params,
    limit
  )
  return rows.map(toHandoff)
}

export function listPendingForAgent(projectId: string, toAgent: string): TaskHandoff[] {
  return listHandoffs(projectId, { status: 'pending', toAgent, limit: 10 })
}

/**
 * Race-free accept: succeeds only if still pending AND not expired.
 * Returns the handoff when this caller won; null if lost or missing.
 * The expiry guard lives in the UPDATE itself (not the throttled sweep),
 * so an expired-but-not-yet-swept row can never be accepted.
 */
export function acceptHandoff(
  projectId: string,
  id: string,
  acceptedBy: string
): TaskHandoff | null {
  expireStaleHandoffs(projectId)
  const now = getTimestamp()
  prjctDb.run(
    projectId,
    `UPDATE task_handoffs
     SET status = 'accepted', accepted_at = ?, accepted_by = ?
     WHERE (id = ? OR id LIKE ?) AND status = 'pending'
       AND (expires_at IS NULL OR expires_at >= ?)`,
    now,
    acceptedBy,
    id,
    `${id}%`,
    now
  )
  const row = prjctDb.get<HandoffRow>(
    projectId,
    'SELECT * FROM task_handoffs WHERE (id = ? OR id LIKE ?) AND status = ? AND accepted_by = ?',
    id,
    `${id}%`,
    'accepted',
    acceptedBy
  )
  return row ? toHandoff(row) : null
}
