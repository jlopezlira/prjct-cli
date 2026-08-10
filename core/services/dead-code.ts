/**
 * Dead-code surface — symbols with zero inbound CALLS (excluding entry points).
 */

import { hasSymbolIndex, listAllSymbols, loadMeta } from '../domain/symbol-graph'
import prjctDb from '../storage/database'
import type { CodeSymbol } from '../types/domain.js'

const ENTRY_NAME =
  /^(main|index|app|server|cli|handler|router|bootstrap|init|start|run|default|setup|config|plugin|middleware|layout|page|loader|action)$/i

const ENTRY_PATH =
  /(?:^|\/)(?:bin\/|scripts\/|cli\.|main\.|index\.|app\.|server\.|page\.|layout\.|route\.|middleware\.)/i

export interface DeadCodeHit {
  symbol: CodeSymbol
  reason: string
}

export interface DeadCodeResult {
  ready: boolean
  totalSymbols: number
  dead: DeadCodeHit[]
  skippedEntries: number
  note: string
}

function isEntryPoint(s: CodeSymbol): boolean {
  if (s.kind === 'route') return true
  if (ENTRY_NAME.test(s.name) && s.exported) return true
  if (ENTRY_PATH.test(s.file) && s.exported) return true
  // Test harness symbols are not dead-code targets of interest for product
  if (/__tests__|\.test\.|\.spec\.|fixtures?\//i.test(s.file)) return true
  // Types/interfaces/enums rarely "called"
  if (s.kind === 'type' || s.kind === 'interface' || s.kind === 'enum') return true
  // Consts often re-exported config — skip non-functions/classes/methods
  if (s.kind === 'const') return true
  return false
}

function loadCallersOf(projectId: string): Set<string> {
  const hasCaller = new Set<string>()
  try {
    const rows = prjctDb.query<{ dst: string }>(
      projectId,
      `SELECT DISTINCT dst FROM code_symbol_edges WHERE edge_type = 'CALLS'`
    )
    for (const r of rows) hasCaller.add(r.dst)
  } catch {
    /* empty */
  }
  return hasCaller
}

export function findDeadCode(projectId: string, opts: { limit?: number } = {}): DeadCodeResult {
  const limit = opts.limit ?? 50
  if (!hasSymbolIndex(projectId)) {
    return {
      ready: false,
      totalSymbols: 0,
      dead: [],
      skippedEntries: 0,
      note: 'No symbol index. Run `prjct sync` or `prjct code reindex`.',
    }
  }

  const symbols = listAllSymbols(projectId)
  const hasCaller = loadCallersOf(projectId)
  const dead: DeadCodeHit[] = []
  const skippedEntries = symbols.filter(isEntryPoint).length

  for (const s2 of symbols) {
    if (isEntryPoint(s2)) continue
    if (s2.kind !== 'function' && s2.kind !== 'method' && s2.kind !== 'class') continue
    if (hasCaller.has(s2.id)) continue
    dead.push({
      symbol: s2,
      reason: s2.exported ? 'exported but no inbound CALLS in graph' : 'no inbound CALLS in graph',
    })
    if (dead.length >= limit) break
  }

  // Prefer exported dead first (more actionable)
  dead.sort((a, b) => {
    const ae = a.symbol.exported ? 0 : 1
    const be = b.symbol.exported ? 0 : 1
    if (ae !== be) return ae - be
    return a.symbol.file.localeCompare(b.symbol.file)
  })

  const meta = loadMeta(projectId)
  return {
    ready: true,
    totalSymbols: meta?.symbolCount ?? symbols.length,
    dead,
    skippedEntries,
    note: 'Best-effort: regex CALLS graph. Dynamic dispatch / reflection may false-positive. Entry points + tests + types excluded.',
  }
}

export function formatDeadCodeMd(r: DeadCodeResult): string {
  if (!r.ready) return `## Dead code\n\n> ${r.note}\n`
  const lines = [
    '## Dead code (zero inbound CALLS)',
    '',
    `- **Candidates**: ${r.dead.length} (cap)`,
    `- **Symbols scanned**: ${r.totalSymbols}`,
    `- **Skipped entry/types/tests**: ${r.skippedEntries}`,
    '',
  ]
  if (r.dead.length === 0) {
    lines.push('_None found (or all have callers / are entries)._')
  } else {
    for (const d of r.dead) {
      const s = d.symbol
      lines.push(
        `- \`${s.kind}\` **${s.name}** — \`${s.file}:${s.startLine}\`${s.exported ? ' (exported)' : ''}`
      )
      lines.push(`  - ${d.reason}`)
    }
  }
  lines.push('', `_${r.note}_`)
  return lines.join('\n')
}

export function formatDeadCodeText(r: DeadCodeResult): string {
  if (!r.ready) return `dead-code: ${r.note}`
  const lines = [`Dead code: ${r.dead.length} candidate(s) (of ${r.totalSymbols} symbols)`]
  for (const d of r.dead.slice(0, 30)) {
    lines.push(`  ${d.symbol.kind} ${d.symbol.name}  ${d.symbol.file}:${d.symbol.startLine}`)
  }
  return lines.join('\n')
}
