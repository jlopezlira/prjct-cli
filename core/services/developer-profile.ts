/**
 * Developer profile synthesis — the "know the developer" half of the RAG
 * north star. Rescued from the retired wiki builders (WS-A): this is a pure
 * markdown-string function, not vault I/O, and backs the `prjct_developer`
 * MCP tool.
 *
 * prjct already captures who the developer is, scattered across two memory
 * streams: explicit `feedback` (the rules they stated — "memory in English",
 * "no native deps", "ship as minor") and `improvement-signal` friction (the
 * moments they pushed back). This builder synthesizes them into one profile
 * so an agent can act as the developer would WITHOUT being told each time.
 *
 * Deterministic; no LLM. Returns null when there's nothing to say yet.
 *
 * Quality bar (apply-loop): the profile must be *actionable on first read* —
 * lead with distilled rules the model can obey, not a dump of raw history.
 * SessionStart digests reuse {@link extractDeveloperRules} so cold-start
 * models act as the developer without needing the MCP pull instinct.
 */

import type { MemoryEntry } from '../memory/entries'
import { deriveTitle } from '../memory/format'
import { summarizeFrictionLesson, truncate } from '../utils/text-summary'

const MAX_PREFERENCES = 25
const MAX_FRICTION = 15
const MAX_PRINCIPLES = 10
const MAX_LEAD_RULES = 6

function teaser(content: string): string {
  return truncate(content.replace(/\s+/g, ' ').trim(), 200)
}

/** Structured lessons lead; legacy rows fall back to their first line. */
function frictionLine(content: string): string {
  return summarizeFrictionLesson(content, 240)
}

/**
 * Distill standing rules the agent should obey without re-reading history.
 * Preferences first (developer said so), then friction next-actions / lessons
 * (developer showed so by pushback). Deduped, newest-first within each class.
 */
export function extractDeveloperRules(
  declared: MemoryEntry[],
  limit = MAX_LEAD_RULES
): Array<{ rule: string; sourceId: string; kind: 'preference' | 'friction' }> {
  const out: Array<{ rule: string; sourceId: string; kind: 'preference' | 'friction' }> = []
  const seen = new Set<string>()

  const push = (raw: string, sourceId: string, kind: 'preference' | 'friction') => {
    const rule = normalizeRule(raw)
    if (!rule || rule.length < 12) return
    const key = rule.toLowerCase()
    if (seen.has(key)) return
    seen.add(key)
    out.push({ rule, sourceId, kind })
  }

  // `declared` is newest-first; recent guidance reflects current preference.
  for (const p of declared.filter((e) => e.type === 'feedback')) {
    if (out.length >= limit) break
    push(p.content, p.id, 'preference')
  }

  for (const f of declared.filter(
    (e) => e.type === 'improvement-signal' && e.tags?.source === 'friction-detector'
  )) {
    if (out.length >= limit) break
    const next = extractNextAction(f.content) ?? extractLesson(f.content)
    if (next) push(next, f.id, 'friction')
  }

  return out
}

function normalizeRule(raw: string): string {
  return raw
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[-*•]\s+/, '')
}

function extractNextAction(content: string): string | null {
  const m = content.match(/^Next action:\s*(.+)$/im)
  return m?.[1]?.trim() || null
}

function extractLesson(content: string): string | null {
  const first = content.split('\n').map((l) => l.trim())[0] ?? ''
  const m = first.match(/^\[[^\]]+\]\s+Lesson:\s*(.+)$/i)
  if (m?.[1]) return m[1].trim()
  // Legacy: "[negation] User pushback: \"…\"" — keep usable.
  if (/^\[[^\]]+\]/.test(first) && first.length > 20) return first
  return null
}

/**
 * Working principles = friction next-actions only (what NOT to repeat).
 * Distinct from lead rules so the full profile can show "do this instead".
 */
function extractWorkingPrinciples(declared: MemoryEntry[], limit = MAX_PRINCIPLES): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const f of declared.filter(
    (e) => e.type === 'improvement-signal' && e.tags?.source === 'friction-detector'
  )) {
    const next = extractNextAction(f.content)
    if (!next) continue
    const n = normalizeRule(next)
    const key = n.toLowerCase()
    if (seen.has(key) || n.length < 12) continue
    seen.add(key)
    out.push(n)
    if (out.length >= limit) break
  }
  return out
}

export function buildDeveloperProfile(declared: MemoryEntry[]): string | null {
  // `declared` is newest-first; recent guidance reflects current preference.
  const preferences = declared.filter((e) => e.type === 'feedback').slice(0, MAX_PREFERENCES)
  const friction = declared
    .filter((e) => e.type === 'improvement-signal' && e.tags?.source === 'friction-detector')
    .slice(0, MAX_FRICTION)

  if (preferences.length === 0 && friction.length === 0) return null

  const leadRules = extractDeveloperRules(declared, MAX_LEAD_RULES)
  const principles = extractWorkingPrinciples(declared, MAX_PRINCIPLES)

  const lines: string[] = ['# Developer profile', '']
  lines.push(
    '> Synthesized from the developer’s stated feedback and their pushback.',
    '> Read this to act as they would — match these preferences without being asked.',
    ''
  )

  // Lead block: the model of "who to be" on first screenful — apply-loop.
  if (leadRules.length > 0) {
    lines.push('## Act as this developer — rules in force', '')
    for (const r of leadRules) {
      const tag = r.kind === 'preference' ? 'said' : 'showed'
      lines.push(`- ${r.rule}  \`${r.sourceId}\` _(${tag})_`)
    }
    lines.push('')
  }

  if (preferences.length > 0) {
    lines.push('## Preferences & guidance — the rules to follow', '')
    for (const p of preferences)
      lines.push(`- **${deriveTitle(p)}** — ${teaser(p.content)}  \`${p.id}\``)
    lines.push('')
  }

  if (principles.length > 0) {
    lines.push('## Working principles — from their pushback (do this instead)', '')
    for (const p2 of principles) lines.push(`- ${p2}`)
    lines.push('')
  }

  if (friction.length > 0) {
    lines.push('## Friction history — what frustrated them, do not repeat', '')
    for (const f of friction) lines.push(`- ${frictionLine(f.content)}  \`${f.id}\``)
    lines.push('')
  }

  return `${lines.join('\n')}\n`
}
