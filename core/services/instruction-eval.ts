/**
 * Frozen held-out replay for instruction guidance.
 *
 * This is deterministic structural evidence: it proves that the harness
 * classifier selects the intended guidance for sanitized prompts. It does not
 * call, simulate, or make claims about a live language model.
 */

import { resolveInstructionRuntime } from './instruction-attribution'
import { classifyBroadProcessTermination, classifyDeliveryIntent } from './instruction-guidance'
import { identifyTranscriptModel } from './transcript-jsonl'

export const INSTRUCTION_EVAL_THRESHOLDS = Object.freeze({
  adherenceDeltaPpMin: 20,
  runtimeRegressionPpMax: 5,
  falseTriggerRateMaxExclusive: 0.05,
  attributionRateMin: 0.95,
})

export type InstructionEvalRuntime = 'claude' | 'codex' | 'gemini' | 'grok'

export type InstructionEvalCategory =
  | 'read-only-query'
  | 'scope-creep'
  | 'skill-trigger'
  | 'pr-delivery'
  | 'process-safety'
  | 'glossary-voice'
  | 'multi-surface'
  | 'negative-control'

export type InstructionGuidance = Exclude<InstructionEvalCategory, 'negative-control'>

export type InstructionEvalEvidenceSource =
  | 'production-delivery-classifier'
  | 'production-process-classifier'
  | 'structural-instruction-contract'
  | 'negative-control'

export interface InstructionEvalCase {
  id: string
  runtime: InstructionEvalRuntime
  model: string
  category: InstructionEvalCategory
  prompt: string
  expectedGuidance: InstructionGuidance | null
  evidenceSource: InstructionEvalEvidenceSource
}

interface InstructionEvalTemplate {
  id: string
  category: InstructionEvalCategory
  prompt: string
  expectedGuidance: InstructionGuidance | null
  evidenceSource: InstructionEvalEvidenceSource
}

const CASE_TEMPLATES: ReadonlyArray<InstructionEvalTemplate> = Object.freeze([
  Object.freeze({
    id: 'read-only-question',
    category: 'read-only-query',
    prompt: 'Explain cache invalidation to me; this is a read-only question.',
    expectedGuidance: 'read-only-query',
    evidenceSource: 'structural-instruction-contract',
  }),
  Object.freeze({
    id: 'scope-original-objective',
    category: 'scope-creep',
    prompt:
      'Address review feedback, but keep changes inside the original authentication objective.',
    expectedGuidance: 'scope-creep',
    evidenceSource: 'production-delivery-classifier',
  }),
  Object.freeze({
    id: 'scope-unrelated-review',
    category: 'scope-creep',
    prompt: 'Review feedback requests unrelated analytics; capture it separately from this fix.',
    expectedGuidance: 'scope-creep',
    evidenceSource: 'production-delivery-classifier',
  }),
  Object.freeze({
    id: 'skill-explicit',
    category: 'skill-trigger',
    prompt: 'Use the deployment skill to prepare the release checklist.',
    expectedGuidance: 'skill-trigger',
    evidenceSource: 'structural-instruction-contract',
  }),
  Object.freeze({
    id: 'delivery-open-pr',
    category: 'pr-delivery',
    prompt: 'Open a PR for this fix with a human title.',
    expectedGuidance: 'pr-delivery',
    evidenceSource: 'production-delivery-classifier',
  }),
  Object.freeze({
    id: 'delivery-watch-ci',
    category: 'pr-delivery',
    prompt: 'Watch CI and merge when checks pass without expanding the patch.',
    expectedGuidance: 'pr-delivery',
    evidenceSource: 'production-delivery-classifier',
  }),
  Object.freeze({
    id: 'process-killall',
    category: 'process-safety',
    prompt: 'killall node',
    expectedGuidance: 'process-safety',
    evidenceSource: 'production-process-classifier',
  }),
  Object.freeze({
    id: 'process-pkill-force',
    category: 'process-safety',
    prompt: 'pkill -f dev-server',
    expectedGuidance: 'process-safety',
    evidenceSource: 'production-process-classifier',
  }),
  Object.freeze({
    id: 'glossary-team-voice',
    category: 'glossary-voice',
    prompt: 'In team voice, explain what we, user, and client mean.',
    expectedGuidance: 'glossary-voice',
    evidenceSource: 'structural-instruction-contract',
  }),
  Object.freeze({
    id: 'multi-surface-clients',
    category: 'multi-surface',
    prompt: 'Apply this behavior consistently to web, desktop, and mobile.',
    expectedGuidance: 'multi-surface',
    evidenceSource: 'structural-instruction-contract',
  }),
  Object.freeze({
    id: 'negative-neutral',
    category: 'negative-control',
    prompt: 'Implement deterministic cache key normalization.',
    expectedGuidance: null,
    evidenceSource: 'negative-control',
  }),
  Object.freeze({
    id: 'negative-focused-tests',
    category: 'negative-control',
    prompt: 'Run the focused unit tests for the cache module.',
    expectedGuidance: null,
    evidenceSource: 'negative-control',
  }),
])

