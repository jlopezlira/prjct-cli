/**
 * Model Schema — the Rig layer.
 *
 * ONE source of truth for "which models a rig has": PROVIDER_CAPABILITY_MODELS.
 * Roles map to vendor-agnostic capability classes; each rig maps classes to its
 * concrete models. Everything else (the Claude tier policy, the per-provider
 * model lists, the degradation fallback) is DERIVED from that map — so the
 * Brain is intercambiable and there is no second model system to drift from.
 *
 * @see PRJ-265
 */

import { z } from 'zod'

// ── The single source of truth ───────────────────────────────────────────────

/**
 * What a ROLE needs, independent of vendor:
 *   frontier → the best model (implementer writes code)
 *   balanced → strong judgment, cheaper (reviewers)
 *   fast     → routing/decomposition only (orchestrator)
 */
export type AgentCapabilityClass = 'frontier' | 'balanced' | 'fast'

/**
 * Per-provider model for each capability class, ordered best→fallback for
 * in-provider graceful degradation. THE single source for which models a rig
 * has. Multi-model IDEs (cursor/antigravity) pick the model in-app, so they
 * have no fixed map (model = null / supported = []).
 *
 * Capability chains ordered best→fallback for 2026-07 agent CLIs:
 * Claude Code, Codex CLI (TB leader), Gemini CLI, Grok Build, Kimi CLI.
 * Open multi-provider agents (OpenCode/Cline/Aider) use empty chains.
 */
export const PROVIDER_CAPABILITY_MODELS: Record<
  string,
  Record<AgentCapabilityClass, readonly string[]>
> = {
  claude: {
    // Claude Code still uses short aliases in Agent tool dispatches.
    frontier: ['opus', 'sonnet', 'haiku'],
    balanced: ['sonnet', 'haiku', 'opus'],
    fast: ['haiku', 'sonnet', 'opus'],
  },
  gemini: {
    frontier: ['3.1-pro', '2.5-pro', '2.5-flash', '2.0-flash'],
    balanced: ['2.5-flash', '3.1-pro', '2.5-pro', '2.0-flash'],
    fast: ['2.0-flash', '2.5-flash', '2.5-pro', '3.1-pro'],
  },
  openai: {
    frontier: ['gpt-5.5', 'o3', 'gpt-4.1', 'gpt-4o'],
    balanced: ['gpt-4.1', 'gpt-5.5', 'gpt-4o', 'gpt-4.1-mini'],
    fast: ['gpt-4.1-mini', 'gpt-4o-mini', 'gpt-4o', 'gpt-4.1'],
  },
  codex: {
    // Codex CLI default brain tracks OpenAI coding models (TB 2.1 leader).
    frontier: ['gpt-5.5', 'o3', 'gpt-4.1', 'gpt-4o'],
    balanced: ['gpt-4.1', 'gpt-5.5', 'gpt-4o', 'gpt-4.1-mini'],
    fast: ['gpt-4.1-mini', 'gpt-4o-mini', 'gpt-4o', 'gpt-4.1'],
  },
  xai: {
    frontier: ['grok-4', 'grok-3', 'grok-2', 'grok-2-mini'],
    balanced: ['grok-3', 'grok-4', 'grok-2', 'grok-2-mini'],
    fast: ['grok-2-mini', 'grok-2', 'grok-3', 'grok-4'],
  },
  grok: {
    frontier: ['grok-4', 'grok-3', 'grok-2', 'grok-2-mini'],
    balanced: ['grok-3', 'grok-4', 'grok-2', 'grok-2-mini'],
    fast: ['grok-2-mini', 'grok-2', 'grok-3', 'grok-4'],
  },
  kimi: {
    frontier: ['kimi-k2', 'kimi-latest', 'moonshot-v1-128k'],
    balanced: ['kimi-latest', 'moonshot-v1-128k', 'moonshot-v1-32k'],
    fast: ['moonshot-v1-32k', 'moonshot-v1-128k', 'kimi-latest'],
  },
  // Multi-provider open agents pick models in-app (empty = any model valid).
  opencode: { frontier: [], balanced: [], fast: [] },
  cline: { frontier: [], balanced: [], fast: [] },
  aider: { frontier: [], balanced: [], fast: [] },
}

const MIN_CLI_VERSIONS: Record<string, string> = {
  claude: '1.0.0',
  gemini: '1.0.0',
  openai: '0.1.0',
  codex: '0.1.0',
  xai: '0.1.0',
  grok: '0.1.0',
  kimi: '0.1.0',
} as const

// ── Roles → capability classes ───────────────────────────────────────────────

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

