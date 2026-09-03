/**
 * Precision-gated judgment ledger — schemas (source of truth).
 *
 * Beats gentle-ai 4R v2 by making the contract a SQLite artifact agents
 * MUST update, not adapter prose. Severity floor, convergence budget,
 * batch refutation, dual-judge merge, evidence tax, and scoped re-review
 * are pure functions over this shape.
 */

import { z } from 'zod'

export const ReviewIntensitySchema = z.enum(['skip', 'standard', 'full'])
export type ReviewIntensity = z.infer<typeof ReviewIntensitySchema>

export const FindingSeveritySchema = z.enum(['blocker', 'critical', 'warning', 'suggestion'])
export type FindingSeverity = z.infer<typeof FindingSeveritySchema>

export const FindingStatusSchema = z.enum([
  /** Just reported; not yet challenged. */
  'candidate',
  /** Survived challenge (or fail-closed when challenge missing). */
  'stands',
  /** Killed by refuter — does not enter fix loops. */
  'refuted',
  /** Non-actionable (severity floor): reported once, never loops. */
  'info',
  /** Fix applied in current/previous round. */
  'fixed',
  /** Re-judge confirmed the fix. */
  'verified',
  /** Leftover after convergence budget exhausted — surface, don't round-3. */
  'open',
])
export type FindingStatus = z.infer<typeof FindingStatusSchema>

export const RefuteVerdictSchema = z.enum(['stands', 'refuted'])
export type RefuteVerdict = z.infer<typeof RefuteVerdictSchema>

export const JudgmentVerdictSchema = z.enum(['in_progress', 'approved', 'escalated', 'blocked'])
export type JudgmentVerdict = z.infer<typeof JudgmentVerdictSchema>

/** Dual-blind role — structural diversity, not two identical passes. */
export const JudgeRoleSchema = z.enum(['red', 'blue', 'solo'])
export type JudgeRole = z.infer<typeof JudgeRoleSchema>

export const JudgmentFindingSchema = z.object({
  id: z.string().min(1),
  severity: FindingSeveritySchema,
  status: FindingStatusSchema,
  title: z.string().min(1),
  file: z.string().optional(),
  line: z.number().int().positive().optional(),
  evidence: z.string().optional(),
  /** Which judge reported it (a|b|red|blue|lens name). */
  judge: z.string().optional(),
  /** Dual-blind role when known. */
  role: JudgeRoleSchema.optional(),
  /** Stable DNA for dedup + project FP memory (normalized title|file|line). */
  dna: z.string().optional(),
  /**
   * Evidence quality 0–3:
   * 0 = title only · 1 = file · 2 = file+line · 3 = file+line+evidence sketch
   */
  evidenceScore: z.number().int().min(0).max(3).optional(),
  /** Blast-radius rank for fix order (higher first). */
  blast: z.number().optional(),
  /** True when DNA matches a previously refuted ghost in this project. */
  knownFalsePositive: z.boolean().optional(),
  /** Judges that independently reported the same DNA (merge agreement). */
  agreedBy: z.array(z.string()).optional(),
  /** Refuter votes recorded (batched; never one task per finding). */
  refuteVotes: z.array(RefuteVerdictSchema).optional(),
  /** Explicit non-blocking disposition for a finding outside the frozen payload. */
  scopeDisposition: z.literal('follow-up').optional(),
})
export type JudgmentFinding = z.infer<typeof JudgmentFindingSchema>

/** Canonical max fix rounds — structural budget (gentle-ai v2 parity, enforced). */
export const MAX_FIX_ROUNDS = 2 as const

export const JudgmentLedgerSchema = z.object({
  id: z.string().min(1),
  target: z.string().min(1),
  intensity: ReviewIntensitySchema,
  maxFixRounds: z.literal(MAX_FIX_ROUNDS).default(MAX_FIX_ROUNDS),
  /** 0 = first pass done / no fix yet; 1..max after each fix+re-judge round. */
  fixRound: z.number().int().min(0).max(MAX_FIX_ROUNDS),
  findings: z.array(JudgmentFindingSchema),
  verdict: JudgmentVerdictSchema,
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
  baseSha: z.string().optional(),
  headSha: z.string().optional(),
  /** Why escalated (judges contradict / human needed). */
  escalateReason: z.string().optional(),
  /** Delivery tier that drove intensity (telemetry). */
  deliveryTier: z.enum(['trivial', 'normal', 'large']).optional(),
  /** Dual-judge merge stats (full intensity). */
  merge: z
    .object({
      agreed: z.number().int().min(0),
      onlyRed: z.number().int().min(0),
      onlyBlue: z.number().int().min(0),
      contradicted: z.number().int().min(0),
    })
    .optional(),
  /** Persisted reviewer-pass usage so CLI retries cannot spend the same stage twice. */
  reviewPasses: z
    .object({
      initial: z.number().int().min(0),
      challenge: z.number().int().min(0),
      rejudge: z.number().int().min(0),
    })
    .optional(),
  /** Running precision: verified / (verified + refuted) when enough signal. */
  precisionHint: z.number().min(0).max(1).optional(),
  /**
   * Frozen review path set from git at ledger open (gentle-ai v1.49 scope freeze).
   * Corrections / fix-loop findings outside this set demote to non-blocking follow-up.
   * Empty/omitted = no freeze (legacy ledgers + non-git workspaces).
   */
  scopePaths: z.array(z.string().min(1)).optional(),
  /** ISO timestamp when scopePaths was frozen (open). */
  scopeFrozenAt: z.string().optional(),
  /**
   * Content-bound stamp at approve (gentle-ai v2 residual): path+blob treeHash.
   * Ship re-hashes the same path set; drift forces re-approve.
   */
  contentBound: z
    .object({
      version: z.union([z.literal(1), z.literal(2)]),
      treeHash: z.string().min(8),
      pathCount: z.number().int().min(0),
      paths: z.array(
        z.object({
          path: z.string().min(1),
          blobHash: z.string().min(1),
        })
      ),
      stampedAt: z.string().min(1),
      headSha: z.string().optional(),
      baseSha: z.string().optional(),
      payloadBound: z.boolean().optional(),
      identityBound: z.boolean().optional(),
    })
    .optional(),
})
export type JudgmentLedger = z.infer<typeof JudgmentLedgerSchema>

/** Project-level ghost memory: DNA of findings that were refuted as FPs. */
export const JudgmentGhostSchema = z.object({
  dna: z.string().min(1),
  title: z.string().min(1),
  times: z.number().int().positive(),
  lastSeenAt: z.string().min(1),
  lastReason: z.string().optional(),
})
export type JudgmentGhost = z.infer<typeof JudgmentGhostSchema>

export const JudgmentGhostBookSchema = z.object({
  ghosts: z.array(JudgmentGhostSchema),
  updatedAt: z.string().min(1),
})
export type JudgmentGhostBook = z.infer<typeof JudgmentGhostBookSchema>
