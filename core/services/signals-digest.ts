/**
 * Machine-signal digest — rescued from the retired wiki builders (WS-A):
 * this is a pure markdown-string function, not vault I/O, and backs the
 * `prjct_signals` MCP tool.
 *
 * Auto-detectors (hot-file churn, skill-miss, friction, recurring bugs)
 * write their output into project memory as regular entries. That is right
 * for the DB — recall and the hooks feed on them — but it is telemetry, not
 * curated knowledge, so it gets its own compact digest rather than being
 * mixed into topical recall.
 */

import type { MemoryEntry } from '../memory/entries'
import { linkifyMemRefs } from '../memory/format'
import { summarizeFrictionLesson, truncate } from '../utils/text-summary'

/** `tags.source` values produced by automatic detectors, not by an agent/user. */
export const MACHINE_SOURCES: ReadonlySet<string> = new Set([
  'pattern-detector-auto',
  'pattern-detector-recurring',
  'skill-miss-detector',
  'friction-detector',
])

/**
 * Telemetry, not knowledge: everything typed `improvement-signal` plus
 * any entry stamped by a machine detector (hot-file churn entries are
 * stored as type `learning` but are pure telemetry).
 */
export function isSignalEntry(e: Pick<MemoryEntry, 'type' | 'tags'>): boolean {
  if (e.type === 'improvement-signal') return true
  const source = e.tags?.source
  return source !== undefined && MACHINE_SOURCES.has(source)
}

function dateOnly(iso: string): string {
  const m = (iso || '').match(/^(\d{4}-\d{2}-\d{2})/)
  return m ? m[1] : ''
}

function oneLine(content: string, max = 220): string {
  return truncate((content.split('\n')[0] ?? content).replace(/\s+/g, ' ').trim(), max)
}

type Section = { title: string; intro: string; rows: string[] }

/**
 * Single digest of all machine signals. Returns null when the project has
 * none (no empty stub).
 *
 * `opts` is narrowed to just `boundary` (not the full FormatMemoryMdOptions)
 * — this digest is MCP-tool output, not a vault page, so the Obsidian-only
 * fields (vault/idTypeIndex/idTitleIndex/idSlugIndex/perEntryTypes/signalIds)
 * must never reach linkifyMemRefs here, or a mem_N reference would render as
 * `[[type#^mem-N|title]]` wikilink syntax with no vault to resolve it.
 */
export function buildSignalsFile(
  signals: MemoryEntry[],
  opts: { boundary?: 'llm' }
): string | null {
  if (signals.length === 0) return null

  const hotFiles: MemoryEntry[] = []
  const recurring: MemoryEntry[] = []
  const skillMisses: MemoryEntry[] = []
  const friction: MemoryEntry[] = []
  const other: MemoryEntry[] = []
  for (const e of signals) {
    const source = e.tags?.source
    if (source === 'pattern-detector-auto') hotFiles.push(e)
    else if (source === 'pattern-detector-recurring') recurring.push(e)
    else if (source === 'skill-miss-detector') skillMisses.push(e)
    else if (source === 'friction-detector') friction.push(e)
    else other.push(e)
  }

  // Plain id reference — this used to be an Obsidian block anchor
  // (`^mem-N`, so other vault pages could link `[[signals#^mem-N]]`); with
  // no vault, that syntax is meaningless noise in MCP tool output, so this
  // just names the id for traceability (`prjct context memory <id>`).
  const idRef = (e: MemoryEntry) => `\`${e.id}\``
  const stamp = (e: MemoryEntry) => {
    const d = dateOnly(e.rememberedAt)
    return d ? ` _(${d})_` : ''
  }

  const sections: Section[] = []

  if (hotFiles.length > 0) {
    // Newest entry per file leads; older churn entries for the same
    // file stay listed but compactly.
    const byFile = new Map<string, MemoryEntry[]>()
    for (const e2 of hotFiles) {
      const file = e2.tags?.file ?? '(unknown file)'
      const bucket = byFile.get(file) ?? []
      bucket.push(e2)
      byFile.set(file, bucket)
    }
    const rows: string[] = []
    const sorted = [...byFile.entries()].sort((a, b) => b[1].length - a[1].length)
    for (const [file, items] of sorted) {
      const [latest, ...older] = items
      const touches = latest.tags?.touches ? `${latest.tags.touches} touches` : 'churning'
      const win = latest.tags?.window_days ?? latest.tags?.['window-days']
      const window = win ? ` in ${win}d` : ''
      rows.push(`- \`${file}\` — ${touches}${window}${stamp(latest)} ${idRef(latest)}`)
      for (const o of older) rows.push(`    - earlier sighting${stamp(o)} ${idRef(o)}`)
    }
    sections.push({
      title: 'Hot files',
      intro: 'Files that keep churning — refactor candidates or deliberate hubs.',
      rows,
    })
  }

  if (recurring.length > 0) {
    sections.push({
      title: 'Recurring patterns',
      intro: 'The same class of change keeps happening.',
      rows: recurring.map((e) => `- ${oneLine(e.content)}${stamp(e)} ${idRef(e)}`),
    })
  }

  if (skillMisses.length > 0) {
    sections.push({
      title: 'Knowledge being missed',
      intro: 'Project knowledge existed but was not applied in a session.',
      rows: skillMisses.map(
        (e) => `- ${linkifyMemRefs(oneLine(e.content), opts)}${stamp(e)} ${idRef(e)}`
      ),
    })
  }

  if (friction.length > 0) {
    sections.push({
      title: 'Friction',
      intro: 'Processed lessons from developer pushback — do not repeat.',
      rows: friction.map((e) => `- ${summarizeFrictionLesson(e.content)}${stamp(e)} ${idRef(e)}`),
    })
  }

  if (other.length > 0) {
    sections.push({
      title: 'Other signals',
      intro: '',
      rows: other.map(
        (e) => `- ${linkifyMemRefs(oneLine(e.content), opts)}${stamp(e)} ${idRef(e)}`
      ),
    })
  }

  const lines: string[] = [
    '# Signals (machine telemetry)',
    '',
    '> Auto-detected by prjct — churn, missed knowledge, friction. This is',
    '> telemetry, not curated knowledge: act on it, then let it expire.',
    `> ${signals.length} signal${signals.length === 1 ? '' : 's'} recorded.`,
  ]
  for (const s of sections) {
    lines.push('', `## ${s.title}`, '')
    if (s.intro) lines.push(`_${s.intro}_`, '')
    lines.push(...s.rows)
  }
  lines.push('')
  return lines.join('\n')
}