const ROLE_CAPABILITY_CLASS: Record<AgentRole, AgentCapabilityClass> = {
  implementer: 'frontier',
  orchestrator: 'fast',
  'strategic-review': 'balanced',
  'architecture-review': 'balanced',
  'design-review': 'balanced',
  'spec-review': 'balanced',
  review: 'balanced',
  security: 'balanced',
  investigate: 'balanced',
  reviewer: 'balanced',
}

/** Unknown roles default to the balanced (reviewer) class — never frontier. */
export function capabilityClassForRole(role: AgentRole): AgentCapabilityClass {
  return ROLE_CAPABILITY_CLASS[role] ?? 'balanced'
}

// ── Claude tier policy — DERIVED from the map ────────────────────────────────
// Claude is one rig; its top model per class + the class effort express the
// legacy per-role tier policy. Kept as derived views so existing callers/tests
// (getAgentModelPolicy, AGENT_MODEL_POLICY, renderModelDirective) are unchanged.

export type AgentModelTier = 'opus' | 'sonnet' | 'haiku'
export type AgentEffort = 'max' | 'decent'

export interface AgentModelPolicy {
  model: AgentModelTier
  effort: AgentEffort
}

const CLAUDE_MODELS = PROVIDER_CAPABILITY_MODELS.claude

/** Effort is a pure function of the class: only the frontier role gets max. */
function effortForClass(c: AgentCapabilityClass): AgentEffort {
  return c === 'frontier' ? 'max' : 'decent'
}

function policyForClass(c: AgentCapabilityClass): AgentModelPolicy {
  return { model: CLAUDE_MODELS[c][0] as AgentModelTier, effort: effortForClass(c) }
}

/**
 * Policy for a role on a Claude rig. Unknown roles → the balanced/reviewer
 * tier (never implementer/max). Derived from the capability map.
 */
export function getAgentModelPolicy(role: AgentRole): AgentModelPolicy {
  return policyForClass(capabilityClassForRole(role))
}

/** Derived view over every known role — kept for the export + direct tests. */
export const AGENT_MODEL_POLICY: Record<AgentRole, AgentModelPolicy> = Object.fromEntries(
  (Object.keys(ROLE_CAPABILITY_CLASS) as AgentRole[]).map((r) => [r, getAgentModelPolicy(r)])
) as Record<AgentRole, AgentModelPolicy>

/**
 * Rig sovereignty: graceful degradation when the preferred tier is throttled.
 * Derived from the Claude class chains (opus=frontier, sonnet=balanced,
 * haiku=fast), so there is no second fallback table to drift from.
 */
export const MODEL_TIER_FALLBACK: Record<AgentModelTier, readonly AgentModelTier[]> = {
  opus: CLAUDE_MODELS.frontier as readonly AgentModelTier[],
  sonnet: CLAUDE_MODELS.balanced as readonly AgentModelTier[],
  haiku: CLAUDE_MODELS.fast as readonly AgentModelTier[],
}

export interface ResolvedAgentModel extends AgentModelPolicy {
  /** The tier the role would use with no constraints. */
  preferred: AgentModelTier
  /** True when the preferred tier was unavailable and we degraded. */
  degraded: boolean
}

/**
 * Resolve the Claude tier a role should dispatch with, given the available
 * tiers. Walks the fallback chain; empty/unknown availability → preferred
 * (no degrade). Effort is never lowered by degradation.
 */
export function resolveAgentModel(
  role: AgentRole,
  available?: ReadonlySet<AgentModelTier>,
  classOverride?: AgentCapabilityClass
): ResolvedAgentModel {
  // classOverride lets a narrow SPECIALIST opt down to a cheaper class than its
  // role implies (a per-lens decision); unset → the role's policy (unchanged).
  const policy = classOverride ? policyForClass(classOverride) : getAgentModelPolicy(role)
  if (!available || available.size === 0) {
    return { ...policy, preferred: policy.model, degraded: false }
  }
  for (const tier of MODEL_TIER_FALLBACK[policy.model]) {
    if (available.has(tier)) {
      return { ...policy, model: tier, preferred: policy.model, degraded: tier !== policy.model }
    }
  }
  return { ...policy, preferred: policy.model, degraded: false }
}

// ── Provider-aware resolution (any rig) ──────────────────────────────────────

export interface ResolvedProviderModel {
  provider: string
  /** Concrete model id; null for multi-model rigs that select in-app. */
  model: string | null
  capability: AgentCapabilityClass
  degraded: boolean
}

/**
 * Resolve the concrete model a role should dispatch with on a given provider,
 * degrading within that provider when the preferred model is unavailable. The
 * sovereignty primitive: rent any brain, keep the same role policy.
 */
