/**
 * Living apply — when Rho-kept memory is used, treat it as SoT or live suggest.
 *
 *   - SoT (decision, gotcha, fact, declared learning, living-v2): BINDING
 *   - Suggest (pattern, anti-pattern, distill): propose live modifications
 * Hot-path cheap: type + tags only.
 */

import type { MemoryEntry } from '../../memory/entries'
import { deriveTitle } from '../../memory/format'

export type LivingRole = 'sot' | 'suggest' | 'context'

export interface LivingApplyLine {
  id: string
  type: string
  role: LivingRole
  line: string
  liveMod?: string
  files: string[]
}

const SOT_TYPES = new Set(['decision', 'gotcha', 'fact', 'spec', 'identity', 'voice', 'glossary'])
const SUGGEST_TYPES = new Set(['anti-pattern', 'pattern', 'learning', 'feedback'])
const PATH_RE = /\b[\w.-]+(?:\/[\w.-]+)+\.(?:ts|tsx|js|jsx|mjs|cjs|json|md|sh|toml|yml|yaml)\b/g

export function extractCitedFiles(content: string): string[] {
  const m = content.match(PATH_RE)
  if (!m) return []
  return [...new Set(m)].slice(0, 8)
}

export function classifyLivingRole(entry: MemoryEntry): LivingRole {
  if (entry.tags?.source === 'retention-distill') return 'suggest'
  if (entry.tags?.context_schema === 'living-v2' && entry.type === 'context') return 'sot'
  if (SOT_TYPES.has(entry.type)) return 'sot'
  if (entry.type === 'learning' && entry.provenance === 'declared') return 'sot'
  if (SUGGEST_TYPES.has(entry.type)) return 'suggest'
  return 'context'
}

function actionableClause(content: string): string {
  const next = content.match(
    /(?:next implication|next action|do not|never|always|must|should)\s*[:—-]?\s*([^.!\n]{12,160})/i
  )
  if (next?.[1]) return next[1].trim()
  const trap = content.match(/(?:anti-pattern|trap|gotcha|avoid)\s*[:—-]?\s*([^.!\n]{12,160})/i)
  if (trap?.[1]) return trap[1].trim()
  const sent = content.replace(/\s+/g, ' ').trim().slice(0, 140)
  return sent.endsWith('.') ? sent : `${sent}…`
}

export function buildLiveModSuggestion(entry: MemoryEntry): string | undefined {
  const files = extractCitedFiles(entry.content)
  const action = actionableClause(entry.content)
  if (files.length === 0 && action.length < 20) return undefined
  if (files.length > 0) return `Apply in \`${files.slice(0, 3).join('`, `')}\`: ${action}`
  return `Live change: ${action}`
}

export function formatLivingApplyLine(entry: MemoryEntry): LivingApplyLine {
  const role = classifyLivingRole(entry)
  const title = deriveTitle(entry)
  const files = extractCitedFiles(entry.content)
  const liveMod = role === 'suggest' || role === 'sot' ? buildLiveModSuggestion(entry) : undefined
  const roleTag = role === 'sot' ? 'SoT' : role === 'suggest' ? 'SUGGEST' : 'ctx'
  const suffix =
    role === 'sot'
      ? ' — tip→user · BINDING; supersede via `prjct remember` if wrong'
      : role === 'suggest' && liveMod
        ? ` — tip→user · ${liveMod.slice(0, 160)}`
        : role === 'suggest'
          ? ` — tip→user · ${actionableClause(entry.content).slice(0, 120)}`
          : ''
  const line = `[${roleTag}·${entry.type}] ${title}  \`${entry.id}\`${suffix}`
  return { id: entry.id, type: entry.type, role, line, liveMod, files }
}

export function buildLivingApplyBlock(
  entries: MemoryEntry[],
  opts: { maxSot?: number; maxSuggest?: number; maxContext?: number } = {}
): string | null {
  if (entries.length === 0) return null
  const lines = entries.map(formatLivingApplyLine)
  const sot = lines.filter((l) => l.role === 'sot').slice(0, opts.maxSot ?? 4)
  const sug = lines.filter((l) => l.role === 'suggest').slice(0, opts.maxSuggest ?? 3)
  const ctx = lines.filter((l) => l.role === 'context').slice(0, opts.maxContext ?? 2)
  if (sot.length === 0 && sug.length === 0 && ctx.length === 0) return null
  const out: string[] = ['# prjct: living knowledge (SoT · live suggest)']
  if (sot.length > 0) {
    out.push('## Source of truth (do not contradict without superseding)')
    for (const l of sot) out.push(`- ${l.line}`)
  }
  if (sug.length > 0) {
    out.push('## Live modification suggestions')
    for (const l2 of sug) {
      out.push(`- ${l2.line}`)
      if (l2.liveMod && !l2.line.includes(l2.liveMod.slice(0, 40))) out.push(`  → ${l2.liveMod}`)
    }
  }
  if (ctx.length > 0) {
    out.push('## Context')
    for (const l3 of ctx) out.push(`- ${l3.line}`)
  }
  return out.join('\n')
}
