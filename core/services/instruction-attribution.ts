import { detectRuntimeAgent, KNOWN_AGENTS } from './agent-identity'

const MAX_RUNTIME_LENGTH = 32

/**
 * Runtime identity for instruction telemetry. Hook host is the strongest
 * signal because a machine can have several agent CLIs installed at once.
 * Unknown stays unknown; never derive a model name from the runtime.
 *
 * `hookHost` is validated against the same known-runtime set
 * `detectRuntimeAgent()` uses (rather than accepted as an arbitrary,
 * unsanitized string) — `PRJCT_HOOK_HOST` is also read independently by
 * `core/hooks/_shared.ts`'s `currentHookHost()` for output-shape adaptation,
 * and an unvalidated or garbage value here would silently pollute the
 * per-runtime failure groupings with a label no other part of the system
 * would ever produce.
 */
export function resolveInstructionRuntime(
  evidence: { hookHost?: string | null; detectedRuntime?: string } = {}
): string {
  const rawHookHost =
    evidence.hookHost === undefined ? process.env.PRJCT_HOOK_HOST : evidence.hookHost
  const hookHost = rawHookHost?.trim().toLowerCase().slice(0, MAX_RUNTIME_LENGTH)
  if (hookHost && KNOWN_AGENTS.has(hookHost)) return hookHost
  return evidence.detectedRuntime ?? detectRuntimeAgent()
}
