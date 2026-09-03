/**
 * Provider-aware multi-agent dispatch — the harness runs on ANY rig.
 *
 * prjct's multi-agent flows (audit-spec, review fan-out) emit dispatch
 * instructions; the host executes them. Claude Code has a native subagent tool,
 * so it dispatches real parallel subagents. Other rigs (Gemini, Codex, …) have
 * no subagent tool, so the same fan-out is EMULATED on a single agent: run each
 * unit as a fresh, isolated pass.
 *
 * No dispatch names a model. Subagents inherit the model of the rig the user is
 * driving — see `core/schemas/model.ts` for why prjct has no role→model policy.
 */

import { getActiveProvider } from '../infrastructure/ai-provider'
import type { AgentRole } from '../schemas/model'
import type { AIProviderName } from '../types/provider'
import { FLOOR_LENS, reviewLensMenu } from './review-lenses'

export interface DispatchMechanism {
  provider: AIProviderName
  /** True when the rig has a native subagent tool (Claude). */
  native: boolean
  /** How to run `count` reviewers/workers concurrently (or emulated). */
  runLine(count: number): string
}

/** A stage of the multi-agent flow — what the role does in the dispatch. */
export type RoleKind = 'orchestrate' | 'implement' | 'review' | 'explore'

export interface CrewRole {
  /** Agent file/display name (leader/implementer/reviewer). */
  name: string
  /** The responsibility this agent plays in the flow. Carries no model. */
  role: AgentRole
  kind: RoleKind
}

/**
 * The crew roster — ONE source. crew install derives its `.claude/agents/`
 * files from this; the emulated protocol plays these same roles. (Review specialists are composed per task from the lens catalog, not
 * fixed here — see review-lenses.ts.)
 */
export const CREW_ROLES: readonly CrewRole[] = [
  { name: 'leader', role: 'orchestrator', kind: 'orchestrate' },
  { name: 'implementer', role: 'implementer', kind: 'implement' },
  { name: 'reviewer', role: 'reviewer', kind: 'review' },
]

function claudeMechanism(): Omit<DispatchMechanism, 'provider'> {
  return {
    native: true,
    runLine: (count) =>
      count === 1
        ? 'Run this review subagent via the Agent tool. It reads the spec FROM prjct (command below), reads the relevant codebase paths, applies its rubric, then returns a structured verdict.'
        : `Run these ${count} review subagents IN PARALLEL via the Agent tool — one tool-use block per reviewer group, all in the SAME message so they run concurrently. Each subagent reads the spec FROM prjct once, applies every assigned lens independently, then returns a structured verdict per lens.`,
  }
}

function emulatedMechanism(provider: AIProviderName): Omit<DispatchMechanism, 'provider'> {
  return {
    native: false,
    runLine: (count) =>
      count === 1
        ? `This rig (${provider}) has no native subagent tool. Run this review as ONE focused, fresh pass: read the spec FROM prjct (command below) and the relevant codebase paths, apply the rubric, return a structured verdict — do not carry over assumptions from the planning context.`
        : `This rig (${provider}) has no native subagent tool, so EMULATE the fan-out: run the ${count} reviewer groups ONE AT A TIME, each as a fresh, independent pass. For each — reset your working assumptions, read the spec FROM prjct once + only relevant paths, apply every assigned lens independently, return one verdict per lens, then move on.`,
  }
}

/**
 * Resolve the dispatch mechanism for the active rig. Pass `projectProvider` to
 * pin it (deterministic — skips CLI detection); omit it to detect the installed
 * rig. Claude → native subagents; everything else → emulated fresh-context
 * fan-out. The per-role model always flows from the policy.
 */
export async function resolveDispatchMechanism(
  projectProvider?: AIProviderName
): Promise<DispatchMechanism> {
  const provider = (await getActiveProvider(projectProvider)).name
  const base = provider === 'claude' ? claudeMechanism() : emulatedMechanism(provider)
  return { provider, ...base }
}

/**
 * The crew EMULATED for a rig with no native subagent tool: one agent plays the
 * roles the work needs IN SEQUENCE, each a fresh isolated pass. The roster is
 * COMPOSED per task — NOT a fixed
 * leader/implementer/reviewer trio: the leader decides how many implementers
 * (by disjoint scope) and which review specialists the change actually raises,
 * drawing from the same lens catalog `prjct spec audit` uses. The native Claude
 * crew (separate `.claude/agents/` files via the Agent tool) has no equivalent
 * on Gemini/Codex/etc., so `prjct crew install` writes this protocol instead.
 */
export function buildEmulatedCrewProtocol(m: DispatchMechanism, checkpoints: string): string {
  const cp = checkpoints.trim()
  return `${[
    `# prjct crew — emulated on ${m.provider}`,
    '',
    `This rig has no native subagent tool, so the crew runs as ONE agent playing roles IN SEQUENCE — each a fresh, isolated pass. Reset your working assumptions between roles; a later role must never inherit an earlier one's framing.`,
    '',
    `The roster is **composed per task, not a fixed trio**: the leader decides how many implementers and which review specialists the change actually needs.`,
    '',
    '## Roles (run in order)',
    '',
    `1. **Leader — orchestrate, do not write code.** Run \`prjct work --md\` for the cycle + related context. Decompose into slices with DISJOINT file scope, and decide the roster: how many implementers, which review specialists the change raises, and whether investigation is needed first.`,
    `2. **Explore — only if investigation is needed.** One fresh, read-only pass per narrow question; persist findings with \`prjct remember learning\`.`,
    `3. **Implementer(s) — one per disjoint slice.** Implement the slice + its tests and self-verify (run the project's test command) before handing off. Fan out only over non-overlapping file scopes.`,
    `4. **Review specialists — cover every applicable lens with at most two reviewer passes.** Always include \`${FLOOR_LENS}\`; add the specialists the diff raises — ${reviewLensMenu()} — and invent one the change demands. Bundle architecture in pass A and all other raised lenses in pass B; return a separate \`VERDICT: APPROVED\` or \`VERDICT: CHANGES_REQUESTED\` per lens.`,
    '',
    '## Checkpoints every review specialist applies',
    '',
    cp.length > 0
      ? cp
      : '_No project checkpoints set — review against the project conventions. Set them with `prjct crew checkpoints set`._',
    '',
    '## Rules',
    '- Review budget: at most two reviewer passes; changed hunks + direct dependencies only; one bounded pass; max 8 actionable findings and ~1,600 output tokens per pass. A clean evidence-backed verdict stops the stage.',
    '- If a judgment ledger is active, these reviewer passes fulfill its current card. Do not repeat review over unchanged content.',
    "- Point, don't carry: the plan/work/memory live in prjct — read them in each role (`prjct work --md`, `prjct spec show <id> --md`, `prjct context memory <topic>`), never paste them between roles.",
    '- Advance only when EVERY selected specialist returns APPROVED: run `prjct crew record-run …` (one durable row), THEN close the work cycle. If any returns CHANGES_REQUESTED, loop back to the implementer with the notes.',
    '- Persist ONLY through prjct verbs — SQLite is the only allowed surface. Never write reports/audits to disk.',
  ].join('\n')}\n`
}
