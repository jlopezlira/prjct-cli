/**
 * `prjct agent` — owned print-mode agent (one-shot).
 *
 * Requires: prjct llm enable + brain profile (set/use/test).
 * Starts a work cycle by default (same startTask as CLI/MCP) so owned runs
 * compound project memory. Guest mode unchanged.
 */

import path from 'node:path'
import {
  type AgentStepEvent,
  type OwnedAgentWorkContext,
  prepareOwnedAgentWorkContext,
  runAgent,
} from '../agent'
import {
  getActiveLlmProfile,
  isOwnedLlmEnabled,
  ownedLlmEnableHint,
  resolveLlmProvider,
} from '../llm'
import type { CommandResult } from '../types/commands'
import { getErrorMessage } from '../types/fs'
import { failHard } from '../utils/md-aware'
import { mdOutput, mdSection, mdStats } from '../utils/md-formatter'
import out from '../utils/output'
import { PrjctCommandsBase } from './base'

interface AgentOptions {
  md?: boolean
  maxSteps?: number
  quiet?: boolean
  /** Skip startTask / work-cycle bind (still runs tools). */
  noWork?: boolean
}

export class AgentCommands extends PrjctCommandsBase {
  /**
   * Handler for `prjct agent` (method name is `run` because base class
   * already exposes a getter `agent` for host agent detection).
   */
  async run(
    intent: string | null = null,
    projectPath: string = process.cwd(),
    options: AgentOptions = {}
  ): Promise<CommandResult> {
    if (!isOwnedLlmEnabled()) {
      return failHard(
        `${ownedLlmEnableHint()}\n\nThen: prjct llm set … && prjct agent "<intent>"`,
        options
      )
    }

    const text = (intent ?? '').trim()
    if (!text) {
      return failHard(
        'Usage: prjct agent "<intent>" [--no-work] [--max-steps N]\n' +
          'Example: prjct agent "add a hello() function to src/hi.ts"',
        options
      )
    }

    const profile = getActiveLlmProfile()
    if (!profile) {
      return failHard(
        'No LLM brain configured. Run: prjct llm set --name <n> --key <K>  (or Ollama base-url)\nThen: prjct llm test',
        options
      )
    }

    const provider = await resolveLlmProvider()
    if (!provider) {
      return failHard('Could not resolve LLM provider for the active profile.', options)
    }

    const requestedRoot = path.resolve(projectPath)
    const maxSteps =
      typeof options.maxSteps === 'number' && options.maxSteps > 0
        ? Math.min(options.maxSteps, 40)
        : 12

    const preparation = await prepareOwnedAgentWorkContext({
      root: requestedRoot,
      intent: text,
      profile,
      noWork: options.noWork === true,
    }).then(
      (value) => ({ value }),
      (error: unknown) => ({ error })
    )
    if ('error' in preparation) {
      return failHard(`Work context failed: ${getErrorMessage(preparation.error)}`, options)
    }
    const workCtx: OwnedAgentWorkContext = preparation.value

    const root = workCtx.root

    if (!options.md && !options.quiet) {
      out.info(`Owned agent · ${profile.name} · ${profile.model} · maxSteps=${maxSteps} · ${root}`)
      if (workCtx.workStarted && workCtx.taskId) {
        out.info(`Work cycle: ${workCtx.taskId}`)
      } else if (workCtx.blocked) {
        out.info(`Work not started: ${workCtx.blocked}`)
      }
      if (workCtx.isolationPath) {
        out.info(`Isolated worktree: ${workCtx.isolationPath}`)
      }
    }

    const onStep = options.quiet
      ? undefined
      : (ev: AgentStepEvent) => {
          if (options.md) return
          if (ev.type === 'tool') {
            out.info(`  tool ${ev.name} ${ev.ok ? 'ok' : 'fail'}: ${ev.preview.slice(0, 80)}`)
          }
        }

    try {
      const result = await runAgent({
        intent: text,
        root,
        provider,
        maxSteps,
        onStep,
        systemAppend: workCtx.systemAppend || undefined,
        projectId: workCtx.projectId ?? undefined,
        taskId: workCtx.taskId,
      })

      if (!result.success) {
        return failHard(result.error ?? 'Agent failed', options)
      }

      const summary = (result.content ?? '').trim() || '(no summary)'

      if (options.md) {
        console.log(
          mdOutput(
            mdSection('Agent done', summary),
            mdStats({
              profile: result.profile,
              model: result.model,
              steps: result.steps,
              'tool calls': result.toolCalls,
              work: workCtx.taskId ?? (workCtx.workStarted ? 'started' : 'none'),
              root,
            })
          )
        )
        return {
          success: true,
          content: summary,
          steps: result.steps,
          toolCalls: result.toolCalls,
          taskId: workCtx.taskId,
        }
      }

      out.done(`Agent finished · ${result.steps} step(s) · ${result.toolCalls} tool call(s)`)
      if (workCtx.taskId)
        out.info(`Work cycle still open: ${workCtx.taskId} (prjct done when ready)`)
      console.log(summary)
      return {
        success: true,
        content: summary,
        steps: result.steps,
        toolCalls: result.toolCalls,
        taskId: workCtx.taskId,
      }
    } catch (e) {
      return failHard(getErrorMessage(e), options)
    }
  }
}