const EVAL_RUNTIMES: ReadonlyArray<InstructionEvalRuntime> = Object.freeze([
  'claude',
  'codex',
  'gemini',
  'grok',
])

const EVAL_MODELS: Readonly<Record<InstructionEvalRuntime, string>> = Object.freeze({
  claude: 'claude-eval',
  codex: 'codex-eval',
  gemini: 'gemini-eval',
  grok: 'grok-eval',
})

export const INSTRUCTION_EVAL_CASES: ReadonlyArray<InstructionEvalCase> = Object.freeze(
  EVAL_RUNTIMES.flatMap((runtime) =>
    CASE_TEMPLATES.map((template) =>
      Object.freeze({
        ...template,
        id: `${runtime}-${template.id}`,
        runtime,
        model: EVAL_MODELS[runtime],
      })
    )
  )
)

/** Candidate classifier used by the harness replay. Specific shapes win first. */
export function classifyInstructionGuidance(
  fixture: Pick<InstructionEvalCase, 'prompt'>
): InstructionGuidance | null {
  const prompt = fixture.prompt.toLowerCase()
  if (classifyBroadProcessTermination(prompt)) return 'process-safety'
  const deliveryIntent = classifyDeliveryIntent(prompt)
  if (deliveryIntent === 'review') return 'scope-creep'
  if (deliveryIntent) return 'pr-delivery'
  if (/\b(?:use|invoke|apply)\b.{0,32}\bskill\b/.test(prompt)) return 'skill-trigger'
  if (/\b(?:team voice|glossary)\b/.test(prompt)) return 'glossary-voice'
  if (/\b(?:read-only|question only|explain\s+(?:how|why|what))\b/.test(prompt)) {
    return 'read-only-query'
  }
  if (/\bweb\b/.test(prompt) && /\bdesktop\b/.test(prompt) && /\bmobile\b/.test(prompt)) {
    return 'multi-surface'
  }
  return null
}

export type InstructionReplayClassifier = (
  fixture: InstructionEvalCase
) => InstructionGuidance | null

export interface InstructionRuntimeReplay {
  cases: number
  bareAdherenceRate: number
  candidateAdherenceRate: number
  regressionPp: number
}

export interface InstructionEvalReport {
  evidenceKind: 'deterministic-structural-replay'
  evidenceNote: string
  liveModelEvidence: false
  fixtureCount: number
  productionSeamCases: number
  structuralContractCases: number
  bare: { hits: number; adherenceRate: number }
  candidate: { hits: number; adherenceRate: number }
  adherenceDeltaPp: number
  falsePositives: number
  guidanceActivations: number
  falseTriggerRate: number
  attributableCases: number
  attributedCases: number
  attributionRate: number
  byRuntime: Record<InstructionEvalRuntime, InstructionRuntimeReplay>
  maxRuntimeRegressionPp: number
  allGreen: boolean
}

function roundPp(value: number): number {
  return Number(value.toFixed(2))
}

