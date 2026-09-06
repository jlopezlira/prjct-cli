/**
 * Per-(model, task-class) harness policy: what the prompt/pre-search hooks do
 * for a turn once it is classified. A default table encodes the evidence
 * (silence where the agent alone wins, inject where knowledge lives in memory,
 * a ranked set for exploration, the verify contract for execution) and the
 * project can override it under `harness.policy` in global config.
 */

import type { TaskClass } from './task-class'

export type PromptLane = 'silent' | 'inject' | 'ranked'
export type PreSearchMode = 'inject' | 'allow' | 'deny'

export interface HarnessPolicy {
  /** What the prompt hook's optional lanes do this turn. */
  promptLane: PromptLane
  /** Cap on injected additionalContext chars. */
  maxInjectChars: number
  /** What pre-search does with recorded judgment about a grepped token. */
  preSearch: PreSearchMode
  /** Whether a VERIFY-class turn gets the repro→fix contract injected. */
  verifyContract: boolean
}

type ClassPolicies = Record<TaskClass | 'UNKNOWN', HarnessPolicy>

const BASELINE: ClassPolicies = {
  SELF_CONTAINED: {
    promptLane: 'silent',
    maxInjectChars: 0,
    preSearch: 'allow',
    verifyContract: false,
  },
  PROJECT_KNOWLEDGE: {
    promptLane: 'inject',
    maxInjectChars: 600,
    preSearch: 'inject',
    verifyContract: false,
  },
  EXPLORATION: {
    promptLane: 'ranked',
    maxInjectChars: 900,
    preSearch: 'inject',
    verifyContract: false,
  },
  VERIFY: { promptLane: 'inject', maxInjectChars: 300, preSearch: 'inject', verifyContract: true },
  // UNKNOWN falls back to today's behaviour (inject), never to silence.
  UNKNOWN: {
    promptLane: 'inject',
    maxInjectChars: 600,
    preSearch: 'inject',
    verifyContract: false,
  },
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
