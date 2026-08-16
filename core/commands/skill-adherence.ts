/**
 * Skill-adherence command — `prjct skill-adherence [window]`
 *
 * Read-only QA surface for harness #16 (Skill Resolution Feedback).
 * Reports, over a time window, how often captured project knowledge was
 * relevant to the work but went unreferenced (skill-misses), and how
 * many of those were subsequently resolved.
 *
 * A skill-miss = an `improvement-signal` written by `skill-miss-detector`.
 * A resolution = a `decision` tagged `resolves:skill-miss` (matched back
 * to the miss by its shared `relates:<memId>` tag when present). This
 * mirrors the existing advisory `resolves:improvement-signal` convention.
 *
 * No gate, no side effects — same read-only/Tier-1 contract as
 * `prjct retro` / `prjct health`.
 *
 * Windows: `prjct skill-adherence` (7d default) · `24h` · `14d` · `30d`.
 */

import configManager from '../infrastructure/config-manager'
import { projectMemory } from '../memory/project-memory'
import type { MdOption } from '../types/cli'
import type { CommandResult } from '../types/commands'
import { getErrorMessage } from '../types/fs'
import { parseWindowSpec } from '../utils/date-helper'
import { failHard } from '../utils/md-aware'
import out from '../utils/output'
import { PrjctCommandsBase } from './base'

interface MissRow {
  memId: string
  excerpt: string
  file: string
  rememberedAt: string
  resolved: boolean
}

export class SkillAdherenceCommands extends PrjctCommandsBase {
  async skillAdherence(
    arg: string | null = null,
    projectPath: string = process.cwd(),
    options: MdOption = {}
  ): Promise<CommandResult> {
    try {
      const initResult = await this.ensureProjectInit(projectPath)
      if (!initResult.success) return initResult

      const window = parseWindow(arg)
      if (!window) {
        out.fail(`Invalid window "${arg}". Use: 7d, 24h, 14d, 30d (units: h or d).`)
        return { success: false, error: 'Invalid window' }
      }

      const config = await configManager.readConfig(projectPath)
      if (!config?.projectId) {
        out.fail('No prjct project here — run `prjct start` first.')
        return { success: false, error: 'No project' }
      }

      const sinceMs = Date.now() - window.hours * 60 * 60 * 1000

      const misses = projectMemory
        .recall(config.projectId, {
          types: ['improvement-signal'],
          tags: { source: 'skill-miss-detector' },
          limit: 300,
          dedupeByKey: false,
        })
        .filter((e) => Date.parse(e.rememberedAt) >= sinceMs)

      // Resolutions: decisions tagged resolves:skill-miss in the window.
      // Indexed by the `relates` mem-id they point back at; a bare
      // resolves:skill-miss with no relates counts as a general signal
      // the user addressed the surface but doesn't match a specific row.
      const resolutions = projectMemory
        .recall(config.projectId, {
          types: ['decision'],
          tags: { resolves: 'skill-miss' },
          limit: 300,
          dedupeByKey: false,
        })
        .filter((e) => Date.parse(e.rememberedAt) >= sinceMs)
      const resolvedRelates = new Set(
        resolutions.map((e) => e.tags.relates).filter((r): r is string => Boolean(r))
      )

      const rows: MissRow[] = misses.map((e) => ({
        memId: e.tags.relates ?? '—',
        excerpt: firstLine(e.content),
        file: e.tags.file ?? '',
        rememberedAt: e.rememberedAt,
        resolved: e.tags.relates ? resolvedRelates.has(e.tags.relates) : false,
      }))

      const total = rows.length
      const resolved = rows.filter((r) => r.resolved).length
      const ratio = total === 0 ? 1 : resolved / total

      if (options.md) {
        console.log(formatMarkdown(window.label, rows, total, resolved, ratio, resolutions.length))
      } else {
        console.log(formatText(window.label, rows, total, resolved, ratio))
      }

      return {
        success: true,
        window: window.label,
        misses: total,
        resolved,
        adherence: Number(ratio.toFixed(2)),
      }
    } catch (error) {
      return failHard(getErrorMessage(error))
    }
  }
}

// Window parsing — same grammar as `prjct retro`.

interface ParsedWindow {
  label: string
  hours: number
}

function parseWindow(arg: string | null): ParsedWindow | null {
  const spec = parseWindowSpec(arg)
  if (!spec) return null
  return spec.unit === 'h'
    ? { label: `${spec.n}h`, hours: spec.n }
    : { label: `${spec.n}d`, hours: spec.n * 24 }
}

function firstLine(content: string): string {
  const line = content.split('\n')[0] ?? ''
  return line.replace(/^\[skill-miss\]\s*/, '').trim()
}

// Output formatters

function formatText(
  label: string,
  rows: MissRow[],
  total: number,
  resolved: number,
  ratio: number
): string {
  if (total === 0) {
    return `Skill adherence — last ${label}: no skill-misses captured. Clean.`
  }
  const lines: string[] = []
  lines.push(
    `Skill adherence — last ${label} · ${total} miss${total === 1 ? '' : 'es'} · ${resolved} resolved · ${(ratio * 100).toFixed(0)}% addressed`
  )
  lines.push('')
  for (const r of rows.slice(0, 20)) {
    const mark = r.resolved ? '✓' : '·'
    const where = r.file ? ` (${r.file})` : ''
    lines.push(`  ${mark} ${r.memId}${where}  ${r.excerpt.slice(0, 100)}`)
  }
  return lines.join('\n')
}

function formatMarkdown(
  label: string,
  rows: MissRow[],
  total: number,
  resolved: number,
  ratio: number,
  resolutionCount: number
): string {
  if (total === 0) {
    return `## Skill adherence — last ${label}\n\n_No skill-misses captured in the window._\n`
  }
  const lines: string[] = []
  lines.push(`## Skill adherence — last ${label}`)
  lines.push('')
  lines.push(`- **Skill-misses**: ${total}`)
  lines.push(`- **Resolved**: ${resolved} (${(ratio * 100).toFixed(0)}% addressed)`)
  lines.push(`- **Resolution decisions logged**: ${resolutionCount}`)
  lines.push('')
  lines.push('| State | Memory | File | Signal |')
  lines.push('|---|---|---|---|')
  for (const r of rows.slice(0, 30)) {
    const state = r.resolved ? '✓ resolved' : '· open'
    const file = r.file || '—'
    const excerpt = r.excerpt.slice(0, 110).replace(/\|/g, '\\|')
    lines.push(`| ${state} | ${r.memId} | ${file} | ${excerpt} |`)
  }
  return lines.join('\n')
}
