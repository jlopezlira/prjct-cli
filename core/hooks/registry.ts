/**
 * Hook runner registry — the single source of truth mapping a Claude Code
 * hook subcommand name to its runner.
 *
 * Both entry paths consume this:
 *   - the cold path (`bin/prjct.ts` → `prjct hook <name>`), and
 *   - the warm path (the daemon, which runs the same runner with a
 *     `HookIo` bridge so the hook body never touches process stdin/stdout).
 *
 * Runners load LAZILY per event. Stop (and its embeddings/transcript graph)
 * must not be parsed for a prompt/pre-edit cold spawn — that was pure tax.
 * After first load the module is cached by the runtime import map.
 */

import type { HookIo } from './_runner'

/** A hook runner: runs the hook for `projectPath`. With `io` it runs in
 *  daemon (warm) mode; without, in process (cold) mode. */
export type HookRunner = (projectPath: string, io?: HookIo) => Promise<void>

type HookLoader = () => Promise<{ default?: HookRunner } | Record<string, HookRunner | unknown>>

/**
 * Map subcommand → dynamic import of the runner module + export name.
 * Keep export names stable so cold-entry and daemon never diverge.
 */
const HOOK_LOADERS: Record<string, { load: HookLoader; exportName: string }> = {
  'session-start': {
    load: () => import('./session-start'),
    exportName: 'runSessionStartHook',
  },
  prompt: {
    load: () => import('./prompt'),
    exportName: 'runPromptHook',
  },
  'pre-commit': {
    load: () => import('./pre-commit'),
    exportName: 'runPreCommitHook',
  },
  'pre-secrets': {
    load: () => import('./pre-secrets'),
    exportName: 'runPreSecretsHook',
  },
  'pre-package': {
    load: () => import('./pre-package'),
    exportName: 'runPrePackageHook',
  },
  'pre-edit': {
    load: () => import('./pre-edit'),
    exportName: 'runPreEditHook',
  },
  'pre-search': {
    load: () => import('./pre-search'),
    exportName: 'runPreSearchHook',
  },
  'post-edit': {
    load: () => import('./post-edit'),
    exportName: 'runPostEditHook',
  },
  stop: {
    load: () => import('./stop'),
    exportName: 'runStopHook',
  },
  'subagent-start': {
    load: () => import('./subagent-start'),
    exportName: 'runSubagentStartHook',
  },
  'subagent-stop': {
    load: () => import('./subagent-stop'),
    exportName: 'runSubagentStopHook',
  },
  notification: {
    load: () => import('./notification'),
    exportName: 'runNotificationHook',
  },
  'cwd-changed': {
    load: () => import('./cwd-changed'),
    exportName: 'runCwdChangedHook',
  },
}

const runnerCache = new Map<string, HookRunner>()

async function resolveRunner(name: string): Promise<HookRunner | undefined> {
  const cached = runnerCache.get(name)
  if (cached) return cached
  const entry = HOOK_LOADERS[name]
  if (!entry) return undefined
  const mod = (await entry.load()) as Record<string, HookRunner>
  const runner = mod[entry.exportName]
  if (typeof runner !== 'function') return undefined
  runnerCache.set(name, runner)
  return runner
}

/**
 * Synchronous map for callers that only need *names* (help, installers).
 * Values are thin wrappers that lazy-load on first invoke.
 */
export const HOOK_RUNNERS: Record<string, HookRunner> = Object.fromEntries(
  Object.keys(HOOK_LOADERS).map((name) => [
    name,
    async (projectPath: string, io?: HookIo) => {
      const runner = await resolveRunner(name)
      if (!runner) throw new Error(`Hook runner missing export for '${name}'`)
      return runner(projectPath, io)
    },
  ])
)

export function getHookRunner(name: string | undefined): HookRunner | undefined {
  return name && HOOK_LOADERS[name] ? HOOK_RUNNERS[name] : undefined
}
