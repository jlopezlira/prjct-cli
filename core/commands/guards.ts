/**
 * Small pure-function guards for commands.
 *
 * The v2 primitives all need the same two checks: "is this a prjct project
 * at all?" and "is there an active task?". Before this module those lived
 * inline in every verb, each with its own slightly different error copy.
 * Now everyone shares the exact same branches.
 */

import configManager from '../infrastructure/config-manager'
import type { CurrentTask } from '../schemas/state'
import { projectService } from '../services/project-service'
import { resolveActiveTask } from '../services/task-service'
import { evaluateMemoryContent } from '../services/trust-boundary'
import { customWorkflowStorage } from '../storage/custom-workflow-storage'
import type { MdOption } from '../types/cli'
import type { CommandResult } from '../types/commands'
import { failWith } from '../utils/md-aware'
import out from '../utils/output'

type Guard<T> = { ok: true; value: T } | { ok: false; result: CommandResult }

/**
 * Resolve the projectId for the current repo or fail with a user-facing
 * error. Wraps the three-line boilerplate that every v2 primitive needed.
 *
 * In md mode emits the same message as a blockquote so agent callers
 * see a uniform `> No project ID found...` line.
 */
export async function requireProjectId(
  projectPath: string,
  options: MdOption = {}
): Promise<Guard<string>> {
  const projectId = await configManager.getProjectId(projectPath)
  if (!projectId) {
    if (options.md) {
      console.log('> No project ID found. Run `prjct init` first.')
    } else {
      out.failWithHint('NO_PROJECT_ID')
    }
    return { ok: false, result: { success: false, error: 'No project ID found' } }
  }
  return { ok: true, value: projectId }
}

/**
 * `ensureProjectInit + requireProjectId` in a single call. Almost every
 * command verb opens with this two-step dance; this helper saves the
 * repetition (~24 sites pre-2.15) and forwards init failures cleanly.
 */
export async function requireProject(
  projectPath: string,
  options: MdOption = {}
): Promise<Guard<string>> {
  const initResult = await projectService.ensureInit(projectPath)
  if (!initResult.success) return { ok: false, result: initResult }
  return requireProjectId(projectPath, options)
}

/**
 * Resolve the active task or fail with a uniform message. Accepts an
 * already-resolved projectId so we don't ping the config twice in verbs
 * that also need the id.
 */
export async function requireActiveTask(
  projectId: string,
  options: MdOption = {},
  projectPath: string = process.cwd()
): Promise<Guard<CurrentTask>> {
  // Workspace-aware: resolves the CURRENT worktree's task (main → currentTask,
  // child worktree → its activeTasks[] slot) so the shared guard works for
  // parallel agents, not just the main worktree.
  const active = await resolveActiveTask(projectId, projectPath)
  if (!active) {
    return {
      ok: false,
      result: failWith('No active work cycle — start one with `prjct work "<intent>"`', options),
    }
  }
  return { ok: true, value: active }
}

/**
 * Resolve a custom workflow by name or fail with a uniform "not found"
 * message that lists what's available. Saves the three call sites in
 * `workflow/rule-actions.ts` from each repeating the same DB lookup +
 * error formatting.
 */
export function requireWorkflow(
  projectId: string,
  command: string | undefined,
  options: MdOption = {}
): Guard<{ name: string }> {
  if (command) {
    const workflow = customWorkflowStorage.getWorkflow(projectId, command)
    if (workflow?.enabled) return { ok: true, value: { name: command } }
  }
  const workflows = customWorkflowStorage.getAllWorkflows(projectId)
  const available = workflows.map((w) => w.name).join(', ')
  return {
    ok: false,
    result: failWith(`Workflow '${command ?? ''}' not found. Available: ${available}`, options),
  }
}

/**
 * Trust-boundary gate for memory content (`capture` / `remember`). Runs
 * `evaluateMemoryContent` and, on deny, prints the uniform failure and maps
 * the verdict (secrets / prompt-injection / other) to a `CommandResult`
 * error — the same 13-line mapping both commands used to inline.
 */
export function requireTrustedMemoryContent(
  content: string,
  options: { force?: boolean } = {}
): { ok: true } | { ok: false; result: CommandResult } {
  const trust = evaluateMemoryContent(content, { force: options.force })
  if (!trust.allow) {
    out.fail(trust.denyMessage)
    return {
      ok: false,
      result: {
        success: false,
        error:
          trust.kind === 'secrets'
            ? 'Secret-like content detected'
            : trust.kind === 'prompt_injection'
              ? 'Prompt-injection-like content detected'
              : trust.reason,
      },
    }
  }
  return { ok: true }
}
