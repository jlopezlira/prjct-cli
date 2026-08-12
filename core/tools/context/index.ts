/**
 * `prjct context <subtool>` — CLI surface for the context tools.
 *
 * Alpha.12 cut the file-oriented subtools (`files`, `signatures`,
 * `imports`, `recent`, `summary`) from this dispatcher. Those were
 * thin wrappers around operations Claude has natively (Glob, Grep,
 * Read, git log, etc.) — classic harness. Internals stay in the
 * sibling files for use by the orchestrator and the MCP server,
 * but the CLI stops advertising them.
 *
 * Remaining subtools here are memory-bound — they need prjct's
 * SQLite state and can't be reproduced with native Claude tools.
 */

import configManager from '../../infrastructure/config-manager'
import { enrichedRecall } from '../../memory/enriched-recall'
import type { MemoryType } from '../../memory/entries'
import { formatMemoryMd } from '../../memory/format'
import { projectMemory } from '../../memory/project-memory'
import { usefulnessService } from '../../services/usefulness'
import type { ContextToolOutput } from '../../types/context-tools'
import { getErrorMessage } from '../../types/fs'

// CLI Dispatcher

/**
 * Run a context subtool from CLI arguments.
 *
 * Usage:
 *   prjct context memory [topic]
 *   prjct context learnings [topic]
 */
export async function runContextTool(
  args: string[],
  projectId: string,
  projectPath: string
): Promise<ContextToolOutput> {
  const [toolName, ...toolArgs] = args
  void projectId // currently only used for logs elsewhere; kept for API stability

  try {
    switch (toolName) {
      case 'memory':
        return await runMemoryTool(toolArgs, projectPath, { kind: 'memory', projectId })

      case 'learnings':
        return await runMemoryTool(toolArgs, projectPath, { kind: 'learnings', projectId })

      case 'skills': {
        // Index of paths, not summaries — refresh + render the skill catalog
        // so an orchestrator can pass exact SKILL.md paths to subagents.
        const { refreshSkillIndex, renderSkillIndex } = await import('../../services/skill-index')
        await refreshSkillIndex(projectId, projectPath)
        const md = renderSkillIndex(projectId)
        return {
          tool: 'skills',
          result: { markdown: md ?? 'No skills found in project or global skill roots.' },
        }
      }

      case 'tiers': {
        // Context cache tiers L0–L3 contract + live L0 budget measurement.
        const { buildContextTiersReport, formatContextTiersJson, formatContextTiersMd } =
          await import('../../services/context-tiers')
        const report = buildContextTiersReport()
        return {
          tool: 'tiers',
          result: {
            markdown: formatContextTiersMd(report),
            ...formatContextTiersJson(report),
          },
        }
      }

      case 'project': {
        // Live preview of PRJCT.md's "this project" section — verified-only
        // stack + commands, no write. Serves repos that never opt into a
        // written PRJCT.md (see prjct-md.ts's buildProjectFactsSection).
        const { formatProjectFactsMd } = await import('../../services/prjct-md')
        return {
          tool: 'project',
          result: { markdown: await formatProjectFactsMd(projectPath) },
        }
      }

      case 'artifacts': {
        // Safe artifact repo — judgment, ships, handoffs, checkpoints.
        const { listSafeArtifacts, formatSafeArtifactsJson, formatSafeArtifactsMd } = await import(
          '../../services/safe-artifacts'
        )
        const report = await listSafeArtifacts(projectId)
        return {
          tool: 'artifacts',
          result: {
            markdown: formatSafeArtifactsMd(report),
            ...formatSafeArtifactsJson(report),
          },
        }
      }

      case 'help':
        return {
          tool: 'error',
          result: { error: getHelpText(), code: 'HELP' },
        }

      default:
        return {
          tool: 'error',
          result: {
            error: `Unknown tool: ${toolName}. Use 'prjct context help' for usage.`,
            code: 'UNKNOWN_TOOL',
          },
        }
    }
  } catch (error) {
    return {
      tool: 'error',
      result: {
        error: getErrorMessage(error),
        code: 'EXECUTION_ERROR',
      },
    }
  }
}

// Tool Runners

