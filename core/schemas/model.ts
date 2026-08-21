/**
 * Model Schema — the Rig layer.
 *
 * prjct has NO opinion about which model runs a role. Every subagent inherits
 * the model of whatever rig the user is driving; prjct never names a model, a
 * tier, or a reasoning-effort level in anything it emits.
 *
 * This is deliberate and applies to every provider, not just Claude. The old
 * role→capability-class→model policy (implementer=frontier, everything else
 * downgraded at "decent" effort) capped 10 of 11 roles below the user's chosen
 * model and shipped "apply decent, not exhaustive, effort — don't
 * over-deliberate" into every non-implementer dispatch. That made the harness
 * systematically dumber than the brain the user was paying for, and the model
 * tables went stale the moment a vendor shipped a new family. Both problems
 * disappear by not having the policy at all: the user picks the model, prjct
 * stays out of it.
 *
 * What remains here is rig METADATA that has nothing to do with capping:
 * which provider CLIs prjct knows about, minimum CLI versions, and the
 * model-provenance stamp recorded alongside an analysis.
 */

import { z } from 'zod'

// ── Roles ────────────────────────────────────────────────────────────────────

/**
 * What an agent is doing in a multi-agent flow. Names a RESPONSIBILITY only —
 * it carries no model, tier, or effort. Do not reintroduce a role→model map.
 */
export type AgentRole =
  | 'implementer'
  | 'orchestrator'
  | 'strategic-review'
  | 'architecture-review'
  | 'design-review'
  | 'spec-review'
  | 'review'
  | 'security'
  | 'investigate'
  | 'reviewer'

// ── Rigs prjct knows how to drive ────────────────────────────────────────────

/**
 * Provider CLIs prjct can detect and dispatch on. Names only — prjct does not
 * track which models a rig offers, because it never selects one.
 */
export const SUPPORTED_PROVIDERS: readonly string[] = [
  'claude',
  'gemini',
  'openai',
  'codex',
  'xai',
  'grok',
  'kimi',
  'opencode',
  'cline',
  'aider',
]

const MIN_CLI_VERSIONS: Record<string, string> = {
  claude: '1.0.0',
  gemini: '1.0.0',
  openai: '0.1.0',
  codex: '0.1.0',
  xai: '0.1.0',
  grok: '0.1.0',
  kimi: '0.1.0',
} as const

// ── Model metadata (provenance, not policy) ──────────────────────────────────

/** Model metadata recorded with each analysis or task */
export const ModelMetadataSchema = z.object({
  /** Provider name (e.g., 'claude', 'gemini') */
  provider: z.string(),
  /** Model identifier, as reported by the rig (e.g., 'opus', '2.5-pro') */
  model: z.string(),
  /** CLI version used */
  cliVersion: z.string().optional(),
  /** When this was recorded */
  recordedAt: z.string(),
})

export type ModelMetadata = z.infer<typeof ModelMetadataSchema>

/**
 * Compare semver versions. Returns:
 *  -1 if a < b
 *   0 if a == b
 *   1 if a > b
 */
export function compareSemver(a: string, b: string): -1 | 0 | 1 {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (const i of [0, 1, 2]) {
    const va = pa[i] ?? 0
    const vb = pb[i] ?? 0
    if (va < vb) return -1
    if (va > vb) return 1
  }
  return 0
}

/** Check if a CLI version meets minimum requirements */
export function meetsMinVersion(provider: string, version: string): boolean {
  const min = MIN_CLI_VERSIONS[provider]
  if (!min) return true // No minimum defined
  return compareSemver(version, min) >= 0
}

/**
 * Check for model mismatch between analysis and current task.
 * Returns a warning message if the models differ, or null if they match.
 */
export function checkModelMismatch(
  analysisModel: ModelMetadata | undefined,
  taskModel: ModelMetadata | undefined
): string | null {
  if (!analysisModel || !taskModel) return null
  if (analysisModel.provider !== taskModel.provider || analysisModel.model !== taskModel.model) {
    return `⚠️ Model mismatch: analysis used ${analysisModel.provider}/${analysisModel.model}, but task is using ${taskModel.provider}/${taskModel.model}. Results may differ.`
  }
  return null
}
