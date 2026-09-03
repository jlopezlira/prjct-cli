/**
 * QA phase — Zod is the source of truth for the per-cycle QA plan, the
 * universal probes prjct runs itself, the machine receipt, and the report a
 * blind QA subagent files back.
 *
 * Nothing here assumes a test framework in the client project: `http`, `cli`
 * and `file` probes need only fetch + a shell; `browser` probes are run by
 * prjct's own headless browser (installed once under the prjct cache) and fall
 * back to the blind QA subagent when it is absent.
 */

import { createHash } from 'node:crypto'
import { z } from 'zod'

export const QA_MODES = ['off', 'advisory', 'strict'] as const
export const QaModeSchema = z.enum(QA_MODES)
export type QaMode = z.infer<typeof QaModeSchema>

/** Who produced the evidence. `author` = the implementing agent's own word. */
export const QaVerifiedBySchema = z.enum(['machine', 'agent', 'author'])
export type QaVerifiedBy = z.infer<typeof QaVerifiedBySchema>

export const QaCriterionStatusSchema = z.enum(['pending', 'met', 'unmet'])
export type QaCriterionStatus = z.infer<typeof QaCriterionStatusSchema>

export const QaFlowStatusSchema = z.enum(['pending', 'passed', 'failed', 'skipped'])
export type QaFlowStatus = z.infer<typeof QaFlowStatusSchema>

export const QaFlowKindSchema = z.enum(['ui', 'api', 'cli', 'integration', 'manual'])
export type QaFlowKind = z.infer<typeof QaFlowKindSchema>

/** Optional extra commands a project may already own (never required). */
export const QA_EXTRA_COMMAND_KINDS = ['e2e', 'integration', 'smoke'] as const
export const QaExtraCommandKindSchema = z.enum(QA_EXTRA_COMMAND_KINDS)
export type QaExtraCommandKind = z.infer<typeof QaExtraCommandKindSchema>

// ── Probes — executable by prjct with zero project dependencies ──────────

export const QaHttpProbeSchema = z.object({
  type: z.literal('http'),
  method: z.string().default('GET'),
  /** Resolved against `qa.app.baseUrl`; ignored when `url` is absolute. */
  path: z.string().optional(),
  url: z.string().optional(),
  headers: z.record(z.string(), z.string()).optional(),
  body: z.string().optional(),
  expect: z
    .object({
      /** Default: any 2xx. */
      status: z.number().int().optional(),
      bodyIncludes: z.array(z.string()).default([]),
      /** Dot-path → expected JSON value (deep-equal by JSON.stringify). */
      jsonPath: z.record(z.string(), z.unknown()).optional(),
    })
    .default({ bodyIncludes: [] }),
})

export const QaCliProbeSchema = z.object({
  type: z.literal('cli'),
  command: z.string().min(1),
  expect: z
    .object({
      exitCode: z.number().int().default(0),
      /** Regex source tested against stdout. */
      stdoutMatches: z.string().optional(),
      stderrEmpty: z.boolean().optional(),
    })
    .default({ exitCode: 0 }),
})

export const QaFileProbeSchema = z.object({
  type: z.literal('file'),
  path: z.string().min(1),
  expect: z
    .object({
      exists: z.boolean().default(true),
      includes: z.array(z.string()).default([]),
    })
    .default({ exists: true, includes: [] }),
})

export const QaBrowserStepSchema = z.discriminatedUnion('do', [
  z.object({ do: z.literal('goto'), url: z.string().min(1) }),
  z.object({ do: z.literal('fill'), selector: z.string().min(1), text: z.string() }),
  z.object({ do: z.literal('click'), selector: z.string().min(1) }),
  z.object({
    do: z.literal('expectText'),
    text: z.string().min(1),
    selector: z.string().optional(),
  }),
  z.object({ do: z.literal('expectUrl'), includes: z.string().min(1) }),
  z.object({ do: z.literal('screenshot'), name: z.string().optional() }),
])
export type QaBrowserStep = z.infer<typeof QaBrowserStepSchema>

/** Run by prjct's own headless browser (`prjct qa browser install`); QA subagent otherwise. */
export const QaBrowserProbeSchema = z.object({
  type: z.literal('browser'),
  steps: z.array(QaBrowserStepSchema).min(1),
})

export const QaProbeSchema = z.discriminatedUnion('type', [
  QaHttpProbeSchema,
  QaCliProbeSchema,
  QaFileProbeSchema,
  QaBrowserProbeSchema,
])
export type QaProbe = z.infer<typeof QaProbeSchema>
export type QaHttpProbe = z.infer<typeof QaHttpProbeSchema>
export type QaCliProbe = z.infer<typeof QaCliProbeSchema>
export type QaFileProbe = z.infer<typeof QaFileProbeSchema>
export type QaBrowserProbe = z.infer<typeof QaBrowserProbeSchema>

// ── Plan ─────────────────────────────────────────────────────────────────

export const QaCriterionSchema = z.object({
  id: z.string().min(1),
  text: z.string().min(1),
  /** Nyquist-lite: names a test/command/observable signal. */
  verifiable: z.boolean(),
  status: QaCriterionStatusSchema.default('pending'),
  verifiedBy: QaVerifiedBySchema.optional(),
  evidence: z.string().optional(),
  updatedAt: z.string().optional(),
})
export type QaCriterion = z.infer<typeof QaCriterionSchema>

