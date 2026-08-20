/**
 * Canonical entity ↔ storage-table mapping — the SINGLE source of truth
 * shared by the push mapper (`event-mapper`) and the pull normalizer
 * (`sync-manager.normalizeEventShape`).
 *
 * Producers historically emitted a MIX of names: singular (`idea`), plural
 * (`memories`), and variants (`queue_task`). The old push mapper keyed only
 * off the legacy `type` split through a partial table, so `memories`,
 * `queue_task`, `custom_workflows`, `workflow_rules` and `archives` were
 * silently dropped on the wire. This collapses every producer name to one
 * canonical storage-table name so nothing is lost.
 *
 * NOTE: these are STORAGE table names, NOT a backend/engine. The CLI knows
 * only "a storage API at api.prjct.app"; the table vocabulary is the wire
 * contract and reveals nothing about how the cloud stores it.
 */

/** Producer `entityType` (or legacy `entity` from a `type` split) → table. */
const TABLE_BY_ENTITY: Record<string, string> = {
  // Already-canonical pass-throughs.
  memories: 'memories',
  tasks: 'tasks',
  subtasks: 'subtasks',
  ideas: 'ideas',
  queue_tasks: 'queue_tasks',
  custom_workflows: 'custom_workflows',
  workflow_rules: 'workflow_rules',
  archives: 'archives',
  shipped_items: 'shipped_items',
  shipped_features: 'shipped_features',
  metrics_daily: 'metrics_daily',
  work_cost_snapshots: 'work_cost_snapshots',
  inference_cost_snapshots: 'inference_cost_snapshots',
  velocity_sprints: 'velocity_sprints',
  // Project-understanding artifacts: the sealed analysis (patterns, anti-
  // patterns, tech-debt, risk-areas, insights) and SDD specs. Previously
  // unmapped, so their events were silently dropped on the wire.
  analysis: 'analysis',
  specs: 'specs',
  // Producer aliases (singular / variant) → canonical table.
  memory: 'memories',
  memory_entry: 'memories',
  task: 'tasks',
  paused_task: 'tasks',
  subtask: 'subtasks',
  idea: 'ideas',
  queue: 'queue_tasks',
  queue_task: 'queue_tasks',
  shipped: 'shipped_items',
  feature: 'roadmap_features',
  workflow: 'custom_workflows',
  workflow_rule: 'workflow_rules',
  metric: 'metrics_daily',
  work_cost_snapshot: 'work_cost_snapshots',
  inference_cost_snapshot: 'inference_cost_snapshots',
  velocity: 'velocity_sprints',
  spec: 'specs',
  project: 'projects',
  session: 'sessions',
  agent: 'agents',
}

/**
 * Resolve a producer entity name (or legacy `entity` token) to its canonical
 * storage table. Returns `undefined` for names we don't recognize — the push
 * mapper drops those rather than send junk over the wire.
 */
export function toCloudTable(entity: string | undefined | null): string | undefined {
  if (!entity) return undefined
  return TABLE_BY_ENTITY[entity]
}

/**
 * User-facing sync groups for the per-project `cloud.include` whitelist.
 * Several storage tables roll up into one toggle (a task and its subtasks +
 * queue move together; ships cover both append-only tables).
 */
export type IncludeGroup =
  | 'memories'
  | 'tasks'
  | 'ideas'
  | 'shipped'
  | 'workflows'
  | 'metrics'
  | 'archives'
  | 'user_prompts'
  | 'agent_sessions'
  | 'analysis'
  | 'specs'

const GROUP_BY_TABLE: Record<string, IncludeGroup> = {
  memories: 'memories',
  tasks: 'tasks',
  subtasks: 'tasks',
  queue_tasks: 'tasks',
  ideas: 'ideas',
  shipped_items: 'shipped',
  shipped_features: 'shipped',
  custom_workflows: 'workflows',
  workflow_rules: 'workflows',
  metrics_daily: 'metrics',
  work_cost_snapshots: 'metrics',
  inference_cost_snapshots: 'metrics',
  velocity_sprints: 'metrics',
  archives: 'archives',
  analysis: 'analysis',
  specs: 'specs',
}

/**
 * Defaults when a project is linked but `cloud.include` is unset: the
 * cross-device-valuable groups are ON; the privacy-sensitive ones
 * (raw prompts, agent sessions, heavy analysis) are OFF until opted in.
 */
export const DEFAULT_INCLUDE: Record<IncludeGroup, boolean> = {
  memories: true,
  tasks: true,
  ideas: true,
  shipped: true,
  workflows: true,
  // `metrics` now includes aggregated cost/context snapshots. It is default-on
  // because it contains rolled-up analytics, not raw prompts or transcripts.
  metrics: true,
  // Archives are now bidirectional (handler + full entity_data payload), so
  // they round-trip like any other authored record. Default-on to honor the
  // "every entity syncs to every machine" directive — flip to false per
  // project via cloud.include if archived volume becomes noise.
  archives: true,
  // Raw prompts + agent sessions stay opt-out by default (privacy-sensitive,
  // heavy). Analysis + specs are project-understanding knowledge — on by
  // default so the cloud vault is a complete picture of the project.
  user_prompts: false,
  agent_sessions: false,
  analysis: true,
  specs: true,
}

/**
 * Whether a storage table should sync given the project's `include` overrides.
 * Unknown-but-mapped tables (no group) default to allowed — the server still
 * authorizes the write; this filter is only the client-side opt-out.
 */
export function isTableIncluded(table: string, include?: Record<string, boolean>): boolean {
  const group = GROUP_BY_TABLE[table]
  if (!group) return true
  const merged = { ...DEFAULT_INCLUDE, ...(include ?? {}) }
  return merged[group] !== false
}

/** All include-group keys — surfaced by `prjct cloud status`. */
export const INCLUDE_GROUPS = Object.keys(DEFAULT_INCLUDE) as IncludeGroup[]
