/**
 * LLM Analysis Commands — `saveLlmAnalysis` + `getLlmAnalysis`.
 *
 * Extracted from the AnalysisCommands god-class so the file stays
 * under the 500-LOC limit. Both functions use only `requireProject`
 * from the guards module + the storage layer; no `this` access.
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import { parseLlmAnalysis } from '../../schemas/llm-analysis'
import { isRichLlmAnalysis, isThinLlmAnalysis } from '../../services/project-style-profile'
import llmAnalysisStorage from '../../storage/llm-analysis-storage'
import type { MdOption } from '../../types/cli'
import type { CommandResult } from '../../types/commands'
import type { LLMAnalysis } from '../../types/llm-analysis'
import { getTimestamp } from '../../utils/date-helper'
import { execFileAsync } from '../../utils/exec'
import { failFromError } from '../../utils/md-aware'
import { mdDone, mdList, mdOutput, mdSection, mdStats, mdWarn } from '../../utils/md-formatter'
import { requireProject } from '../guards'

export async function saveLlmAnalysis(
  analysisInput: string,
  projectPath: string = process.cwd(),
  options: MdOption = {}
): Promise<CommandResult> {
  try {
    const proj = await requireProject(projectPath)
    if (!proj.ok) return proj.result
    const projectId = proj.value

    const resolved = await resolveAnalysisInput(analysisInput, projectPath)
    const normalized = await normalizeAnalysis(resolved.content, projectPath)

    // Anti-clobber (mem_8432): freeform markdown/notes yield style=unknown +
    // empty patterns. Never supersede a rich house-style analysis with that —
    // fold insights into the existing active analysis instead.
    const previous = llmAnalysisStorage.getActive(projectId)
    const mergedNotes = Boolean(
      previous && isRichLlmAnalysis(previous) && isThinLlmAnalysis(normalized)
    )
    const analysis = mergedNotes
      ? mergeThinNotesIntoRich(previous as NonNullable<typeof previous>, normalized)
      : normalized

    llmAnalysisStorage.save(projectId, analysis)

    // Refresh project style model when a structured save lands (or notes merge
    // into rich). Best-effort — save already succeeded.
    try {
      const { recomputeProjectStyle } = await import('../../services/project-style-evolution')
      const { gatherStats, detectStack, detectCommands } = await import(
        '../../services/sync-analyzer'
      )
      const [stats, stack, commands] = await Promise.all([
        gatherStats(projectPath),
        detectStack(projectPath),
        detectCommands(projectPath),
      ])
      await recomputeProjectStyle({
        projectId,
        projectPath,
        stats,
        stack,
        commands,
        commitHash: analysis.commitHash,
        source: 'analysis-save',
      })
    } catch {
      /* style recompute is best-effort after analysis save */
    }

    const thinStandalone = isThinLlmAnalysis(analysis) && !mergedNotes

    if (options.md) {
      const title = mergedNotes
        ? 'LLM Analysis Notes Merged (house style preserved)'
        : thinStandalone
          ? 'LLM Analysis Notes Saved (thin — not house style)'
          : 'LLM Analysis Saved'
      const sections = [
        mdDone(title),
        mdStats({
          Input: resolved.source,
          Architecture: analysis.architecture.style,
          Patterns: analysis.patterns.length,
          'Anti-patterns': analysis.antiPatterns?.length || 0,
          'Tech debt items': analysis.techDebt?.length || 0,
          'Risk areas': analysis.riskAreas?.length || 0,
          Conventions: analysis.conventions?.length || 0,
          ...(mergedNotes ? { Merge: 'thin notes → existing rich analysis' } : {}),
          ...(thinStandalone ? { Kind: 'thin markdown/notes' } : {}),
        }),
      ]
      if (thinStandalone) {
        sections.push(
          mdWarn(
            'Prefer schema v1 JSON (architecture/patterns/conventions) via `prjct analysis-save-llm <file> --md`. Markdown alone leaves patterns empty and burns a retry loop.'
          )
        )
      }
      console.log(mdOutput(...sections))
    } else {
      console.log(
        JSON.stringify({
          success: true,
          message: mergedNotes
            ? 'LLM analysis notes merged into existing rich analysis'
            : thinStandalone
              ? 'LLM analysis thin notes saved (prefer schema v1 JSON for house style)'
              : 'LLM analysis saved',
          input: resolved.source,
          mergedNotes,
          thin: thinStandalone,
          stats: {
            patterns: analysis.patterns.length,
            antiPatterns: analysis.antiPatterns?.length || 0,
            techDebt: analysis.techDebt?.length || 0,
          },
          ...(thinStandalone
            ? {
                tip: 'Prefer schema v1 JSON (architecture/patterns/conventions). Markdown alone is thin notes.',
              }
            : {}),
        })
      )
    }

    return { success: true }
  } catch (error) {
    return failFromError(error)
  }
}

