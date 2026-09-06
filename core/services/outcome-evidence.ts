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
  // Live A/B extensions (optional so the strict single-model callers and their
  // fixtures parse unchanged). Populated by core/eval/ab-report.
  taskClass: z.string().optional(),
  detVerdict: z.boolean().nullable().optional(),
  llmVerdict: z.boolean().nullable().optional(),
  graderDisagreement: z.boolean().optional().default(false),
  wallMs: z.number().finite().nonnegative().optional(),
  toolCalls: z.number().int().nonnegative().optional(),
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

/** One Δ slice (a task class or a model): accuracy + cost, harness vs baseline. */
export interface OutcomeSlice {
  key: string
  pairs: number
  baselineAccuracy: number
  harnessAccuracy: number
  deltaAccuracy: number
  deltaTokens: number
  deltaLatencyMs: number
}

export interface LiveOutcomeReport {
  /** `provisional` once there is a small but real paired sample; else `insufficient`/`missing`. */
  status: 'missing' | 'provisional' | 'insufficient'
  pairs: number
  models: string[]
  classes: string[]
  disagreements: number
  byClass: OutcomeSlice[]
  byModel: OutcomeSlice[]
  summary: string
}

/** Provisional thresholds — below `qualified`, so a small live sample is
 *  reported, never hidden, and never mistaken for the release gate. */
const PROVISIONAL_MIN_PAIRS = 6
const PROVISIONAL_MIN_MODELS = 2
const PROVISIONAL_MIN_CLASSES = 2

interface Pair {
  model: string
  taskClass: string
  baseline: OutcomeRun
  harness: OutcomeRun
}

function pairRuns(runs: OutcomeRun[]): Pair[] {
  const groups = new Map<string, OutcomeRun[]>()
  for (const run of runs) {
    const key = JSON.stringify([run.model, run.taskId, run.repetition])
    const group = groups.get(key) ?? []
    group.push(run)
    groups.set(key, group)
  }
  const pairs: Pair[] = []
  for (const group of groups.values()) {
    const baseline = group.find((r) => r.arm === 'baseline')
    const harness = group.find((r) => r.arm === 'harness')
    if (baseline && harness) {
      pairs.push({
        model: baseline.model,
        taskClass: baseline.taskClass ?? baseline.category,
        baseline,
        harness,
      })
    }
  }
  return pairs
}

/** Deterministic accuracy of a run: prefer the det verdict, fall back to completed. */
function runCorrect(run: OutcomeRun): boolean {
  return typeof run.detVerdict === 'boolean' ? run.detVerdict : run.completed
}

function sliceOf(key: string, pairs: Pair[]): OutcomeSlice {
  const n = pairs.length
  const acc = (side: 'baseline' | 'harness') => pairs.filter((p) => runCorrect(p[side])).length / n
  const tok = (side: 'baseline' | 'harness') =>
    pairs.reduce((s, p) => s + p[side].inputTokens + p[side].outputTokens, 0) / n
  const lat = (side: 'baseline' | 'harness') => pairs.reduce((s, p) => s + p[side].latencyMs, 0) / n
  const baselineAccuracy = acc('baseline')
  const harnessAccuracy = acc('harness')
  return {
    key,
    pairs: n,
    baselineAccuracy,
    harnessAccuracy,
    deltaAccuracy: harnessAccuracy - baselineAccuracy,
    deltaTokens: tok('harness') - tok('baseline'),
    deltaLatencyMs: lat('harness') - lat('baseline'),
  }
}

function groupSlices(pairs: Pair[], keyOf: (p: Pair) => string): OutcomeSlice[] {
  const by = new Map<string, Pair[]>()
  for (const p of pairs) {
    const k = keyOf(p)
    by.set(k, [...(by.get(k) ?? []), p])
  }
  return [...by.keys()].sort().map((k) => sliceOf(k, by.get(k)!))
}

/**
 * Model-aware live A/B evaluation — the "measurement is the product" report.
 * Unlike `evaluateOutcomeEvidence` (the strict, single-model `qualified` gate),
 * this pairs by (model, task, repetition), tolerates incomplete groups, and
 * reports Δ per class and per model at a `provisional` bar so a small live
 * sample is surfaced rather than dropped.
 */
export function evaluateLiveOutcome(input?: unknown): LiveOutcomeReport {
  const empty: LiveOutcomeReport = {
    status: 'missing',
    pairs: 0,
    models: [],
    classes: [],
    disagreements: 0,
    byClass: [],
    byModel: [],
    summary: 'No live A/B runs supplied.',
  }
  if (input === undefined) return empty
  const parsed = OutcomeRunsSchema.safeParse(input)
  if (!parsed.success)
    return { ...empty, status: 'insufficient', summary: 'Invalid live A/B runs.' }
  const runs = parsed.data
  if (!runs.length) return empty
  const pairs = pairRuns(runs)
  const models = [...new Set(pairs.map((p) => p.model))].sort()
  const classes = [...new Set(pairs.map((p) => p.taskClass))].sort()
  const disagreements = runs.filter((r) => r.graderDisagreement === true).length
  const provisional =
    pairs.length >= PROVISIONAL_MIN_PAIRS &&
    models.length >= PROVISIONAL_MIN_MODELS &&
    classes.length >= PROVISIONAL_MIN_CLASSES
  const byClass = groupSlices(pairs, (p) => p.taskClass)
  const byModel = groupSlices(pairs, (p) => p.model)
  return {
    status: pairs.length === 0 ? 'missing' : provisional ? 'provisional' : 'insufficient',
    pairs: pairs.length,
    models,
    classes,
    disagreements,
    byClass,
    byModel,
    summary: provisional
      ? `Provisional: ${pairs.length} paired runs across ${models.length} models and ${classes.length} classes. Not the release gate; a directional signal.`
      : `Insufficient live sample (${pairs.length} pairs, ${models.length} models, ${classes.length} classes). Need ≥${PROVISIONAL_MIN_PAIRS} pairs, ≥${PROVISIONAL_MIN_MODELS} models, ≥${PROVISIONAL_MIN_CLASSES} classes.`,
  }
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
  const identities = new Map<string, string>()
  const hashes = new Map<string, string>()
  for (const run of runs) {
    const identity = JSON.stringify([
      run.taskHash,
      run.category,
      run.model,
      run.effort,
      run.configurationHash,
    ])
    if (
      (identities.has(run.taskId) && identities.get(run.taskId) !== identity) ||
      (hashes.has(run.taskHash) && hashes.get(run.taskHash) !== run.taskId)
    )
      return {
        ...empty,
        status: 'invalid',
        reason:
          'Task content, category and evaluation settings must be stable across repetitions; aliased task content cannot count as distinct tasks.',
      }
    identities.set(run.taskId, identity)
    hashes.set(run.taskHash, run.taskId)
  }
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
    const repeats = tasks.get(run.taskHash) ?? new Set<number>()
    repeats.add(run.repetition)
    tasks.set(run.taskHash, repeats)
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
