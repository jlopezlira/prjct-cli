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
 *   - Marker null    → (re)breakdown, converging by RECONCILE: for each
 *                      AC, adopt the existing queue row with
 *                      `featureId = spec.id` and `body === ac` when one
 *                      exists (re-linked if needed, never recreated),
 *                      otherwise create a fresh task. Orphaned rows
 *                      (edited/removed AC text) are LEFT in the queue —
 *                      visible, user-disposable, never silently deleted.
 *                      Reconcile preserves the completion state of
 *                      surviving tasks and closes the wipe-and-rerun
 *                      orphan/duplicate window (the spec row + marker
 *                      live in `specs`, queue rows in `queue_tasks`, and
 *                      the loop publishes events between writes, so the
 *                      two stores cannot share a transaction). The
 *                      marker is set ONLY after the loop completes, so
 *                      any crash leaves marker=null and the next caller
 *                      re-enters and converges by adoption.
 *
 * See spec a50b32d1 AC #13.
 */
import { projectMemory } from '../memory/project-memory'
import { queueStorage } from '../storage/queue-storage'
import { specStorage } from '../storage/spec-storage'
import type { Spec, SpecContent } from '../types/spec'
import { getTimestamp } from '../utils/date-helper'

export interface BreakdownResult {
  /**
   * Task ids now linked to the spec, in AC order — adopted survivors
   * first-class alongside newly created ones. Empty when breakdown is a
   * no-op.
   */
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
  // means a previous attempt crashed mid-loop. Converge by adoption below.
  const recoveredFromPartial = spec.content.linked_tasks.length > 0

  // Reconcile against existing queue rows: an AC whose full text exactly
  // matches a surviving row's `body` (same featureId) ADOPTS that row —
  // preserving its id and completion state — instead of recreating it.
  // Each row is adopted at most once so duplicate AC texts still get
  // distinct tasks. Rows no AC matches stay in the queue untouched.
  const existing = (await queueStorage.getTasks(projectId)).filter((t) => t.featureId === spec.id)
  const adoptedIds = new Set<string>()
  const matches = acs.map((ac) => {
    const hit = existing.find((t) => t.body === ac && !adoptedIds.has(t.id))
    if (hit) adoptedIds.add(hit.id)
    return hit ?? null
  })

  const missing = acs.map((ac, i) => ({ ac, i })).filter(({ i }) => matches[i] === null)
  const created =
    missing.length > 0
      ? await queueStorage.addTasks(
          projectId,
          missing.map(({ ac }) => ({
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
      : []
  const createdIdByIndex = new Map(missing.map(({ i }, k) => [i, created[k].id]))
  const taskIds = acs.map((_, i) => matches[i]?.id ?? (createdIdByIndex.get(i) as string))

  // Persist the link both directions so spec.content.linked_tasks reflects
  // the task ids and the vault renders them under "Linked tasks". linkTask
  // is idempotent: adopted rows keep their link, truncated links heal.
  for (const taskId of taskIds) {
    specStorage.linkTask(projectId, spec.id, taskId)
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
  const adoptedCount = taskIds.length - created.length
  await projectMemory.remember(projectPath, {
    type: 'spec',
    content: `Auto-breakdown: ${created.length} tasks created${
      adoptedCount > 0 ? `, ${adoptedCount} adopted` : ''
    } from ${spec.title}${recoveredFromPartial ? ' (recovered from partial)' : ''}`,
    tags: {
      spec_id: spec.id,
      event: 'auto_breakdown',
      task_count: String(taskIds.length),
      ...(recoveredFromPartial ? { recovered: 'partial' } : {}),
    },
    source: spec.id,
  })

  return {
    taskIds,
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