/** Fold freeform insights into a rich analysis without wiping house style. */
function mergeThinNotesIntoRich(rich: LLMAnalysis, thin: LLMAnalysis): LLMAnalysis {
  const mergeUnique = (a: string[], b: string[], cap: number): string[] => {
    const out: string[] = []
    const seen = new Set<string>()
    for (const line of [...a, ...b]) {
      const k = line.toLowerCase()
      if (seen.has(k) || !line.trim()) continue
      seen.add(k)
      out.push(line)
      if (out.length >= cap) break
    }
    return out
  }
  return {
    ...rich,
    analyzedAt: thin.analyzedAt,
    commitHash: thin.commitHash ?? rich.commitHash,
    projectInsights: mergeUnique(rich.projectInsights ?? [], thin.projectInsights ?? [], 60),
    architecture: {
      ...rich.architecture,
      insights: mergeUnique(rich.architecture.insights ?? [], thin.architecture.insights ?? [], 24),
    },
  }
}

type ResolvedAnalysisInput = {
  content: string
  source: 'file' | 'inline'
}

async function resolveAnalysisInput(
  input: string,
  projectPath: string
): Promise<ResolvedAnalysisInput> {
  const trimmed = input.trim()
  if (!trimmed) {
    throw new Error('analysis-save-llm requires analysis text, JSON, or a file path')
  }

  const candidate = path.isAbsolute(trimmed) ? trimmed : path.resolve(projectPath, trimmed)
  try {
    const stat = await fs.stat(candidate)
    if (stat.isFile()) {
      return { content: await fs.readFile(candidate, 'utf-8'), source: 'file' }
    }
  } catch {
    // Not a readable file path; treat the argument as inline analysis text.
  }

  return { content: input, source: 'inline' }
}

async function normalizeAnalysis(input: string, projectPath: string): Promise<LLMAnalysis> {
  const text = input.trim()
  if (!text) throw new Error('analysis-save-llm received an empty analysis')

  const parsed = tryParseJson(text)
  if (parsed.ok) {
    const validation = parseLlmAnalysis(parsed.value)
    if (validation.ok) return validation.value
    return analysisFromText(
      `Structured analysis did not match the legacy schema; preserved as LLM notes.\n\n${JSON.stringify(
        parsed.value,
        null,
        2
      )}`,
      projectPath
    )
  }

  return analysisFromText(text, projectPath)
}

function tryParseJson(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) }
  } catch {
    return { ok: false }
  }
}

async function analysisFromText(text: string, projectPath: string): Promise<LLMAnalysis> {
  const insights = textToInsights(text)
  return {
    version: 1,
    commitHash: await resolveCurrentCommit(projectPath),
    analyzedAt: getTimestamp(),
    architecture: {
      style: 'unknown',
      insights: insights.slice(0, 8),
      domains: [],
    },
    patterns: [],
    antiPatterns: [],
    techDebt: [],
    riskAreas: [],
    refactorSuggestions: [],
    projectInsights: insights,
    conventions: [],
  }
}

