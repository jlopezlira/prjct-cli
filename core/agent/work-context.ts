/**
 * Bind owned agent runs to a prjct work cycle (same startTask as CLI/MCP).
 * Best-effort: never blocks the agent if work start fails or project is unset.
 */

import configManager from '../infrastructure/config-manager'
import { type LlmProfile, profileImpliesWeakMode } from '../llm'
import { formatModelOnlyGuidance } from '../services/private-skill-router'
import { type StartTaskOutcome, startTask } from '../services/task-service'
import { stateStorage } from '../storage/state-storage'

export interface OwnedAgentWorkContext {
  /** Project root the agent should use (may be an isolated worktree). */
  root: string
  projectId: string | null
  workStarted: boolean
  taskId?: string
  systemAppend: string
  isolationPath?: string
  blocked?: string
}

function formatStartBrief(outcome: StartTaskOutcome): string {
  const lines: string[] = []
  lines.push(
    formatModelOnlyGuidance(outcome.privateSkills ?? {}, outcome.outputProfile ?? 'compact')
  )
  if (outcome.taskId) lines.push(`Work cycle: ${outcome.taskId} — ${outcome.description ?? ''}`)
  if (outcome.branch) lines.push(`Branch: ${outcome.branch}`)
  if (outcome.harness) {
    lines.push(`Harness: ${outcome.harness.level} ${outcome.harness.kind}/${outcome.harness.risk}`)
  }
  if (outcome.risks && outcome.risks.length > 0) {
    lines.push('Risks (read before edit):')
    for (const r of outcome.risks.slice(0, 8)) {
      lines.push(`- [${r.file}] ${r.label}: ${r.title}`)
    }
  }
  if (outcome.relatedContext && outcome.relatedContext.length > 0) {
    lines.push('Related project memory:')
    for (const c of outcome.relatedContext.slice(0, 6)) {
      lines.push(`- (${c.type}) ${c.title}: ${c.detail.slice(0, 160)}`)
    }
  }
  if (outcome.likelyFiles && outcome.likelyFiles.length > 0) {
    lines.push('Likely files:')
    for (const f of outcome.likelyFiles.slice(0, 10)) {
      lines.push(`- ${f.path}${f.reason ? ` (${f.reason})` : ''}`)
    }
  }
  if (outcome.instructions && outcome.instructions.length > 0) {
    lines.push('Instructions:')
    for (const i of outcome.instructions.slice(0, 8)) lines.push(`- ${i}`)
  }
  return lines.join('\n')
}

export function weakModelAppend(profile: LlmProfile): string {
  if (!profileImpliesWeakMode(profile)) return ''
  return [
    'Weak-model mode: be deliberate and tool-heavy.',
    '- Prefer prjct_search / prjct_guard before broad exploration.',
    '- Prefer edit over rewrite; verify with read after edits.',
    '- One clear goal per step; do not invent files or APIs.',
    '- When finished, short factual summary only.',
  ].join('\n')
}

/**
 * Start (or attach) a work cycle and build system append for the agent.
 * @param noWork — skip startTask entirely
 */
export async function prepareOwnedAgentWorkContext(opts: {
  root: string
  intent: string
  profile: LlmProfile
  noWork?: boolean
}): Promise<OwnedAgentWorkContext> {
  const parts: string[] = []
  const weak = weakModelAppend(opts.profile)
  if (weak) parts.push(weak)

  const projectId = await configManager.getProjectId(opts.root).catch(() => null)

  if (!projectId || opts.noWork) {
    return {
      root: opts.root,
      projectId,
      workStarted: false,
      systemAppend: parts.join('\n\n'),
    }
  }

  // If a cycle is already active, attach rather than stacking another start.
  try {
    const active = await stateStorage.getCurrentTask(projectId)
    if (active?.description) {
      parts.push(
        `Active work cycle already open: ${active.id ?? 'unknown'} — ${active.description}. Continue that intent; do not start a parallel cycle.`
      )
      return {
        root: opts.root,
        projectId,
        workStarted: false,
        taskId: active.id,
        systemAppend: parts.join('\n\n'),
      }
    }
  } catch {
    /* ignore */
  }

  const outcome = await startTask(projectId, opts.root, opts.intent, {
    // Agent path: still run gates/memory; isolation may move root.
    skipHooks: false,
  })

  if (!outcome.ok) {
    parts.push(
      `Work cycle was not started (${outcome.blocked ?? 'blocked'}). Proceed carefully without a tracked cycle.`
    )
    return {
      root: opts.root,
      projectId,
      workStarted: false,
      blocked: outcome.blocked,
      systemAppend: parts.join('\n\n'),
    }
  }

  const brief = formatStartBrief(outcome)
  if (brief) parts.push(brief)

  const isolationPath = outcome.isolation?.worktreePath
  const root = isolationPath ?? opts.root
  if (isolationPath) {
    parts.push(
      `Isolated worktree: ${isolationPath} (branch ${outcome.isolation?.branch}). All file tools use this root.`
    )
  }

  return {
    root,
    projectId,
    workStarted: true,
    taskId: outcome.taskId,
    isolationPath,
    systemAppend: parts.join('\n\n'),
  }
}
