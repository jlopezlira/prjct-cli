/**
 * Spec — first-class SDD entity.
 *
 * A spec frames a piece of work BEFORE implementation: goal, eli10,
 * acceptance criteria, scope, out-of-scope, risks, test plan. Stored
 * as a row in the `specs` table (migration 16); the structured content
 * lives in the `content` column as JSON validated by `SpecContentSchema`.
 *
 * Lifecycle:
 *   draft → reviewed → in_progress → shipped
 *                                  → archived
 *
 * `prjct work --spec <id>` links a work cycle to its spec via tasks.linked_spec_id.
 * `prjct ship` reads the linked spec's acceptance_criteria as a gate.
 * `prjct audit-spec <id>` populates `reviews` after dispatching subagents.
 */

import { z } from 'zod'

export const SPEC_STATUSES = ['draft', 'reviewed', 'in_progress', 'shipped', 'archived'] as const
export type SpecStatus = (typeof SPEC_STATUSES)[number]

export const SPEC_REVIEWERS = ['strategic', 'architecture', 'design'] as const
export type SpecReviewer = (typeof SPEC_REVIEWERS)[number]

const SpecReviewSchema = z.object({
  verdict: z.enum(['pass', 'fail']),
  notes: z.string(),
  ts: z.string(),
  /** Hash of frozen audit candidate at the time this lens recorded its verdict. */
  candidateHash: z.string().optional(),
})
export type SpecReview = z.infer<typeof SpecReviewSchema>

const SpecRiskSchema = z.object({
  risk: z.string().min(1),
  mitigation: z.string().min(1),
})
export type SpecRisk = z.infer<typeof SpecRiskSchema>

/**
 * A GIVEN/WHEN/THEN scenario under a requirement (Phase 1 / spec deltas).
 * Each clause is a list so `AND` continuation bullets have somewhere to land.
 */
export const SpecScenarioSchema = z.object({
  name: z.string().min(1),
  given: z.array(z.string()).default([]),
  when: z.array(z.string()).default([]),
  // biome-ignore lint/suspicious/noThenProperty: GIVEN/WHEN/THEN domain language; never awaited
  then: z.array(z.string()).default([]),
})
export type SpecScenario = z.infer<typeof SpecScenarioSchema>

/**
 * One requirement operation inside a delta. `slug` is the stable identity
 * (derived from `name`); `statement` is the SHALL text that materializes
 * into `acceptance_criteria`.
 */
export const DeltaRequirementSchema = z.object({
  slug: z.string().min(1),
  name: z.string().min(1),
  statement: z.string().min(1),
  scenarios: z.array(SpecScenarioSchema).default([]),
})
export type DeltaRequirement = z.infer<typeof DeltaRequirementSchema>

/**
 * Structured summary of a parsed delta — the full operation set, so the
 * sync merge can deterministically re-materialize requirements from the
 * union of two delta logs. `removed` carries slugs only.
 */
export const DeltaOpsSchema = z.object({
  added: z.array(DeltaRequirementSchema).default([]),
  modified: z.array(DeltaRequirementSchema).default([]),
  removed: z.array(z.string().min(1)).default([]),
})
export type DeltaOps = z.infer<typeof DeltaOpsSchema>

export const DeltaEntrySchema = z.object({
  /** Content-hash id by default — same delta text ⇒ same id on every machine. */
  id: z.string().min(1),
  ts: z.string(),
  ops: DeltaOpsSchema,
})
export type DeltaEntry = z.infer<typeof DeltaEntrySchema>

export const SpecContentSchema = z.object({
  goal: z.string().min(1),
  eli10: z.string().default(''),
  stakes: z.string().default(''),
  acceptance_criteria: z.array(z.string().min(1)).default([]),
  scope: z.array(z.string()).default([]),
  out_of_scope: z.array(z.string()).default([]),
  risks: z.array(SpecRiskSchema).default([]),
  test_plan: z.array(z.string()).default([]),
  // Open vocabulary: lens name → verdict. Defaults to the three baseline
  // lenses (strategic / architecture / design) but any lens the audit selects
  // (security, data, performance, …) is a valid key. Legacy specs keyed
  // strategic/architecture/design still parse unchanged.
  reviews: z.record(z.string(), SpecReviewSchema).optional(),
  // Lens set chosen for THIS spec at audit time — the auto-promote gate's
  // expected set. Empty ⇒ legacy spec audited before dynamic lenses; the gate
  // then falls back to the three baseline lenses. See spec-audit-dispatch.ts.
  selected_reviewers: z.array(z.string()).default([]),
  linked_tasks: z.array(z.string()).default([]),
  notes: z.string().default(''),
  // Set ONLY after breakdownSpecToTasks completes its full loop. Acts as a
  // completion marker for idempotency + partial-recovery: null + non-empty
  // linked_tasks ⇒ partial breakdown; recovery reconciles by adopting queue
  // rows whose body matches an AC (featureId = spec.id) and creating only
  // the missing ones. Existing specs read as null via Zod's default fill
  // (no DB migration needed; specs.content is a JSON blob).
  tasks_created_at: z.string().nullable().default(null),
  /**
   * Frozen candidate body hash at audit time (C1 / gentle-ai v2.2 steal).
   * Lens results must carry the same hash; content edits clear reviews + demote.
   * null = legacy / not yet audited under candidate-bound admission.
   */
  audit_candidate_hash: z.string().nullable().default(null),
  // Phase 1 / spec deltas: GIVEN/WHEN/THEN scenarios keyed by requirement
  // slug, and the append-only delta log that materialized them. Both default
  // empty so legacy rows parse with zero DB migration (content is a JSON blob).
  scenarios: z.record(z.string(), z.array(SpecScenarioSchema)).default({}),
  delta_log: z.array(DeltaEntrySchema).default([]),
})

export type SpecContent = z.infer<typeof SpecContentSchema>

export interface Spec {
  id: string
  title: string
  status: SpecStatus
  content: SpecContent
  tags: Record<string, string>
  createdAt: string
  updatedAt: string
  shippedAt: string | null
  shippedPr: number | null
  /**
   * Git HEAD sha at ship time (Phase 1.6 / B-DRIFT-ANCHOR). NULL for
   * legacy shipped specs that predate migration 18 — inventory marks
   * those as drift=unknown.
   */
  shippedSha: string | null
  archivedAt: string | null
}

/**
 * Empty spec content — the seed for new specs before the user / Claude
 * fills in the structured fields. `goal` MUST be provided by the caller
 * (the title alone isn't enough — a spec without a goal is just a TODO).
 */
export function emptySpecContent(goal: string): SpecContent {
  return SpecContentSchema.parse({ goal })
}