async function runMemoryTool(
  args: string[],
  projectPath: string,
  opts: { kind: 'memory' | 'learnings'; projectId?: string }
): Promise<ContextToolOutput> {
  // Caller-resolved id wins (e.g. the 'global-kb' cross-project KB, which has
  // no path to resolve from); otherwise resolve from the path as before.
  const projectId = opts.projectId ?? (await configManager.getProjectId(projectPath))
  if (!projectId) {
    return {
      tool: 'error',
      result: { error: 'No prjct project. Run `prjct init` first.', code: 'NO_PROJECT' },
    }
  }

  const topic =
    args
      .filter((a) => !a.startsWith('-'))
      .join(' ')
      .trim() || undefined

  // Resolve-by-ID: `prjct context memory mem_3209` (or `--id mem_3209`)
  // returns that exact entry. Makes every `mem_NNNN` reference (topical
  // injection, `relates=`/`resolves=` cross-refs) resolvable instead of a
  // dangling opaque pointer "nobody — including an LLM — can read".
  const idArg = (() => {
    const flag = args.find((a) => a.startsWith('--id'))
    if (flag) {
      const v = flag.includes('=') ? flag.split('=')[1] : args[args.indexOf(flag) + 1]
      if (v) return v
    }
    return topic && /^mem[_-]?\d+$/i.test(topic) ? topic : undefined
  })()

  if (idArg) {
    const entry = projectMemory.getById(projectId, idArg)
    // Deliberate by-id pull = a usefulness signal; reinforce it.
    if (entry) usefulnessService.recordFetch(projectId, entry.id)
    // Resolving one entry by id is exactly when its relationships matter
    // most ("show me mem_3209" → also show what it resolves / supersedes).
    const linked = entry ? projectMemory.expandWithLinks(projectId, [entry], 5) : []
    const resolved = entry ? [entry, ...linked] : []
    return {
      tool: opts.kind,
      result: {
        markdown: entry
          ? formatMemoryMd(resolved)
          : `> No memory entry with id \`${idArg}\` (it may have aged out or never existed).`,
        entryCount: resolved.length,
        topic: idArg,
      },
    }
  }

  // `learnings` is a typed slice of memory focused on what the project
  // has *learned* the hard way. Everything else comes through `memory`.
  const LEARNINGS_TYPES: MemoryType[] = ['learning', 'anti-pattern', 'gotcha', 'red-herring']
  const types = opts.kind === 'learnings' ? LEARNINGS_TYPES : undefined

  // The full pipeline (FTS-first, recall backfill, semantic blend,
  // usefulness rerank, link expansion, surface attribution) lives in
  // enrichedRecall — shared with the MCP memory tools so every agent
  // surface retrieves identically.
  // Compact scan list, not full bodies: a topic search is "what's been said
  // about X?", answered by cues the agent can pull in full by id on demand
  // (`prjct context memory mem_N`). Full-body dump of 30 hits was the single
  // heaviest agent-facing surface (~7.7k tok) and undercut 3.8.0's own
  // "pull more" directive. Lower cap reinforces it — a scan, not an archive.
  const entries = await enrichedRecall(projectPath, projectId, { topic, types, limit: 12 })

  return {
    tool: opts.kind,
    result: {
      markdown: formatMemoryMd(entries, { compact: true }),
      entryCount: entries.length,
      topic,
    },
  }
}

// Help Text

function getHelpText(): string {
  return `
prjct context — memory-bound context subtools

USAGE:
  prjct context <subtool> [args]

SUBTOOLS:

  memory [topic]
    Recall project memory entries (facts, decisions, learnings, …).
    Optional topic filters by keyword over content + tag values.

  learnings [topic]
    Shortcut for the learnings slice (learning / anti-pattern / gotcha).

  tiers
    Context cache tiers L0–L3 contract + live L0 budget (skill/routing).
    Agents: never stuff L2/L3 into L0 — pull L2 on demand.

  project
    Live preview of verified per-project facts (stack + real test/lint/build
    commands) — no write. What PRJCT.md's "this project" section contains.

  artifacts
    Safe artifact repo: judgment ledger, ship receipts, handoffs, checkpoints.
    Audit what agents produced and under which gates (not a markdown vault).

NOTE: File-oriented subtools (files, signatures, imports, recent,
summary) were removed in alpha.12 — Claude has Glob/Grep/Read/git
natively and re-implementing them in prjct was harness. The
underlying functions still exist for the orchestrator + MCP surface.
`.trim()
}
