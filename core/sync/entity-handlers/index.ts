/**
 * Entity handler registry — single lookup table consumed by
 * `sync-manager.applyEvent`.
 *
 * Adding a new entity_type:
 *   1. Write `core/sync/entity-handlers/<entity>.ts` exporting an
 *      `EntityHandler`.
 *   2. Register it here. That's the entire diff.
 *
 * No edits to sync-manager are required — the `applyEvent` lookup
 * is generic over the registry.
 */

import { archivesHandler } from './archives'
import { customWorkflowsHandler } from './custom-workflows'
import { ideasHandler } from './ideas'
import { memoriesHandler } from './memories'
import { queueTasksHandler } from './queue-tasks'
import { shippedHandler } from './shipped'
import { specsHandler } from './specs'
import { tasksHandler } from './tasks'
import type { EntityHandler } from './types'
import { workflowRulesHandler } from './workflow-rules'

/**
 * Map of canonical `entity_type` → handler. The keys mirror the
 * cloud's table names (plural, snake_case).
 */
export const entityHandlers: Record<string, EntityHandler> = {
  memories: memoriesHandler,
  tasks: tasksHandler,
  ideas: ideasHandler,
  queue_tasks: queueTasksHandler,
  shipped_items: shippedHandler,
  shipped_features: shippedHandler,
  custom_workflows: customWorkflowsHandler,
  workflow_rules: workflowRulesHandler,
  specs: specsHandler,
  archives: archivesHandler,
}

/** Read-only list of supported entity types — useful for telemetry. */
export const SUPPORTED_ENTITY_TYPES = Object.keys(entityHandlers)

/**
 * Entity types the CLI receives over the wire but does NOT sync into
 * local storage — no storage module exists for them yet (deferred to
 * Phase 2 when these entities become first-class in the CLI).
 *
 * Phase 1.6 / B3: applyEvent emits a stable warn line when it sees one
 * of these instead of returning silently. Better surface than a no-op:
 * the user / operator knows events arrived but were intentionally
 * skipped. The exhaustiveness test in
 * `__tests__/sync/sync-manager-unknown-entity.test.ts` fails CI if a
 * new entity_type lands in the wire format that is neither handled
 * (above) nor explicitly listed here.
 */
export const UNKNOWN_ENTITY_TYPES: ReadonlySet<string> = new Set([
  'roadmap_features',
  'projects',
  'sessions',
  'agents',
  // Pushed by a producer but intentionally not applied locally yet:
  //  - subtasks / metrics_daily / velocity_sprints: no producer emits them
  //    today, but they're in the canonical table map — list them so the
  //    exhaustiveness test treats them as known-skipped, not a missed handler.
  'subtasks',
  'metrics_daily',
  'work_cost_snapshots',
  'inference_cost_snapshots',
  'velocity_sprints',
  // analysis: pushed to the cloud (for the web view) but NOT applied locally.
  // It's a derived, regenerable artifact (`prjct sync` rebuilds it) and its rich
  // camelCase schema doesn't round-trip cleanly through the snake_case wire, so
  // reconstructing it locally would be lossy. Specs (authored) DO apply.
  'analysis',
])

export type { EntityHandler } from './types'
