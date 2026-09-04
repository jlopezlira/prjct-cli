import { z } from 'zod'

const RunSchema = z.object({
  taskId: z.string().min(1),
  category: z.string().min(1),
  taskHash: z.string().min(1),
  repetition: z.number().int().min(0),
  arm: z.enum(['baseline', 'harness']),
  model: z.string().min(1),
  effort: z.string().min(1),
  configurationHash: z.string().min(1),
  heldOut: z.literal(true),
  grader: z.literal('independent'),
  evidencePath: z.string().min(1),
  completed: z.boolean(),
  escapedCriticalRegressions: z.number().int().nonnegative(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  contextTokens: z.number().int().nonnegative(),
  latencyMs: z.number().finite().nonnegative(),
  resumed: z.boolean(),
})
export const OutcomeRunsSchema = z.array(RunSchema).max(100_000)
export type OutcomeRun = z.infer<typeof RunSchema>
export interface OutcomeEvidenceReport {
  status: 'missing' | 'invalid' | 'insufficient' | 'qualified'
  qualified: boolean
  reason: string
  tasks: number
  pairs: number
  baselineCompletion: number | null
  harnessCompletion: number | null
  baselineTokens: number | null
  harnessTokens: number | null
  baselineLatencyMs: number | null
  harnessLatencyMs: number | null
}

/** Imported evidence is attributed to its grader; fixtures cannot unlock quality. */
export function evaluateOutcomeEvidence(input?: unknown): OutcomeEvidenceReport {
  const empty: OutcomeEvidenceReport = {
    status: 'missing',
    qualified: false,
    reason: 'Representative same-model paired outcomes have not been supplied.',
    tasks: 0,
    pairs: 0,
    baselineCompletion: null,
    harnessCompletion: null,
    baselineTokens: null,
    harnessTokens: null,
    baselineLatencyMs: null,
    harnessLatencyMs: null,
  }
  if (input === undefined) return empty
  const parsed = OutcomeRunsSchema.safeParse(input)
  if (!parsed.success)
    return {
      ...empty,
      status: 'invalid',
      reason:
        'Invalid paired-run evidence: model/configuration, independent grading, tokens, latency and artifacts are required.',
    }
  const runs = parsed.data
  if (!runs.length) return empty
  const groups = new Map<string, OutcomeRun[]>()
  for (const run of runs) {
    const key = JSON.stringify([run.taskId, run.repetition])
    const group = groups.get(key) ?? []
    group.push(run)
    groups.set(key, group)
  }
  const valid = [...groups.values()].every(
    (pair) =>
      pair.length === 2 &&
      pair[0]!.arm !== pair[1]!.arm &&
      ['model', 'effort', 'configurationHash', 'taskHash', 'category'].every(
        (key) => pair[0]![key as keyof OutcomeRun] === pair[1]![key as keyof OutcomeRun]
      )
  )
  if (!valid)
    return {
      ...empty,
      status: 'invalid',
      reason:
        'Every task/repetition requires exactly one baseline and harness run with identical model, effort, task and configuration.',
    }
  const tasks = new Map<string, Set<number>>()
  for (const run of runs) {
    const repeats = tasks.get(run.taskId) ?? new Set<number>()
    repeats.add(run.repetition)
    tasks.set(run.taskId, repeats)
  }
  const baseline = runs.filter((r) => r.arm === 'baseline')
  const harness = runs.filter((r) => r.arm === 'harness')
  const completion = (arm: OutcomeRun[]) => arm.filter((r) => r.completed).length / arm.length
  const tokens = (arm: OutcomeRun[]) => arm.reduce((n, r) => n + r.inputTokens + r.outputTokens, 0)
  const latency = (arm: OutcomeRun[]) => arm.reduce((n, r) => n + r.latencyMs, 0) / arm.length
  const sufficient =
    tasks.size >= 100 &&
    [...tasks.values()].every((r) => r.size >= 3) &&
    new Set(runs.map((r) => r.category)).size >= 4
  const qualified =
    sufficient &&
    completion(harness) >= 0.95 &&
    completion(harness) >= completion(baseline) &&
    harness.every((r) => r.escapedCriticalRegressions === 0)
  return {
    status: qualified ? 'qualified' : 'insufficient',
    qualified,
    reason: qualified
      ? 'Imported independent evidence meets the declared thresholds; this does not establish universal superiority.'
      : 'Require 100 held-out tasks, 4 categories, 3 repetitions each, ≥95% completion without baseline regression and zero escaped critical regressions. Small samples do not establish superiority.',
    tasks: tasks.size,
    pairs: groups.size,
    baselineCompletion: completion(baseline),
    harnessCompletion: completion(harness),
    baselineTokens: tokens(baseline),
    harnessTokens: tokens(harness),
    baselineLatencyMs: latency(baseline),
    harnessLatencyMs: latency(harness),
  }
}
