/**
 * Spec → Tasks auto-breakdown.
 *
 * When `audit-spec` promotes a spec from `draft` → `reviewed` (all three
 * reviewers pass), the spec's `acceptance_criteria` are materialized as
 * granular queue tasks — one per AC. Each task lands in the backlog
 * tagged with `featureId = spec.id`.
 *
 * Idempotency + crash recovery via the `tasks_created_at` completion
 * marker on SpecContent:
 *
 *   - Marker set     → already broken down, skip.
 *   - Marker null +
 *     linked_tasks
 *     non-empty      → PARTIAL breakdown (previous attempt crashed mid-
 *                      flight). Wipe queue rows by featureId, clear
 *                      linked_tasks, then re-run the full loop. The
 *                      partial state cannot be transactional because
 *                      queueStorage writes queue.json via StorageManager
 *                      (async file I/O + event publishes, incompatible
 *                      with sync SQLite tx). Recovery is convergent: the
 *                      marker is set ONLY after the loop completes, so
 *                      any crash leaves marker=null and the next caller
 *                      re-enters the recovery branch.
 *   - Marker null +
 *     linked_tasks
 *     empty          → fresh breakdown.
 *
 * See spec a50b32d1 AC #13.
 */
import { projectMemory } from '../memory/project-memory'
import { queueStorage } from '../storage/queue-storage'
import { specStorage } from '../storage/spec-storage'
import type { Spec, SpecContent } from '../types/spec'
import { getTimestamp } from '../utils/date-helper'

export interface BreakdownResult {
  /** Task ids newly created. Empty when breakdown is a no-op. */
  taskIds: string[]
  /** Why we skipped (only present when taskIds is empty). */
  skippedReason?: 'no_acceptance_criteria' | 'already_broken_down'
  /** Whether we entered the partial-recovery branch on this call. */
  recoveredFromPartial?: boolean
}

export async function breakdownSpecToTasks(
  projectId: string,
  projectPath: string,
  spec: Spec
): Promise<BreakdownResult> {
  const acs = spec.content.acceptance_criteria
  if (acs.length === 0) {
    return { taskIds: [], skippedReason: 'no_acceptance_criteria' }
  }

  // Entry guard: marker set ⇒ already complete.
  if (spec.content.tasks_created_at !== null) {
    return { taskIds: [], skippedReason: 'already_broken_down' }
  }

  // Partial-recovery detection: marker null but linked_tasks non-empty
  // means a previous attempt crashed mid-loop. Wipe + restart from scratch.
  const recoveredFromPartial = spec.content.linked_tasks.length > 0
  if (recoveredFromPartial) {
    await queueStorage.deleteByFeatureId(projectId, spec.id)
    const cleared: SpecContent = {
      ...spec.content,
      linked_tasks: [],
    }
    specStorage.updateContent(projectId, spec.id, cleared)
  }

  const newTasks = await queueStorage.addTasks(
    projectId,
    acs.map((ac) => ({
      description: truncateForDescription(ac),
      body: ac,
      priority: 'medium' as const,
      type: 'feature' as const,
      section: 'backlog' as const,
      featureId: spec.id,
      groupId: spec.id,
      groupName: spec.title,
    }))
  )

  // Persist the link both directions so spec.content.linked_tasks reflects
  // the new task ids and the vault renders them under "Linked tasks".
  for (const task of newTasks) {
    specStorage.linkTask(projectId, spec.id, task.id)
  }

  // Completion marker — set ONLY after the full loop succeeds. A crash
  // before this point leaves marker=null and we recover on next entry.
  const fresh = specStorage.get(projectId, spec.id)
  if (fresh) {
    const withMarker: SpecContent = {
      ...fresh.content,
      tasks_created_at: getTimestamp(),
    }
    specStorage.updateContent(projectId, spec.id, withMarker)
  }

  // Mirror to memory event stream so `prjct context memory spec` and the
  // user's session both surface the breakdown event.
  await projectMemory.remember(projectPath, {
    type: 'spec',
    content: `Auto-breakdown: ${newTasks.length} tasks created from ${spec.title}${
      recoveredFromPartial ? ' (recovered from partial)' : ''
    }`,
    tags: {
      spec_id: spec.id,
      event: 'auto_breakdown',
      task_count: String(newTasks.length),
      ...(recoveredFromPartial ? { recovered: 'partial' } : {}),
    },
    source: spec.id,
  })

  return {
    taskIds: newTasks.map((t) => t.id),
    ...(recoveredFromPartial ? { recoveredFromPartial: true } : {}),
  }
}

/**
 * Acceptance criteria are often long sentences with rationale; the queue
 * description is meant to be glanceable. Cap at ~140 chars and append an
 * ellipsis so the user knows there's more in the body.
 */
function truncateForDescription(ac: string): string {
  const oneLine = ac.replace(/\s+/g, ' ').trim()
  if (oneLine.length <= 140) return oneLine
  return `${oneLine.slice(0, 137)}…`
}
