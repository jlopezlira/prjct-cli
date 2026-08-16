/**
 * Judgment Receipt — closed-loop proof of applied engineering judgment.
 *
 * Pure builder + persist helper. No new CLI verb: land / Stop write the
 * receipt; SessionStart land-cue may mention the latest one (24h).
 *
 * Positioning (mem_3919): continuity of judgment, not "AI memory product".
 */

import { projectMemory } from '../memory/project-memory'
import { prjctDb } from '../storage/database'
import { truncate } from '../utils/text-summary'
import { recentJournal } from './journal-queries'

export const RECEIPT_SOURCE = 'land-receipt'
export const RECEIPT_TOPIC = 'judgment-receipt'
export const RECEIPT_CAPTURE = 'receipt-v1'

export interface ReceiptSurface {
  id: string
  type: string
  title: string
}

export interface JudgmentReceiptInput {
  cycleDescription?: string | null
  cycleId?: string | null
  /** Preventive memories surfaced this session / cycle (gotchas applied). */
  trapsSurfaced?: ReceiptSurface[]
  /** Decisions contested (conflict warn/deny) or honored. */
  decisions?: Array<ReceiptSurface & { status: 'contested' | 'honored' }>
  journal?: string[]
  openRisksNext?: string[]
  tokensIn?: number
  tokensOut?: number
  model?: string
  author?: string
}

/**
 * Pure builder. Returns null when there is no durable signal.
 * Omits empty sections entirely.
 */
export function buildJudgmentReceipt(input: JudgmentReceiptInput): string | null {
  const traps = input.trapsSurfaced ?? []
  const decisions = input.decisions ?? []
  const journal = (input.journal ?? []).filter((j) => j.trim())
  const risks = (input.openRisksNext ?? []).filter((r) => r.trim())
  const cycle = input.cycleDescription?.trim() || null
  const hasEcon = input.tokensIn != null || input.tokensOut != null || Boolean(input.model)

  if (
    !cycle &&
    traps.length === 0 &&
    decisions.length === 0 &&
    journal.length === 0 &&
    risks.length === 0 &&
    !hasEcon
  ) {
    return null
  }

  const sections: string[] = ['# Judgment Receipt', '']

  // Applied judgment — cycle + journal progression
  const applied: string[] = []
  if (cycle) applied.push(`cycle: "${truncate(cycle, 100)}"`)
  if (journal.length > 0) {
    applied.push(
      `journal: ${journal
        .slice(0, 4)
        .map((j) => truncate(j, 70))
        .join(' · ')}`
    )
  }
  if (applied.length > 0) {
    sections.push('## Applied judgment', ...applied.map((a) => `- ${a}`), '')
  }

  if (traps.length > 0) {
    sections.push(
      '## Traps re-surfaced',
      ...traps.slice(0, 8).map((t) => `- **[${t.type}]** ${truncate(t.title, 100)} \`${t.id}\``),
      ''
    )
  }

  if (decisions.length > 0) {
    sections.push(
      '## Decisions contested or honored',
      ...decisions
        .slice(0, 8)
        .map((d) => `- **${d.status}** [${d.type}] ${truncate(d.title, 100)} \`${d.id}\``),
      ''
    )
  }

  if (risks.length > 0 || cycle) {
    const riskLines =
      risks.length > 0
        ? risks.slice(0, 5).map((r) => `- ${truncate(r, 120)}`)
        : [`- Finish or pause open cycle; next agent: \`prjct prime\` / \`prjct work --md\`.`]
    sections.push('## Open risks / next', ...riskLines, '')
  }

  if (hasEcon) {
    const bits: string[] = []
    if (input.tokensIn != null || input.tokensOut != null) {
      const tin = input.tokensIn ?? 0
      const tout = input.tokensOut ?? 0
      bits.push(`tokens in=${tin} out=${tout} total=${tin + tout}`)
    }
    if (input.model) bits.push(`model=${input.model}`)
    if (input.author) bits.push(`author=${input.author}`)
    sections.push('## Session economics', `- ${bits.join(' · ')}`, '')
  }

  sections.push(
    '_Closed-loop judgment continuity — not bulk memory. Proof of traps prevented and decisions applied._'
  )

  return sections.join('\n').trim()
}

