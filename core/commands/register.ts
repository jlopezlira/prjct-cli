/**
 * Command Registration — drives the central commandRegistry off the
 * declarative routing table in `command-data.ts`.
 *
 * Adding a new verb is now a single edit in one file:
 *   1. Add (or update) the entry in command-data.ts
 *   2. Set its `routing: { group, method }` field
 *   3. (Optional) ensure the group instance is wired below
 *
 * Both `register.ts` AND `verb-names.ts` derive from the same table,
 * so the historical "triple-touch" (verb-names + register + commands)
 * is now a single touchpoint for the verb→handler mapping.
 */

import type { CommandRoutingGroup } from '../types/commands'
import { CATEGORIES, COMMANDS } from './command-data'
import { commandRegistry } from './registry'

// One lazy, memoized loader per command group. The class modules load on
// FIRST DISPATCH of one of their verbs via dynamic import — importing
// this module (which the daemon does at startup for its side effect)
// costs nothing beyond the manifest. Heavy groups (analysis drags in
// sync-service -> BM25 indexer, import-graph, skill generator) stay
// unparsed until a request actually needs them.
const loaderResetters: Array<() => void> = []

/** SIGHUP support: drop every memoized group instance so the next dispatch
 *  constructs fresh ones. Paired with commandRegistry.resetLazyResolutions(). */
export function resetGroupLoaders(): void {
  for (const reset of loaderResetters) reset()
}

function lazy(factory: () => Promise<object>): () => Promise<object> {
  const cache: { promise?: Promise<object> } = {}
  loaderResetters.push(() => {
    delete cache.promise
  })
  return () => {
    if (cache.promise) return cache.promise
    cache.promise = factory().catch((err) => {
      // A failed load must NOT be memoized: a transient import/constructor
      // error would otherwise poison every command in the group for the
      // daemon's lifetime. Clear the memo so the next dispatch retries.
      delete cache.promise
      throw err
    })
    return cache.promise
  }
}

/** Exported for manifest-completeness.test.ts, which instantiates every
 *  group and verifies each routing.method exists — the registration-time
 *  validation registerLazyMethod deferred to first dispatch. */
export const groupLoaders: Record<CommandRoutingGroup, () => Promise<object>> = {
  workflow: lazy(async () => new (await import('./workflow')).WorkflowCommands()),
  planning: lazy(async () => new (await import('./planning')).PlanningCommands()),
  shipping: lazy(async () => new (await import('./shipping')).ShippingCommands()),
  analysis: lazy(async () => new (await import('./analysis')).AnalysisCommands()),
  setup: lazy(async () => new (await import('./setup')).SetupCommands()),
  context: lazy(async () => new (await import('./context')).ContextCommands()),
  primitives: lazy(async () => new (await import('./primitives')).PrimitiveCommands()),
  seed: lazy(async () => new (await import('./seed')).SeedCommands()),
  install: lazy(async () => new (await import('./install')).InstallCommands()),
  capture: lazy(async () => new (await import('./capture')).CaptureCommands()),
  mcp: lazy(async () => new (await import('./mcp')).McpCommands()),
  team: lazy(async () => new (await import('./team')).TeamCommands()),
  config: lazy(async () => new (await import('./config')).ConfigCommands()),
  uninstall: lazy(async () => new (await import('./uninstall')).UninstallCommands()),
  update: lazy(async () => new (await import('./update')).UpdateCommands()),
  spec: lazy(async () => new (await import('./spec')).SpecCommands()),
  embeddings: lazy(async () => new (await import('./embeddings')).EmbeddingsCommands()),
  llm: lazy(async () => new (await import('./llm')).LlmCommands()),
  agent: lazy(async () => new (await import('./agent')).AgentCommands()),
  guard: lazy(async () => new (await import('./guard')).GuardCommands()),
  memoryExport: lazy(async () => new (await import('./memory-export')).MemoryExportCommands()),
  workflowsReference: lazy(
    async () => new (await import('./workflows-reference')).WorkflowsReferenceCommands()
  ),
  changelog: lazy(async () => new (await import('./changelog')).ChangelogCommands()),
  workGraph: lazy(async () => new (await import('./work-graph')).WorkGraphCommands()),
  ceremonies: lazy(async () => new (await import('./ceremonies')).CeremonyCommands()),
  lean: lazy(async () => new (await import('./lean')).LeanCommands()),
  cloud: lazy(async () => new (await import('./cloud')).CloudCommands()),
  tdd: lazy(async () => new (await import('./tdd')).TddCommands()),
  sdd: lazy(async () => new (await import('./sdd')).SddCommands()),
  notify: lazy(async () => new (await import('./notify')).NotifyCommands()),
  agents: lazy(async () => new (await import('./agents')).AgentsCommands()),
  product: lazy(async () => new (await import('./product')).ProductCommands()),
  eval: lazy(async () => new (await import('./eval')).EvalCommands()),
  judgment: lazy(async () => new (await import('./judgment')).JudgmentCommands()),
  code: lazy(async () => new (await import('./code')).CodeCommands()),
  qa: lazy(async () => new (await import('./qa')).QaCommands()),
  ab: lazy(async () => new (await import('./ab')).AbCommands()),
}

function registerCategories(): void {
  for (const [name, info] of Object.entries(CATEGORIES)) {
    commandRegistry.registerCategory(name, info)
  }
}

/**
 * Register every command whose metadata declares `routing`. Called
 * once on module import — this module is imported only for its
 * side effect (see `core/index.ts` and `core/daemon/daemon.ts`).
 */
function registerAllCommands(): void {
  // Skip if already registered
  if (commandRegistry.has('work')) return

  registerCategories()

  for (const meta of COMMANDS) {
    if (!meta.routing) continue
    // The registry resolves the instance + validates the method name at
    // CALL time (registerLazyMethod) — registration stays import-cheap and
    // the method-name contract is still enforced, just on first dispatch.
    commandRegistry.registerLazyMethod(
      meta.name,
      groupLoaders[meta.routing.group],
      meta.routing.method,
      meta
    )
  }
}

registerAllCommands()
