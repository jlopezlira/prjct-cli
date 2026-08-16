/**
 * Eval run schemas.
 *
 * These records are intentionally portable: local storage, cloud publishing,
 * CI artifacts, and dashboards all consume the same shape.
 */

import { z } from 'zod'

export const EvalActionableSchema = z.object({
  severity: z.enum(['info', 'warning', 'blocking']),
  title: z.string(),
  recommendation: z.string(),
  files: z.array(z.string()).optional(),
  command: z.string().optional(),
})

export const EvalScenarioSchema = z.object({
  id: z.string(),
  name: z.string(),
  status: z.enum(['pass', 'warn', 'fail']),
  score: z.number().min(0).max(100),
  durationMs: z.number().nonnegative(),
  metrics: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
  actionables: z.array(EvalActionableSchema),
})

/** Pointers to the on-disk artifacts for a run/comparison — same shape either way. */
const EvalArtifactsRefSchema = z
  .object({
    jsonPath: z.string().optional(),
    reportPath: z.string().optional(),
  })
  .optional()

export const EvalRunSchema = z.object({
  schemaVersion: z.literal(1),
  runId: z.string(),
  createdAt: z.string(),
  runner: z.object({
    source: z.enum(['local', 'ci', 'agent']),
    user: z.string().optional(),
    platform: z.string(),
    node: z.string(),
    bun: z.string().optional(),
  }),
  project: z.object({
    repo: z.string(),
    branch: z.string().optional(),
    commit: z.string().optional(),
    dirty: z.boolean(),
  }),
  versions: z.object({
    current: z.string(),
    baseline: z.string().optional(),
    candidate: z.string().optional(),
  }),
  scenarios: z.array(EvalScenarioSchema),
  summary: z.object({
    score: z.number().min(0).max(100),
    pass: z.number().nonnegative(),
    warn: z.number().nonnegative(),
    fail: z.number().nonnegative(),
    improvements: z.number().nonnegative(),
    regressions: z.number().nonnegative(),
    actionables: z.number().nonnegative(),
  }),
  artifacts: EvalArtifactsRefSchema,
})

export const EvalComparisonSchema = z.object({
  schemaVersion: z.literal(1),
  comparisonId: z.string(),
  createdAt: z.string(),
  baselineRunId: z.string().optional(),
  candidateRunId: z.string().optional(),
  baselineVersion: z.string().optional(),
  candidateVersion: z.string().optional(),
  summary: z.object({
    baselineScore: z.number().optional(),
    candidateScore: z.number().optional(),
    delta: z.number().optional(),
    regressions: z.number().nonnegative(),
    improvements: z.number().nonnegative(),
    actionables: z.number().nonnegative(),
  }),
  artifacts: EvalArtifactsRefSchema,
  scenarios: z.array(
    z.object({
      id: z.string(),
      baselineScore: z.number().optional(),
      candidateScore: z.number().optional(),
      delta: z.number().optional(),
      status: z.enum([
        'improved',
        'regressed',
        'unchanged',
        'missing-baseline',
        'missing-candidate',
      ]),
      actionables: z.array(EvalActionableSchema),
    })
  ),
})

export type EvalActionable = z.infer<typeof EvalActionableSchema>
export type EvalScenario = z.infer<typeof EvalScenarioSchema>
export type EvalRun = z.infer<typeof EvalRunSchema>
export type EvalComparison = z.infer<typeof EvalComparisonSchema>