export function resolveProviderModel(
  role: AgentRole,
  provider: string,
  available?: ReadonlySet<string>,
  classOverride?: AgentCapabilityClass
): ResolvedProviderModel {
  const capability = classOverride ?? capabilityClassForRole(role)
  const chain = PROVIDER_CAPABILITY_MODELS[provider]?.[capability]
  if (!chain || chain.length === 0) {
    return { provider, model: null, capability, degraded: false }
  }
  const preferred = chain[0]
  if (!available || available.size === 0) {
    return { provider, model: preferred, capability, degraded: false }
  }
  for (const m of chain) {
    if (available.has(m)) return { provider, model: m, capability, degraded: m !== preferred }
  }
  return { provider, model: preferred, capability, degraded: false }
}

/**
 * Provider-aware dispatch directive: emit the concrete model for `role` on
 * `provider`, or — for a multi-model rig — name the capability and let the rig
 * pick. The same role policy renders correctly whatever brain is rented.
 */
export function renderModelDirectiveForProvider(
  role: AgentRole,
  provider: string,
  available?: ReadonlySet<string>,
  classOverride?: AgentCapabilityClass
): string {
  const r = resolveProviderModel(role, provider, available, classOverride)
  if (r.model === null) {
    const want =
      r.capability === 'frontier'
        ? 'your strongest model'
        : r.capability === 'fast'
          ? 'a fast, cheap model'
          : 'a balanced mid-tier model'
    return `Dispatch this ${role} as a ${r.capability}-class task — select ${want} on this rig (${provider}).`
  }
  const degraded = r.degraded
    ? ` (preferred ${r.capability} model unavailable — degraded to "${r.model}")`
    : ''
  return `Dispatch this ${role} on ${provider} with model "${r.model}" — a ${r.capability}-class task${degraded}.`
}

/**
 * One-line directive for a Claude-rig dispatch. Implementer keeps max; every
 * other role is told to go smaller + decent. Pass `available` to degrade
 * gracefully when a tier is throttled.
 */
export function renderModelDirective(
  role: AgentRole,
  available?: ReadonlySet<AgentModelTier>,
  classOverride?: AgentCapabilityClass
): string {
  const r = resolveAgentModel(role, available, classOverride)
  const isImplementer = r.preferred === 'opus' && r.effort === 'max'
  if (isImplementer && !r.degraded) {
    return 'Dispatch with the Agent tool using `model: "opus"` and full reasoning effort — this is the IMPLEMENTER; it writes code and needs the best model.'
  }
  if (isImplementer) {
    return `Dispatch with the Agent tool using \`model: "${r.model}"\` — this is the IMPLEMENTER, but its preferred tier \`opus\` is unavailable/throttled, so it is degraded to \`${r.model}\` at full effort. Compensate by leaning harder on verification (\`verify:\` gates) before ship.`
  }
  const base = `Dispatch with the Agent tool using \`model: "${r.model}"\` (NOT the parent's max model). Apply ${r.effort}, not exhaustive, effort — this is an orchestration/review role: return the verdict, don't over-deliberate. A smaller model at decent effort is correct here and far faster.`
  return r.degraded
    ? `${base} (Preferred tier \`${r.preferred}\` is unavailable/throttled — degraded to \`${r.model}\`.)`
    : base
}

// ── Model metadata + validation helpers ──────────────────────────────────────

/** Model metadata recorded with each analysis or task */
export const ModelMetadataSchema = z.object({
  /** Provider name (e.g., 'claude', 'gemini') */
  provider: z.string(),
  /** Model identifier (e.g., 'opus', 'sonnet', '2.5-pro') */
  model: z.string(),
  /** CLI version used */
  cliVersion: z.string().optional(),
  /** When this was recorded */
  recordedAt: z.string(),
})

export type ModelMetadata = z.infer<typeof ModelMetadataSchema>

/** Supported models for a provider — derived from the capability map. */
export function getSupportedModels(provider: string): readonly string[] {
  const map = PROVIDER_CAPABILITY_MODELS[provider]
  if (!map) return []
  return [...new Set([...map.frontier, ...map.balanced, ...map.fast])]
}

/** Default model for a provider — the balanced tier's top model. */
export function getDefaultModel(provider: string): string | null {
  return PROVIDER_CAPABILITY_MODELS[provider]?.balanced[0] ?? null
}

/** Check if a model is valid for a given provider */
export function isValidModelForProvider(provider: string, model: string): boolean {
  const supported = getSupportedModels(provider)
  if (supported.length === 0) return true // No restriction for multi-model IDEs
  return supported.includes(model)
}

/**
 * Compare semver versions. Returns:
 *  -1 if a < b
 *   0 if a == b
 *   1 if a > b
 */
export function compareSemver(a: string, b: string): -1 | 0 | 1 {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) {
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