export const QaFlowSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  kind: QaFlowKindSchema.default('ui'),
  given: z.array(z.string()).default([]),
  when: z.array(z.string()).default([]),
  // biome-ignore lint/suspicious/noThenProperty: GIVEN/WHEN/THEN domain language; never awaited
  then: z.array(z.string()).default([]),
  probe: QaProbeSchema.optional(),
  /** Regression test the agent left behind for this flow. */
  testFile: z.string().optional(),
  status: QaFlowStatusSchema.default('pending'),
  verifiedBy: QaVerifiedBySchema.optional(),
  evidence: z.string().optional(),
  lastRunAt: z.string().optional(),
})
export type QaFlow = z.infer<typeof QaFlowSchema>

export const QaPlanSchema = z.object({
  version: z.literal(1),
  taskId: z.string().min(1),
  workspaceId: z.string().optional(),
  specId: z.string().optional(),
  seededFromSpec: z.boolean().default(false),
  createdAt: z.string(),
  updatedAt: z.string(),
  criteria: z.array(QaCriterionSchema).default([]),
  flows: z.array(QaFlowSchema).default([]),
})
export type QaPlan = z.infer<typeof QaPlanSchema>

/** Lenient agent input for `prjct qa plan --json` — ids are derived. */
export const QaPlanInputSchema = z.object({
  criteria: z
    .array(
      z.union([
        z.string().min(1),
        z.object({
          text: z.string().min(1),
          status: QaCriterionStatusSchema.optional(),
          evidence: z.string().optional(),
        }),
      ])
    )
    .optional(),
  flows: z
    .array(
      z.object({
        name: z.string().min(1),
        kind: QaFlowKindSchema.optional(),
        given: z.array(z.string()).optional(),
        when: z.array(z.string()).optional(),
        // biome-ignore lint/suspicious/noThenProperty: GIVEN/WHEN/THEN domain language; never awaited
        then: z.array(z.string()).optional(),
        probe: QaProbeSchema.optional(),
        testFile: z.string().optional(),
      })
    )
    .optional(),
  /** Ids (`ac-…` / `fl-…`) to drop — the only way a plan shrinks. */
  remove: z.array(z.string().min(1)).optional(),
})
export type QaPlanInput = z.infer<typeof QaPlanInputSchema>
/** What the agent may hand in — defaults not yet applied. */
export type QaPlanInputRaw = z.input<typeof QaPlanInputSchema>

// ── Receipt ──────────────────────────────────────────────────────────────

export const QaProbeResultSchema = z.object({
  flowId: z.string().optional(),
  type: z.string(),
  ok: z.boolean(),
  /** 'ok' | 'exit:<code>' | 'mismatch' | 'timeout' | 'unreachable' | 'unavailable' | … */
  outcome: z.string(),
  durationMs: z.number(),
  detail: z.string().optional(),
  /** Could not run HERE (no app, no tool) — never a defect, never verified. */
  unavailable: z.boolean().optional(),
})
export type QaProbeResult = z.infer<typeof QaProbeResultSchema>

export const QaCheckSchema = z.object({
  kind: z.string(),
  command: z.string(),
  ok: z.boolean(),
  outcome: z.string(),
  durationMs: z.number(),
  detail: z.string().optional(),
  unavailable: z.boolean().optional(),
})
export type QaCheck = z.infer<typeof QaCheckSchema>

export const QaReceiptSchema = z.object({
  version: z.literal(1),
  taskId: z.string().nullable(),
  ranAt: z.string(),
  headSha: z.string().nullable(),
  dirty: z.boolean().nullable(),
  passed: z.boolean(),
  /** Nothing ran — a pass that proves nothing, said loudly. */
  vacuous: z.boolean(),
  app: z.object({
    started: z.boolean(),
    baseUrl: z.string().optional(),
    readyMs: z.number().optional(),
    error: z.string().optional(),
  }),
  checks: z.array(QaCheckSchema).default([]),
  probes: z.array(QaProbeResultSchema).default([]),
})
export type QaReceipt = z.infer<typeof QaReceiptSchema>

// ── Subagent report ──────────────────────────────────────────────────────

export const QA_EVIDENCE_MIN_CHARS = 40

export const QaReportEntrySchema = z.object({
  id: z.string().min(1),
  verdict: z.enum(['passed', 'failed', 'met', 'unmet', 'blocked']),
  evidence: z.string().min(QA_EVIDENCE_MIN_CHARS),
  repro: z.string().optional(),
  testFile: z.string().optional(),
})
export const QaReportSchema = z.array(QaReportEntrySchema).min(1)
export type QaReportEntry = z.infer<typeof QaReportEntrySchema>
export type QaReport = z.infer<typeof QaReportSchema>

/** Stable id from normalized text — same text ⇒ same id on every machine. */
export function qaId(prefix: 'ac' | 'fl', text: string): string {
  const normalized = text.trim().toLowerCase().replace(/\s+/g, ' ')
  return `${prefix}-${createHash('sha1').update(normalized).digest('hex').slice(0, 8)}`
}
