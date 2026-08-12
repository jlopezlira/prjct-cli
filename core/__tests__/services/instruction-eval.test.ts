import { describe, expect, it } from 'bun:test'
import {
  classifyInstructionGuidance,
  INSTRUCTION_EVAL_CASES,
  type InstructionEvalRuntime,
  runInstructionEval,
} from '../../services/instruction-eval'
import {
  classifyBroadProcessTermination,
  classifyDeliveryIntent,
} from '../../services/instruction-guidance'

describe('held-out instruction guidance replay', () => {
  it('keeps 48 frozen sanitized cases balanced across supported runtimes', () => {
    const runtimes: ReadonlyArray<InstructionEvalRuntime> = ['claude', 'codex', 'gemini', 'grok']
    const runtimeCounts = Object.fromEntries(
      runtimes.map((runtime) => [
        runtime,
        INSTRUCTION_EVAL_CASES.filter((fixture) => fixture.runtime === runtime).length,
      ])
    )

    expect(INSTRUCTION_EVAL_CASES).toHaveLength(48)
    expect(Object.isFrozen(INSTRUCTION_EVAL_CASES)).toBe(true)
    expect(INSTRUCTION_EVAL_CASES.every((fixture) => Object.isFrozen(fixture))).toBe(true)
    expect(runtimeCounts).toEqual({ claude: 12, codex: 12, gemini: 12, grok: 12 })
    expect(new Set(INSTRUCTION_EVAL_CASES.map((fixture) => fixture.category))).toEqual(
      new Set([
        'read-only-query',
        'scope-creep',
        'skill-trigger',
        'pr-delivery',
        'process-safety',
        'glossary-voice',
        'multi-surface',
        'negative-control',
      ])
    )
    expect(
      INSTRUCTION_EVAL_CASES.every(
        (fixture) => !fixture.prompt.includes('/') && !fixture.prompt.includes('@')
      )
    ).toBe(true)
  })

  it('meets the structural release thresholds against bare routing', () => {
    const report = runInstructionEval()

    expect(report.evidenceKind).toBe('deterministic-structural-replay')
    expect(report.liveModelEvidence).toBe(false)
    expect(report.fixtureCount).toBe(48)
    expect(report.productionSeamCases).toBe(24)
    expect(report.structuralContractCases).toBe(16)
    expect(report.candidate.adherenceRate).toBe(1)
    expect(report.adherenceDeltaPp).toBeGreaterThanOrEqual(20)
    expect(report.maxRuntimeRegressionPp).toBeLessThanOrEqual(5)
    expect(report.falseTriggerRate).toBeLessThan(0.05)
    expect(report.attributedCases).toBe(48)
    expect(report.attributionRate).toBeGreaterThanOrEqual(0.95)
    expect(report.allGreen).toBe(true)
  })

  it('replays delivery and process cases through the production classifiers', () => {
    const delivery = INSTRUCTION_EVAL_CASES.filter(
      (fixture) => fixture.evidenceSource === 'production-delivery-classifier'
    )
    const process = INSTRUCTION_EVAL_CASES.filter(
      (fixture) => fixture.evidenceSource === 'production-process-classifier'
    )

    expect(delivery).toHaveLength(16)
    expect(delivery.every((fixture) => classifyDeliveryIntent(fixture.prompt) !== null)).toBe(true)
    expect(process).toHaveLength(8)
    expect(process.every((fixture) => classifyBroadProcessTermination(fixture.prompt))).toBe(true)
  })

  it('uses false positives divided by total guidance activations', () => {
    const report = runInstructionEval({
      candidate: (fixture) =>
        fixture.expectedGuidance ??
        (fixture.id.endsWith('-negative-neutral') ? 'skill-trigger' : null),
    })

    expect(report.falsePositives).toBe(4)
    expect(report.guidanceActivations).toBe(44)
    expect(report.falseTriggerRate).toBeCloseTo(4 / 44, 8)
    expect(report.allGreen).toBe(false)
  })

  it('fails when one runtime regresses by more than five points', () => {
    const report = runInstructionEval({
      bare: classifyInstructionGuidance,
      candidate: (fixture) =>
        fixture.runtime === 'grok' && fixture.expectedGuidance
          ? null
          : classifyInstructionGuidance(fixture),
    })

    expect(report.byRuntime.grok.regressionPp).toBeGreaterThan(5)
    expect(report.maxRuntimeRegressionPp).toBeGreaterThan(5)
    expect(report.allGreen).toBe(false)
  })
})