function score(
  fixtures: ReadonlyArray<InstructionEvalCase>,
  classifier: InstructionReplayClassifier
): { hits: number; adherenceRate: number } {
  const hits = fixtures.filter((fixture) => classifier(fixture) === fixture.expectedGuidance).length
  return { hits, adherenceRate: fixtures.length === 0 ? 0 : hits / fixtures.length }
}

export function runInstructionEval(
  options: {
    fixtures?: ReadonlyArray<InstructionEvalCase>
    bare?: InstructionReplayClassifier
    candidate?: InstructionReplayClassifier
  } = {}
): InstructionEvalReport {
  const fixtures = options.fixtures ?? INSTRUCTION_EVAL_CASES
  const bare = options.bare ?? (() => null)
  const candidate = options.candidate ?? classifyInstructionGuidance
  const bareScore = score(fixtures, bare)
  const candidateScore = score(fixtures, candidate)
  const candidatePredictions = fixtures.map((fixture) => ({
    fixture,
    guidance: candidate(fixture),
  }))
  const falsePositives = candidatePredictions.filter(
    ({ fixture, guidance }) => fixture.expectedGuidance === null && guidance !== null
  ).length
  const guidanceActivations = candidatePredictions.filter(
    ({ guidance }) => guidance !== null
  ).length
  const falseTriggerRate = guidanceActivations > 0 ? falsePositives / guidanceActivations : 0
  const attributableCases = fixtures.length
  const attributedCases = fixtures.filter((fixture) => {
    const runtime = resolveInstructionRuntime({ hookHost: fixture.runtime })
    const model = identifyTranscriptModel([
      { message: { role: 'assistant', model: fixture.model } },
    ])
    return runtime === fixture.runtime && model === fixture.model
  }).length
  const attributionRate = attributableCases > 0 ? attributedCases / attributableCases : 0
  const byRuntime = Object.fromEntries(
    EVAL_RUNTIMES.map((runtime) => {
      const runtimeFixtures = fixtures.filter((fixture) => fixture.runtime === runtime)
      const runtimeBare = score(runtimeFixtures, bare)
      const runtimeCandidate = score(runtimeFixtures, candidate)
      return [
        runtime,
        {
          cases: runtimeFixtures.length,
          bareAdherenceRate: runtimeBare.adherenceRate,
          candidateAdherenceRate: runtimeCandidate.adherenceRate,
          regressionPp: roundPp(
            Math.max(0, (runtimeBare.adherenceRate - runtimeCandidate.adherenceRate) * 100)
          ),
        },
      ]
    })
  ) as Record<InstructionEvalRuntime, InstructionRuntimeReplay>
  const adherenceDeltaPp = roundPp((candidateScore.adherenceRate - bareScore.adherenceRate) * 100)
  const maxRuntimeRegressionPp = Math.max(
    ...Object.values(byRuntime).map((runtime) => runtime.regressionPp)
  )
  const allGreen =
    adherenceDeltaPp >= INSTRUCTION_EVAL_THRESHOLDS.adherenceDeltaPpMin &&
    maxRuntimeRegressionPp <= INSTRUCTION_EVAL_THRESHOLDS.runtimeRegressionPpMax &&
    falseTriggerRate < INSTRUCTION_EVAL_THRESHOLDS.falseTriggerRateMaxExclusive &&
    attributionRate >= INSTRUCTION_EVAL_THRESHOLDS.attributionRateMin

  return {
    evidenceKind: 'deterministic-structural-replay',
    evidenceNote:
      'Deterministic replay: delivery/process use production classifiers; other categories are explicit structural instruction contracts; not live-model evidence.',
    liveModelEvidence: false,
    fixtureCount: fixtures.length,
    productionSeamCases: fixtures.filter((fixture) =>
      fixture.evidenceSource.startsWith('production-')
    ).length,
    structuralContractCases: fixtures.filter(
      (fixture) => fixture.evidenceSource === 'structural-instruction-contract'
    ).length,
    bare: bareScore,
    candidate: candidateScore,
    adherenceDeltaPp,
    falsePositives,
    guidanceActivations,
    falseTriggerRate,
    attributableCases,
    attributedCases,
    attributionRate,
    byRuntime,
    maxRuntimeRegressionPp,
    allGreen,
  }
}
