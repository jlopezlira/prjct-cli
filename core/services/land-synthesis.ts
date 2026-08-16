/**
 * Land auto-synthesis — write a Session-close hand-off without asking the
 * agent to type `prjct remember context "…"`.
 *
 * Competitive gap vs memory plugins that force the model to remember to
 * remember: prjct does the hand-off at `prjct land` and (best-effort) at
 * Stop when a cycle is still open. Deterministic synthesis from durable
 * signals (cycle, journal, recent commits, recent auto-captures) — not a
 * model call — so it works on weak models and never blocks session end.
 *
 * Quality bar: every field must carry signal. No "unknown" spam — omit
 * empty slots so the next session reads a dense model of what happened,
 * what was learned, and what to do next.
 */

import { execFileSync } from 'node:child_process'
import { projectMemory } from '../memory/project-memory'
import { prjctDb } from '../storage/database'
import { truncate } from '../utils/text-summary'
import { recentJournal } from './journal-queries'

const SOURCE_TAG = 'land-auto'
const TOPIC_KEY = 'session-close'

export interface LandSynthesisResult {
  wrote: boolean
  content: string | null
  reason?: string
}

export interface LandSynthesisInput {
  projectId: string
  projectPath: string
  /** When set, prefer this over a live task lookup (Stop already has overview). */
  cycleDescription?: string | null
  cycleId?: string | null
  author?: string
  model?: string
  tokensIn?: number
  tokensOut?: number
}

/**
 * Build + persist a living-context Session close entry.
 * Idempotent per (type=context, content hash) and topic upsert.
 */
export async function synthesizeLandHandoff(
  input: LandSynthesisInput
): Promise<LandSynthesisResult> {
  const content = buildLandHandoffContent(input)
  if (!content) {
    return { wrote: false, content: null, reason: 'nothing-to-land' }
  }

  try {
    await projectMemory.remember(input.projectPath, {
      type: 'context',
      content,
      tags: {
        source: SOURCE_TAG,
        topic: TOPIC_KEY,
        capture: 'land-v2',
        context_schema: 'living-v2',
        synthesis: 'deterministic',
      },
      provenance: 'extracted',
      projectId: input.projectId,
    })
    return { wrote: true, content }
  } catch (err) {
    return {
      wrote: false,
      content,
      reason: `remember-failed: ${(err as Error).message}`,
    }
  }
}

/**
 * Pure builder — exported for unit tests. Returns null when there is no
 * durable signal worth persisting (no cycle, no journal, no commits).
 */
