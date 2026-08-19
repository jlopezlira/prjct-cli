/**
 * Context Commands - Exposes orchestrator context to Claude
 *
 * The `context` command runs the orchestrator and returns JSON with everything
 * Claude needs to execute workflows:
 * - projectId and globalPath for file operations
 * - detected domains from task description
 * - loaded agents with file paths and previews
 * - current task state (if any)
 * - repo analysis data
 *
 * This bridges the gap between TypeScript orchestration and Claude Code templates.
 *
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import configManager from '../infrastructure/config-manager'
import pathManager from '../infrastructure/path-manager'
import { contextTiersOneLiner } from '../services/context-tiers'
import { stateStorage } from '../storage/state-storage'
import type { MdOption } from '../types/cli'
import type { CommandResult, ContextOutput } from '../types/commands'
import { getErrorMessage, isNotFoundError } from '../types/fs'
import { mdBadge, mdJoin, mdOutput, mdSection, mdStats, mdTaskHeader } from '../utils/md-formatter'

// Context Commands Class

export class ContextCommands {
  /**
   * Get full project context for Claude
   *
   * Usage:
   *   prjct context task "add user auth"
   *   prjct context done
   *   prjct context ship
   *
   * Returns JSON with all orchestrator data.
   */
  async context(
    _input: string | null = null,
    projectPath: string = process.cwd(),
    options: MdOption = {}
  ): Promise<CommandResult> {
    try {
      const config = await configManager.readConfig(projectPath)
      if (!config || !config.projectId) {
        const empty: Partial<ContextOutput> = {
          projectId: '',
          globalPath: '',
          currentTask: null,
          domains: [],
          primaryDomain: null,
          subtasks: null,
          repoAnalysis: {
            ecosystem: 'unknown',
            frameworks: [],
            hasTests: false,
            technologies: [],
          },
        }
        console.log(JSON.stringify(empty))
        return { success: false, message: 'No prjct project. Run `prjct init` first.' }
      }

      const projectId = config.projectId
      const globalPath = pathManager.getGlobalProjectPath(projectId)

      const state = await stateStorage.read(projectId)
      const currentTask = state?.currentTask
        ? {
            id: state.currentTask.id,
            description: state.currentTask.description,
            startedAt: state.currentTask.startedAt,
            subtasks: state.currentTask.subtasks?.map((st) => ({
              id: st.id,
              description: st.description,
              status: st.status,
              domain: st.domain,
            })),
            currentSubtaskIndex: state.currentTask.currentSubtaskIndex,
          }
        : null

      const repoAnalysis = await this.loadRepoAnalysis(globalPath, projectId)

      // Orchestrator-derived domain/subtask classification was dropped —
      // it was harness that guessed intent from task text. Claude tags
      // explicitly via `prjct tag` when a domain is known. Output keeps
      // the same shape so existing consumers don't break; the fields
      // just start out empty.
      const output: ContextOutput = {
        projectId,
        globalPath,
        currentTask,
        domains: [],
        primaryDomain: null,
        subtasks: null,
        repoAnalysis: {
          ecosystem: repoAnalysis?.ecosystem || 'unknown',
          frameworks: repoAnalysis?.frameworks || [],
          hasTests: repoAnalysis?.hasTests || false,
          technologies: repoAnalysis?.technologies || [],
        },
      }

      if (options.md) console.log(this.formatContextMd(output))
      else console.log(JSON.stringify(output))

      return { success: true, message: '' }
    } catch (error) {
      return { success: false, message: `Context error: ${getErrorMessage(error)}` }
    }
  }

  /**
   * Search project memory — first-class verb over the SAME blended pipeline
   * `context memory` uses (FTS5 BM25 + opt-in semantic + recency recall +
   * usefulness rerank + graph expansion). Exists because an agent's instinct
   * is `prjct search "<q>"`; without a registered verb that fell through to
   * the GTD auto-route and silently captured the query to the inbox.
   *
   * Returns the rendered output in `CommandResult.message` (NOT console.log)
   * so it survives the daemon round-trip — the daemon returns the result and
   * the client prints `message`; a console.log would vanish into the daemon's
   * own stdout.
   */
  async search(
    query: string | null = null,
    projectPath: string = process.cwd(),
    options: MdOption & { global?: boolean; full?: boolean } = {}
  ): Promise<CommandResult> {
    // --global searches the cross-project knowledge base ('global-kb'):
    // personal gotchas/facts captured with `prjct remember --global`,
    // available from any directory.
    const projectId = options.global ? 'global-kb' : await configManager.getProjectId(projectPath)
    if (!projectId) {
      return { success: false, message: 'No prjct project. Run `prjct init` first.' }
    }

    const q = (query ?? '').trim()
    if (!q) return { success: false, message: 'search requires a query' }

    // `['memory', q]` → runMemoryTool joins non-flag args, so a query with
    // spaces arrives intact. A `mem_1234` query resolves that entry by id.
    const { runContextTool } = await import('../tools/context')
    const result = await runContextTool(['memory', q], projectId, projectPath)
    const ok = result.tool !== 'error'
    const rendered = options.md
      ? ((result.result as { markdown?: string }).markdown ?? '')
      : JSON.stringify(result, null, 2)
    // Re-running the SAME query with unchanged results collapses to a
    // pointer (session-scoped; sessionless never suppresses).
    const message =
      ok && options.md && rendered
        ? await (async (): Promise<string> => {
            const { resolveCallerIdentity } = await import('../services/agent-identity')
            const { gateDelivery } = await import('../services/session-context-cache')
            const caller = resolveCallerIdentity('search')
            const gate = await gateDelivery({
              projectId,
              projectPath,
              sessionId: caller.sessionId,
              surface: 'cli-search',
              key: q,
              content: rendered,
              full: Boolean(options.full),
              onRepeat: (hash) =>
                `_Same search result already delivered this session (hash ${hash.slice(0, 8)}) — \`prjct search "${q.slice(0, 60)}" --full\` to re-emit._`,
            })
            try {
              const { recordCliDeliveryChars } = await import('../services/work-cost-service')
              const { stateStorage } = await import('../storage/state-storage')
              const task = await stateStorage.getCurrentTask(projectId)
              recordCliDeliveryChars(projectId, task?.id, gate.emittedChars, caller.agent, 'search')
            } catch {
              /* telemetry only */
            }
            return gate.emit ?? rendered
          })()
        : rendered
    return { success: ok, message }
  }

  /**
   * Format context output as markdown for LLM consumption
   */
  private formatContextMd(output: ContextOutput): string {
    const sections: string[] = []

    // Project info
    sections.push(
      mdSection(
        'Project',
        mdJoin(mdBadge('ID', output.projectId), mdBadge('Path', output.globalPath))
      )
    )

    // Current task
    if (output.currentTask) {
      const task = output.currentTask
      sections.push(
        mdTaskHeader({
          description: task.description,
          status: 'in-progress',
        })
      )
      if (task.subtasks && task.subtasks.length > 0) {
        const items = task.subtasks.map(
          (st) =>
            `- [${st.status === 'completed' ? 'x' : ' '}] ${st.description}${st.domain ? ` (${st.domain})` : ''}`
        )
        sections.push(items.join('\n'))
      }
    } else {
      sections.push('> No active work cycle')
    }

    // Repo analysis
    if (output.repoAnalysis) {
      sections.push(
        mdSection(
          'Stack',
          mdStats({
            Ecosystem: output.repoAnalysis.ecosystem,
            Frameworks: output.repoAnalysis.frameworks.join(', ') || 'none',
            Tests: output.repoAnalysis.hasTests ? 'yes' : 'no',
            Tech: output.repoAnalysis.technologies.join(', ') || 'none',
          })
        )
      )
    }

    // Context cache tiers (one-liner + pointer) — full contract: `prjct context tiers --md`
    sections.push(
      mdSection(
        'Context tiers',
        `${contextTiersOneLiner()}\n\n_Detail: \`prjct context tiers --md\` · artifacts: \`prjct context artifacts --md\`_`
      )
    )

    return mdOutput(...sections)
  }

  /**
   * Load repo stack for context surface.
   * Priority: active project style snapshot → repo-analysis.json → live detector.
   */
  private async loadRepoAnalysis(
    globalPath: string,
    projectId?: string
  ): Promise<{
    ecosystem: string
    frameworks: string[]
    hasTests: boolean
    technologies: string[]
  } | null> {
    // 1. Project style snapshot (recomputed every sync)
    if (projectId) {
      try {
        const { getActiveProjectStyle } = await import('../services/project-style-evolution')
        const style = getActiveProjectStyle(projectId)
        if (style) {
          const s = style.payload.stack
          return {
            ecosystem: s.ecosystem || 'unknown',
            frameworks: s.frameworks ?? [],
            hasTests: s.hasTests ?? false,
            technologies: [
              ...(s.languages ?? []),
              ...(s.frameworks ?? []),
              ...(s.keyLibraries ?? []),
            ].filter((v, i, arr) => arr.indexOf(v) === i),
          }
        }
      } catch {
        /* fall through */
      }
    }

    // 2. Legacy artifact written by style recompute
    try {
      const analysisPath = path.join(globalPath, 'analysis', 'repo-analysis.json')
      const content = await fs.readFile(analysisPath, 'utf-8')
      const data = JSON.parse(content)
      return {
        ecosystem: data.ecosystem || 'unknown',
        frameworks: data.frameworks || [],
        hasTests: data.hasTests ?? false,
        technologies: data.technologies || [],
      }
    } catch (error) {
      if (!isNotFoundError(error)) {
        /* ignore parse errors */
      }
    }

    // 3. Live mechanical detect (honest stack even before first style capture)
    try {
      const { detectStack, gatherStats } = await import('../services/sync-analyzer')
      const projectPath = process.cwd()
      const [stack, stats] = await Promise.all([detectStack(projectPath), gatherStats(projectPath)])
      return {
        ecosystem: stats.ecosystem || 'unknown',
        frameworks: stack.frameworks ?? stats.frameworks ?? [],
        hasTests: stack.hasTesting ?? false,
        technologies: [...(stats.languages ?? []), ...(stack.frameworks ?? [])].filter(
          (v, i, arr) => arr.indexOf(v) === i
        ),
      }
    } catch {
      return null
    }
  }
}

// Exports

const contextCommands = new ContextCommands()
export default contextCommands
export { contextCommands }
