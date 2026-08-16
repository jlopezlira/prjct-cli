import type { AgentCapabilityClass } from '../schemas/model'
import type { DomainDefinition } from '../types/storage/extended'

/**
 * Review lenses — the SHARED specialist roster.
 *
 * The multi-agent review is NOT a fixed trio. Specialists are composed from the
 * concern a change actually raises: `architecture` is the floor; the rest join
 * when the work signals them. The vocabulary is OPEN — any lowercase string is a
 * valid lens (an agent-invented specialist gets the generic rubric).
 *
 * Both `spec-audit-dispatch` (audit the plan) and the crew (review the diff)
 * draw from this one catalog, so "the specialists you need" means the same set
 * everywhere — no predefined-personas anti-pattern.
 */

export interface LensSpec {
  /** Short parenthetical shown after the lens name in the dispatch. */
  label: string
  /**
   * Lens-specific reviewer instruction. The renderer prepends the
   * "first read the spec from prjct" line and appends the verdict ask.
   */
  rubric: string
  /**
   * Optional model-class override for THIS specialist. Unset → the reviewer
   * class (balanced) like every lens today. A genuinely narrow lens can opt
   * down to `fast` (a small, cheap model) — the "137x cheaper" lever — without
   * touching any other lens.
   */
  capabilityClass?: AgentCapabilityClass
}

export const LENS_CATALOG: Record<string, LensSpec> = {
  strategic: {
    label: 'scope sanity',
    rubric:
      'Review it for strategic soundness. Does it solve a real problem? Is the goal worth the cost? Is out_of_scope coherent with goal? Is the spec OVER- or UNDER-scoped? Cross-reference relevant prior memory via `prjct context memory <topic>` if useful.',
  },
  architecture: {
    label: 'eng feasibility',
    rubric:
      'Then read the codebase paths listed above (Read tool, cap 10 files). Can this be built ON TOP of what exists? Does the spec contradict an existing state machine, schema, or contract? What failure modes / dependencies / edge cases are missing? Include a short ASCII diagram + cite at least one concrete symbol from the codebase in notes when applicable.',
  },
  design: {
    label: 'UX/DX',
    rubric:
      'Rate 0-10 across {clarity, ergonomics, consistency, accessibility} for the user-facing or developer-facing surface. If scope touches existing UI/CLI patterns (read the listed paths), consistency must be judged against those — not against your priors. Pass only if all dimensions ≥6; include the four scores in notes.',
    // Checklist rubric, not open judgment — cheap model is enough here.
    capabilityClass: 'fast',
  },
  security: {
    label: 'threat surface',
    rubric:
      'Threat-model the surface this spec defines: authn/authz, secret handling, input validation & injection, sandbox/exec boundaries, network egress, PII. Name the highest-severity gap and whether the acceptance criteria mitigate it. Pass only if no high-severity gap is left unmitigated.',
  },
  data: {
    label: 'data integrity',
    rubric:
      'Review the data design. Are schema / migration changes backward-compatible and reversible? Index / query implications, write amplification, migration idempotency, data-loss risk on partial failure. Pass only if the migration path is safe and rollbackable.',
  },
  performance: {
    label: 'perf profile',
    rubric:
      'Identify the hottest path this spec touches and its expected complexity / allocation / IO profile. Do the acceptance criteria bound latency or throughput where it matters? Name the single biggest perf risk. Pass only if no hot-path regression is left unbounded.',
  },
}

export const GENERIC_RUBRIC =
  'Review the spec through this lens. Identify the most important risk or gap it implies and whether the acceptance criteria address it.'

/**
 * Rubric for a DOMAIN specialist — a reviewer that is an expert in one of the
 * project's business domains (auth, billing, …), not a function lens. The
 * domain comes from the project's own deterministic domain index (the Body), so
 * the specialist is grounded in how THIS project's module actually works.
 */
export function domainLensRubric(d: DomainDefinition): string {
  return `You are the \`${d.name}\` domain specialist (${d.description}). Judge whether this change respects the existing patterns, contracts, and invariants of the \`${d.name}\` domain. Pull \`prjct context memory ${d.name}\` to ground the verdict in what the project already knows. Pass only if the change is consistent with how \`${d.name}\` already works.`
}

/** The floor lens — always reviewed regardless of what the change signals. */
export const FLOOR_LENS = 'architecture'

/** One-line menu of the catalog specialists (for dispatch/crew prose). */
export function reviewLensMenu(): string {
  return Object.entries(LENS_CATALOG)
    .map(([name, spec]) => `\`${name}\` (${spec.label})`)
    .join(', ')
}
