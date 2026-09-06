/**
 * Per-(model, task-class) harness policy: what the prompt/pre-search hooks do
 * for a turn once it is classified. A default table encodes the evidence
 * (silence where the agent alone wins, inject where knowledge lives in memory,
 * a ranked set for exploration, the verify contract for execution) and the
 * project can override it under `harness.policy` in global config.
 */

import type { TaskClass } from './task-class'

export type PromptLane = 'silent' | 'inject' | 'ranked'

/**
 * Every field here is CONSUMED by core/hooks/prompt.ts — a policy knob that
 * nothing reads is dead config. Pre-search judgment injection is governed by
 * `enforce.knowledgeFirst` (it has no turn class), not by this table.
 */
export interface HarnessPolicy {
  /** What the prompt hook's optional lane does this turn (`silent` drops it). */
  promptLane: PromptLane
  /** Cap on the optional lane's injected chars this turn (0 = no cap). */
  maxInjectChars: number
  /** Whether a VERIFY-class turn gets the repro→fix contract cue. */
  verifyContract: boolean
}

type ClassPolicies = Record<TaskClass | 'UNKNOWN', HarnessPolicy>

const BASELINE: ClassPolicies = {
  SELF_CONTAINED: { promptLane: 'silent', maxInjectChars: 0, verifyContract: false },
  PROJECT_KNOWLEDGE: { promptLane: 'inject', maxInjectChars: 600, verifyContract: false },
  EXPLORATION: { promptLane: 'ranked', maxInjectChars: 900, verifyContract: false },
  VERIFY: { promptLane: 'inject', maxInjectChars: 300, verifyContract: true },
  // UNKNOWN falls back to today's behaviour (inject), never to silence.
  UNKNOWN: { promptLane: 'inject', maxInjectChars: 600, verifyContract: false },
}

/**
 * Per-model overrides. A model that obeys "look it up" and pays a tax for it
 * (Grok) benefits most from silence on SELF_CONTAINED; a model with no tax
 * (haiku) is unaffected either way. The default table already silences
 * SELF_CONTAINED for everyone, so overrides here are deltas only.
 */
const MODEL_OVERRIDES: Record<string, Partial<ClassPolicies>> = {}

export interface PolicyConfig {
  harness?: {
    policy?: Partial<Record<TaskClass | 'UNKNOWN', Partial<HarnessPolicy>>>
  }
}

function matchModelKey(model: string): string | null {
  const m = model.toLowerCase()
  for (const key of Object.keys(MODEL_OVERRIDES)) {
    if (m.includes(key)) return key
  }
  return null
}

/**
 * Resolve the policy for a (model, class): baseline, then any model override,
 * then any per-project `harness.policy` override (user has the last word).
 */
export function resolvePolicy(
  model: string,
  cls: TaskClass | 'UNKNOWN',
  cfg?: PolicyConfig
): HarnessPolicy {
  const base = BASELINE[cls] ?? BASELINE.UNKNOWN
  const modelKey = matchModelKey(model)
  const modelOverride = modelKey ? (MODEL_OVERRIDES[modelKey]?.[cls] ?? {}) : {}
  const userOverride = cfg?.harness?.policy?.[cls] ?? {}
  return { ...base, ...modelOverride, ...userOverride }
}

/** Exposed for tests + `harness score` documentation. */
export const _baselinePolicies = BASELINE