/** One-line summary for land CLI output. */
export function summarizeJudgmentReceipt(content: string | null): string | null {
  if (!content) return null
  const traps = (content.match(/## Traps re-surfaced/g) || []).length
  const trapBullets = countSectionBullets(content, 'Traps re-surfaced')
  const decisionBullets = countSectionBullets(content, 'Decisions contested or honored')
  const bits: string[] = []
  if (trapBullets > 0) bits.push(`${trapBullets} trap(s) re-surfaced`)
  if (decisionBullets > 0) bits.push(`${decisionBullets} decision(s) tracked`)
  if (bits.length === 0) bits.push('session judgment landed')
  return `Judgment receipt: ${bits.join(', ')}${traps ? '' : ''}`
}

function countSectionBullets(md: string, heading: string): number {
  const re = new RegExp(`## ${heading}\\n([\\s\\S]*?)(?=\\n## |\\n_|$)`)
  const m = md.match(re)
  if (!m) return 0
  return (m[1].match(/^- /gm) || []).length
}

export interface PersistReceiptResult {
  wrote: boolean
  content: string | null
  summary: string | null
  reason?: string
}

/**
 * Persist receipt as context memory with required tags.
 */
export async function persistJudgmentReceipt(
  projectPath: string,
  projectId: string,
  input: JudgmentReceiptInput
): Promise<PersistReceiptResult> {
  const content = buildJudgmentReceipt(input)
  if (!content) {
    return { wrote: false, content: null, summary: null, reason: 'nothing-to-receipt' }
  }
  try {
    await projectMemory.remember(projectPath, {
      type: 'context',
      content,
      tags: {
        source: RECEIPT_SOURCE,
        topic: RECEIPT_TOPIC,
        capture: RECEIPT_CAPTURE,
        synthesis: 'deterministic',
      },
      provenance: 'extracted',
      projectId,
    })
    return {
      wrote: true,
      content,
      summary: summarizeJudgmentReceipt(content),
    }
  } catch (err) {
    return {
      wrote: false,
      content,
      summary: summarizeJudgmentReceipt(content),
      reason: `remember-failed: ${(err as Error).message}`,
    }
  }
}

/**
 * Gather signal from DB for a land/stop path and persist a receipt.
 */
export async function synthesizeJudgmentReceipt(input: {
  projectId: string
  projectPath: string
  cycleDescription?: string | null
  cycleId?: string | null
  tokensIn?: number
  tokensOut?: number
  model?: string
  author?: string
}): Promise<PersistReceiptResult> {
  const journal = recentJournal(input.projectId, input.cycleId)
  const traps = recentSurfacedTraps(input.projectId)
  const decisions = recentConflictDecisions(input.projectId)
  return persistJudgmentReceipt(input.projectPath, input.projectId, {
    cycleDescription: input.cycleDescription,
    cycleId: input.cycleId,
    journal,
    trapsSurfaced: traps,
    decisions,
    tokensIn: input.tokensIn,
    tokensOut: input.tokensOut,
    model: input.model,
    author: input.author,
    openRisksNext: input.cycleDescription
      ? ['Open cycle still needs finish or pause before context dies.']
      : [],
  })
}

/** Latest receipt within 24h for SessionStart cue. */
export function latestJudgmentReceipt24h(
  projectId: string
): { id: string; content: string; trapCount: number } | null {
  try {
    const since = Date.now() - 24 * 60 * 60 * 1000
    const rows = prjctDb.query<{ id: string; content: string }>(
      projectId,
      `SELECT me.id, me.content
       FROM memory_entries me
       JOIN memory_entry_tags t ON t.entry_id = me.id
       WHERE me.deleted_at IS NULL
         AND me.created_at >= ?
         AND t.key = 'capture' AND t.value = ?
       ORDER BY me.created_at DESC
       LIMIT 1`,
      since,
      RECEIPT_CAPTURE
    )
    const row = rows[0]
    if (!row) return null
    return {
      id: row.id,
      content: row.content,
      trapCount: countSectionBullets(row.content, 'Traps re-surfaced'),
    }
  } catch {
    return null
  }
}

export function countReceiptsWritten(projectId: string, sinceMs?: number): number {
  try {
    const since = sinceMs ?? 0
    const row = prjctDb.get<{ c: number }>(
      projectId,
      `SELECT COUNT(*) AS c
       FROM memory_entries me
       JOIN memory_entry_tags t ON t.entry_id = me.id
       WHERE me.deleted_at IS NULL
         AND me.created_at >= ?
         AND t.key = 'capture' AND t.value = ?`,
      since,
      RECEIPT_CAPTURE
    )
    return row?.c ?? 0
  } catch {
    return 0
  }
}

function recentSurfacedTraps(projectId: string): ReceiptSurface[] {
  try {
    // Recent preventive-type memories (gotchas / anti-patterns) as proxy for
    // traps the project holds — surface-attribution may also write tags.
    const rows = prjctDb.query<{ id: string; type: string; content: string }>(
      projectId,
      `SELECT id, type, content FROM memory_entries
       WHERE deleted_at IS NULL
         AND type IN ('gotcha', 'anti-pattern')
       ORDER BY created_at DESC
       LIMIT 5`
    )
    return rows.map((r) => ({
      id: r.id,
      type: r.type,
      title: r.content.replace(/\s+/g, ' ').trim().slice(0, 120),
    }))
  } catch {
    return []
  }
}

function recentConflictDecisions(
  projectId: string
): Array<ReceiptSurface & { status: 'contested' | 'honored' }> {
  try {
    const rows = prjctDb.query<{ id: string; type: string; content: string; action: string }>(
      projectId,
      `SELECT me.id, me.type, me.content, t.value AS action
       FROM memory_entries me
       JOIN memory_entry_tags t ON t.entry_id = me.id AND t.key = 'conflict_action'
       WHERE me.deleted_at IS NULL
         AND me.created_at >= ?
       ORDER BY me.created_at DESC
       LIMIT 8`,
      Date.now() - 24 * 60 * 60 * 1000
    )
    return rows.map((r) => ({
      id: r.id,
      type: r.type,
      title: r.content.replace(/\s+/g, ' ').trim().slice(0, 120),
      status:
        r.action === 'deny' || r.action === 'warn' ? ('contested' as const) : ('honored' as const),
    }))
  } catch {
    return []
  }
}