function textToInsights(text: string): string[] {
  const lines = text
    .split(/\r?\n/)
    .map((line) =>
      line
        .replace(/^\s{0,3}#{1,6}\s+/, '')
        .replace(/^\s*[-*]\s+\[[ xX]\]\s+/, '')
        .replace(/^\s*[-*]\s+/, '')
        .replace(/^\s*\d+[.)]\s+/, '')
        .trim()
    )
    .filter(isUsefulInsight)

  const unique: string[] = []
  const seen = new Set<string>()
  for (const line of lines) {
    const key = line.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    unique.push(line)
    if (unique.length >= 40) break
  }

  return unique.length > 0 ? unique : [text.slice(0, 2000)]
}

function isUsefulInsight(line: string): boolean {
  if (!line) return false
  if (!/[\p{L}\p{N}]/u.test(line)) return false

  const normalized = line.toLowerCase().replace(/\s+/g, ' ').trim()
  if (
    [
      'current work',
      'wip',
      'misc',
      'todo',
      'n/a',
      'none',
      'latest',
      'unreleased',
      'changelog',
    ].includes(normalized)
  ) {
    return false
  }

  if (/^[-=_]{3,}$/.test(normalized)) return false
  if (/^(added|changed|fixed|removed)$/i.test(normalized)) return false
  if (/^v?\d+\.\d+\.\d+(?:-[\w.-]+)?$/i.test(normalized)) return false

  return true
}

async function resolveCurrentCommit(projectPath: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: projectPath })
    return stdout.trim() || null
  } catch {
    return null
  }
}

/**
 * Get the current LLM analysis for a project.
 */
export async function getLlmAnalysis(
  projectPath: string = process.cwd(),
  options: { json?: boolean; md?: boolean } = {}
): Promise<CommandResult> {
  try {
    const proj = await requireProject(projectPath)
    if (!proj.ok) return proj.result
    const projectId = proj.value

    const analysis = llmAnalysisStorage.getActive(projectId)

    if (!analysis) {
      if (options.md) {
        console.log(mdOutput('## No LLM Analysis', '> Run `prjct sync` to generate.'))
      } else {
        console.log(JSON.stringify({ success: false, message: 'No LLM analysis found' }))
      }
      return { success: false, message: 'No LLM analysis found' }
    }

    if (options.md) {
      const sections: string[] = [mdDone(`LLM Analysis (${analysis.architecture.style})`), '']

      if (analysis.architecture.insights.length > 0) {
        sections.push(
          mdSection('Architecture Insights', mdList(analysis.architecture.insights.slice(0, 5)))
        )
      }

      if (analysis.patterns.length > 0) {
        const shown = analysis.patterns.slice(0, 8)
        sections.push(
          mdSection(
            `Patterns (${analysis.patterns.length})`,
            mdList(shown.map((p) => `**${p.name}** — ${p.description} (${p.category})`))
          )
        )
      }

      if (analysis.antiPatterns.length > 0) {
        const shown = analysis.antiPatterns.slice(0, 5)
        sections.push(
          mdSection(
            `Anti-Patterns (${analysis.antiPatterns.length})`,
            mdList(shown.map((a) => `[${a.severity}] ${a.issue} — ${a.suggestion}`))
          )
        )
      }

      if (analysis.techDebt.length > 0) {
        const shown = analysis.techDebt.slice(0, 5)
        sections.push(
          mdSection(
            `Tech Debt (${analysis.techDebt.length})`,
            mdList(shown.map((d) => `[${d.priority}/${d.effort}] ${d.description}`))
          )
        )
      }

      if (analysis.conventions.length > 0) {
        sections.push(
          mdSection(
            'Conventions',
            mdList(analysis.conventions.slice(0, 5).map((c) => `**${c.category}**: ${c.rule}`))
          )
        )
      }

      console.log(mdOutput(...sections))
    } else {
      // Cap arrays for context efficiency
      const compact = {
        ...analysis,
        patterns: analysis.patterns.slice(0, 10),
        antiPatterns: analysis.antiPatterns.slice(0, 6),
        techDebt: analysis.techDebt.slice(0, 6),
        conventions: analysis.conventions.slice(0, 6),
      }
      console.log(JSON.stringify({ success: true, analysis: compact }))
    }

    return { success: true, data: analysis }
  } catch (error) {
    return failFromError(error)
  }
}