export function buildLandHandoffContent(input: LandSynthesisInput): string | null {
  const cycle =
    input.cycleDescription?.trim() ||
    // sync lookup only when caller did not pass cycle
    null
  const journal = recentJournal(input.projectId, input.cycleId)
  const commits = recentCommits(input.projectPath)
  const autos = recentAutoCaptures(input.projectId)

  // Without any of these, a hand-off is empty noise.
  if (!cycle && journal.length === 0 && commits.length === 0 && autos.length === 0) {
    return null
  }

  const parts: string[] = []

  // Lead: one scannable sentence the next agent can act on.
  if (cycle) {
    parts.push(`Session close: Work cycle "${truncate(cycle, 120)}" still open or just closed.`)
  } else {
    parts.push('Session close: no open work cycle — landed repo + capture signals only.')
  }

  // Store still uses living-v2 field shape for parsers; lead sentence is the
  // synthesis value without relying on the label as the only scannable text.
  parts.push(
    'Context synthesis: Passive land hand-off from durable signals (cycle, journal, commits, auto-captures). Not a model essay.'
  )
  parts.push(`Key data: source=${SOURCE_TAG}; topic=${TOPIC_KEY}; capture=land-v2`)

  // What happened — cycle + journal trail (how the work evolved).
  const whatBits: string[] = []
  if (cycle) whatBits.push(`cycle="${truncate(cycle, 100)}"`)
  if (journal.length > 0) {
    whatBits.push(`journal: ${journal.map((j) => truncate(j, 70)).join(' · ')}`)
  }
  if (whatBits.length > 0) {
    parts.push(`What happened: ${whatBits.join('; ')}`)
  }

  if (journal.length > 0) {
    parts.push(
      `Why it mattered: Journal trail shows progression — ${journal
        .slice(0, 2)
        .map((j) => truncate(j, 80))
        .join(' · ')}`
    )
  }

  // Learned / traps — auto-captures are the session's new knowledge.
  if (autos.length > 0) {
    const learned = autos
      .filter((a) => a.type === 'learning' || a.type === 'decision' || a.type === 'fact')
      .slice(0, 4)
    const traps = autos.filter((a) => a.type === 'gotcha' || a.type === 'anti-pattern').slice(0, 3)
    if (learned.length > 0) {
      parts.push(
        `Learned this session: ${learned
          .map((a) => `[${a.type}] ${truncate(a.content, 100)}`)
          .join(' · ')}`
      )
    }
    if (traps.length > 0) {
      parts.push(
        `Decision/trap: ${traps.map((a) => `[${a.type}] ${truncate(a.content, 100)}`).join(' · ')}`
      )
    }
    // Remainder that wasn't classified above
    const used = new Set([...learned, ...traps])
    const rest = autos.filter((a) => !used.has(a)).slice(0, 3)
    if (rest.length > 0 && learned.length === 0 && traps.length === 0) {
      parts.push(
        `Decision/trap: ${rest.map((a) => `[${a.type}] ${truncate(a.content, 100)}`).join(' · ')}`
      )
    }
  }

  if (commits.length > 0) {
    parts.push(`Outcome: Recent commits: ${commits.join('; ')}`)
  }

  // Meta only when present — never "unknown".
  if (input.author) parts.push(`Who/author: ${input.author}`)
  if (input.model) parts.push(`Model: ${input.model}`)
  // Token economics (dominance vs GSD thrash): surface real spend when known.
  const tokIn = input.tokensIn
  const tokOut = input.tokensOut
  if (tokIn != null || tokOut != null) {
    const total = (tokIn ?? 0) + (tokOut ?? 0)
    parts.push(
      `Token usage: in=${tokIn ?? 0} out=${tokOut ?? 0} total=${total} (compound judgment — not a fresh-window thrash loop)`
    )
  }

  parts.push('Feature/domain: session-close')
  parts.push('Pattern: land auto-synthesis without agent remember')
  parts.push('Anti-pattern: relying on the model to remember to remember at session end')
  parts.push(
    'Competitive: next window must `prjct prime` — act as this developer with SQLite judgment, not re-research from zero (GSD tax).'
  )

  const next =
    cycle != null
      ? 'Finish or pause the open cycle (`prjct status done` / `prjct pause`); next agent should `prjct work --md` or `prjct prime`.'
      : 'Next agent: `prjct prime` then pick from `prjct next --md`.'
  parts.push(`Next implication: ${next}`)

  return parts.join(' · ')
}

function recentCommits(projectPath: string): string[] {
  try {
    const out = execFileSync('git', ['log', '-5', '--oneline', '--no-decorate'], {
      cwd: projectPath,
      encoding: 'utf-8',
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    return out
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
  } catch {
    return []
  }
}

function recentAutoCaptures(projectId: string): Array<{ type: string; content: string }> {
  try {
    const rows = prjctDb.query<{ type: string; content: string }>(
      projectId,
      `SELECT me.type, me.content
       FROM memory_entries me
       JOIN memory_entry_tags t ON t.entry_id = me.id
       WHERE me.deleted_at IS NULL
         AND t.key = 'source'
         AND t.value IN ('transcript-auto', 'land-auto')
       ORDER BY me.created_at DESC
       LIMIT 8`
    )
    return rows.map((r) => ({ type: r.type, content: r.content }))
  } catch {
    return []
  }
}
