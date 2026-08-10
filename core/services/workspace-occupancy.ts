/**
 * Workspace occupancy — should this `prjct work` isolate into a worktree?
 *
 * Parallel agents often share a main checkout. When the current workspace
 * already has an active cycle owned by someone else, the new agent should
 * create a sibling worktree instead of clobbering (or being gated by) it.
 */

import type { CurrentTask, WorkspaceTask } from '../schemas/state'
import { stateStorage } from '../storage/state-storage'
import { type AgentIdentity, resolveCallerIdentity, sameOwner } from './agent-identity'
import { collectActiveTasks } from './task-overview'
import { deriveWorkspace, MAIN_WORKSPACE_ID } from './workspace-id'

export type AutoWorktreeMode = 'auto' | 'ask' | 'off'

export interface OccupancyOwner {
  taskId: string
  description: string
  ownerAgent?: string
  ownerIdentity?: string
  startedAt: string
  workspaceId: string
  branch?: string
}

export interface WorkspaceOccupancy {
  workspaceId: string
  isMain: boolean
  current: OccupancyOwner | null
  others: OccupancyOwner[]
  /** True when this workspace has a live cycle. */
  occupied: boolean
  /** True when the occupant is the same caller (session/identity). */
  occupiedByMe: boolean
}

export interface IsolateDecision {
  isolate: boolean
  /** Block start and tell the agent what to do (ask mode / unsafe). */
  block?: boolean
  reason: string
  occupant?: OccupancyOwner
}

function asOwner(task: CurrentTask | WorkspaceTask, workspaceId: string): OccupancyOwner {
  return {
    taskId: task.id,
    description: task.description,
    ownerAgent: task.ownerAgent,
    ownerIdentity: task.ownerIdentity,
    startedAt: task.startedAt,
    workspaceId,
    branch: task.branch,
  }
}

export async function getOccupancy(
  projectId: string,
  projectPath: string,
  caller?: AgentIdentity
): Promise<WorkspaceOccupancy> {
  const me = caller ?? resolveCallerIdentity(projectPath)
  const ws = await deriveWorkspace(projectPath)
  const overview = await collectActiveTasks(projectId, projectPath)

  const currentTask = ws.isMain
    ? await stateStorage.getCurrentTask(projectId)
    : await stateStorage.getCurrentTaskForWorkspace(projectId, ws.workspaceId)
  const current = currentTask
    ? asOwner(currentTask, ws.isMain ? MAIN_WORKSPACE_ID : ws.workspaceId)
    : null

  const others = overview.all
    .filter((v) => !v.isCurrent)
    .map((v) => ({
      taskId: v.id,
      description: v.description,
      startedAt: v.startedAt,
      workspaceId: v.workspaceId,
      branch: v.branch,
    }))

  const occupied = current !== null
  const occupiedByMe = occupied && sameOwner(current, me)

  return {
    workspaceId: ws.workspaceId,
    isMain: ws.isMain,
    current,
    others,
    occupied,
    occupiedByMe,
  }
}

/**
 * Decide whether a new work intent should isolate into a worktree.
 *
 * - Idle workspace → no isolate
 * - Occupied by me → no isolate (single-task gate handles double-start)
 * - Occupied by other + auto → isolate
 * - Occupied by other + ask → block with guidance
 * - off → no isolate (legacy)
 * - Already in a child worktree → never nest; gate instead
 */
export function shouldIsolate(
  occupancy: WorkspaceOccupancy,
  mode: AutoWorktreeMode,
  _intent: string
): IsolateDecision {
  if (mode === 'off') {
    return { isolate: false, reason: 'autoWorktree off' }
  }

  if (!occupancy.occupied || occupancy.occupiedByMe) {
    return { isolate: false, reason: 'workspace free or owned by caller' }
  }

  const occupant = occupancy.current!
  const who =
    [occupant.ownerAgent, occupant.ownerIdentity].filter(Boolean).join('/') || 'another agent'

  // Never nest worktrees — child worktree with foreign? shouldn't happen often;
  // fall through to block/ask rather than create .worktrees inside .worktrees.
  if (!occupancy.isMain) {
    return {
      isolate: false,
      block: true,
      occupant,
      reason: `Workspace already owned by ${who} on "${occupant.description}" (${occupant.taskId.slice(0, 8)}). Work elsewhere or \`prjct switch\` to take over.`,
    }
  }

  if (mode === 'ask') {
    return {
      isolate: false,
      block: true,
      occupant,
      reason: `Workspace owned by ${who} on "${occupant.description}" (${occupant.taskId.slice(0, 8)}). Re-run with isolation (config multiAgent.autoWorktree=auto) or \`prjct switch <agent>\` to yield that cycle.`,
    }
  }

  // auto
  return {
    isolate: true,
    occupant,
    reason: `Branch/workspace owned by ${who} on "${occupant.description}" (${occupant.taskId.slice(0, 8)}). Isolating to a sibling worktree.`,
  }
}

/** Slug for `.worktrees/{slug}` from a work description. */
export function worktreeSlugFromIntent(intent: string): string {
  const base = intent
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
  return base || `work-${Date.now().toString(36)}`
}
