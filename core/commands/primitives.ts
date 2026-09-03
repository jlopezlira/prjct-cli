/**
 * v2 Primitives: status, tag, remember
 *
 * Minimal, composable verbs that let Claude drive work without the CLI
 * imposing opinions.
 *
 * - status: inline status change on active task (escape hatch, Linear-style)
 * - tag: Claude attaches key:value tags to active task (e.g. type:bug)
 * - remember: Claude saves project memory entries (fact, decision, learning…)
 */

import { MEMORY_TYPES, type MemoryType } from '../memory/entries'
import { projectMemory } from '../memory/project-memory'
import type { TaskType } from '../schemas/state'
import { memoryService } from '../services/memory-service'
import { readLastStatus, resolveActiveTask, setTaskStatus } from '../services/task-service'
import { recordTaskTokenUsage } from '../services/work-cost-service'
import { stateStorage } from '../storage/state-storage'
import type { MdOption } from '../types/cli'
import type { CommandResult } from '../types/commands'
import { getErrorMessage } from '../types/fs'
import { failHard } from '../utils/md-aware'
import out from '../utils/output'
import { parseFlagTags } from '../utils/tags'
import { PrjctCommandsBase } from './base'
import { requireActiveTask, requireProject, requireTrustedMemoryContent } from './guards'

const TASK_TYPE_VALUES: readonly TaskType[] = ['feature', 'bug', 'improvement', 'chore']

export class PrimitiveCommands extends PrjctCommandsBase {
  /**
   * p. status <value>
   *
   * Escape hatch for changing the active task's status. Workflows are the
   * primary mechanism; this exists for quick overrides.
   */
  async status(
    value: string | null = null,
    projectPath: string = process.cwd(),
    options: MdOption & { tokensIn?: string; tokensOut?: string } = {}
  ): Promise<CommandResult> {
    try {
      const pid = await requireProject(projectPath)
      if (!pid.ok) return pid.result

      // Value provided → delegate the write (incl. the paused-task resume
      // bypass and the state-machine transition) to task-service, the shared
      // non-printing core. This command owns only the presentation.
      if (value) {
        const outcome = await setTaskStatus(pid.value, projectPath, value)
        if (!outcome.ok) {
          // `unsupported` and `gate-blocked` both carry the message to print.
          if (outcome.reason !== 'no-active-task') {
            if (options.md) console.log(`> ${outcome.message}`)
            else out.fail(outcome.message)
            return { success: false, error: outcome.message }
          }
          // No active work cycle and no paused cycle to resume — emit the uniform guard.
          const task = await requireActiveTask(pid.value, options, projectPath)
          if (!task.ok) return task.result
          return { success: false, error: 'No active work cycle' }
        }
        // Agent-agnostic token attribution: any CLI-driven agent (Codex,
        // Gemini, …) can report this cycle's usage with `--tokens-in/--tokens-out`
        // so prjct measures net savings without a Claude-style transcript.
        const tokensIn = Number.parseInt(options.tokensIn ?? '', 10)
        const tokensOut = Number.parseInt(options.tokensOut ?? '', 10)
        if (outcome.taskId && (Number.isFinite(tokensIn) || Number.isFinite(tokensOut))) {
          recordTaskTokenUsage(
            pid.value,
            outcome.taskId,
            Number.isFinite(tokensIn) ? tokensIn : 0,
            Number.isFinite(tokensOut) ? tokensOut : 0,
            // Distinct source so this manual/agent-agnostic report never shares
            // an event_key with the Claude Stop-hook's exact transcript
            // measurement (core/hooks/stop.ts) — both used to default to 'cli'
            // and silently clobber each other via the token_usage upsert.
            { source: 'cli-manual' }
          )
        }
        const msg = `status → ${value}`
        if (options.md) console.log(`✓ ${msg}`)
        else out.done(msg)
        const warnings = outcome.verificationWarnings ?? []
        if (warnings.length > 0) {
          if (options.md) {
            console.log('\n## Harness warnings')
            for (const warning of warnings) console.log(`- ${warning}`)
          } else {
            for (const warning2 of warnings) out.warn(`Harness: ${warning2}`)
          }
        }
        // On `done`, ask the agent to capture the task's context (second brain).
        if (outcome.contextPrompt) {
          if (options.md) console.log(`\n## Capture context\n${outcome.contextPrompt}`)
          else out.info(`\n${outcome.contextPrompt}`)
        }
        return { success: true, taskId: outcome.taskId, status: value }
      }

      // No-arg `status` → informative display. When the task is paused there's
      // no `currentTask`; show the paused task rather than a bogus "no active
      // task" — the task exists, it just isn't the focus.
      const current = await resolveActiveTask(pid.value, projectPath)
      if (!current) {
        const paused = await stateStorage.getPausedTasks(pid.value)
        if (paused.length > 0) {
          const t = paused[0]
          const line = `Task: ${t.id}  |  Type: ${t.type ?? 'unset'}  |  Status: paused`
          if (options.md) console.log(line)
          else out.info(line)
          return { success: true, taskId: t.id, status: 'paused' }
        }
      }

      const task = await requireActiveTask(pid.value, options, projectPath)
      if (!task.ok) return task.result

      const active = task.value
      // Recover the last status transition (if any) for this task so the
      // no-args `prjct status` reflects reality, not the task `type` tag.
      const lastStatus = await readLastStatus(pid.value, active.id)
      const line = `Task: ${active.id}  |  Type: ${active.type ?? 'unset'}  |  Status: ${lastStatus ?? 'active'}`
      const harness = active.harness
        ? `Harness: ${active.harness.level} ${active.harness.kind}/${active.harness.risk}`
        : null
      if (options.md) {
        console.log(harness ? `${line}\n${harness}` : line)
      } else {
        out.info(line)
        if (harness) out.info(harness)
      }
      return { success: true, taskId: active.id, status: lastStatus ?? 'active', harness }
    } catch (error) {
      const msg = getErrorMessage(error)
      return failHard(msg)
    }
  }

  /**
   * p. tag <k:v> [<k:v>...]
   *
   * Attach tags to the active task. `type:<taskType>` is promoted to the
   * task column; everything else is stored as a memory event.
   */
  async tag(
    args: string | null = null,
    projectPath: string = process.cwd(),
    options: MdOption = {}
  ): Promise<CommandResult> {
    try {
      const pid = await requireProject(projectPath)
      if (!pid.ok) return pid.result

      const task = await requireActiveTask(pid.value, options, projectPath)
      if (!task.ok) return task.result

      if (!args) {
        out.info('Usage: prjct tag <key:value> [<key:value>...]')
        return { success: false, error: 'No tags provided' }
      }

      const tags = parseTagPairs(args)
      if (Object.keys(tags).length === 0) {
        out.fail('no valid k:v pairs (expected `key:value`)')
        return { success: false, error: 'Invalid tag format' }
      }

      const typeTag = tags.type
      if (typeTag && (TASK_TYPE_VALUES as readonly string[]).includes(typeTag)) {
        await stateStorage.updateCurrentTask(pid.value, { type: typeTag as TaskType })
      }

      await memoryService.log(projectPath, 'task.tagged', {
        taskId: task.value.id,
        tags,
      })

      const pretty = Object.entries(tags)
        .map(([k, v]) => `${k}=${v}`)
        .join(', ')
      if (options.md) console.log(`✓ tagged ${pretty}`)
      else out.done(`tagged ${pretty}`)
      return { success: true, taskId: task.value.id, tags }
    } catch (error) {
      const msg = getErrorMessage(error)
      return failHard(msg)
    }
  }

  /**
   * p. remember <type> "<content>" [--tags k:v,...] [--force]
   *
   * Claude captures a project memory entry. Refuses to store content that
   * looks like a secret unless `--force` is passed.
   */
  async remember(
    args: string | null = null,
    projectPath: string = process.cwd(),
    options: { md?: boolean; tags?: string; force?: boolean; global?: boolean } = {}
  ): Promise<CommandResult> {
    try {
      // Global knowledge base: personal, cross-project facts (e.g. "zsh does
      // not word-split unquoted vars") live in the 'global-kb' pseudo-project
      // — capturable from ANY directory, no project init required.
      if (!options.global) {
        const initResult = await this.ensureProjectInit(projectPath)
        if (!initResult.success) return initResult
      }

      if (!args) {
        out.info(
          `Usage: prjct remember <type> "<content>" [--tags k:v,...]\nTypes: ${MEMORY_TYPES.join(' | ')}`
        )
        return { success: false, error: 'Missing args' }
      }

      const parsed = parseRememberArgs(args)
      if (!parsed.ok) {
        return failHard(parsed.error)
      }
      const { type, content } = parsed

      const trustCheck = requireTrustedMemoryContent(content, { force: options.force })
      if (!trustCheck.ok) return trustCheck.result

      const tags = parseFlagTags(options.tags)

      if (options.global) {
        await projectMemory.remember(projectPath, {
          type,
          content,
          tags,
          projectId: 'global-kb',
          requireWrite: true,
          force: options.force,
        })
        const msg = `remembered ${type} (GLOBAL — cross-project): ${content.slice(0, 80)}${content.length > 80 ? '…' : ''}`
        if (options.md) console.log(`✓ ${msg}`)
        else out.done(msg)
        return { success: true, type, scope: 'global' }
      }

      const pid = await requireProject(projectPath)
      if (!pid.ok) return pid.result

      // `remember` works even without an active task — you might be
      // capturing a fact before kicking off work. Just record without
      // source in that case.
      const active = await resolveActiveTask(pid.value, projectPath)

      // A `context` entry is the per-task unit of the project's RAG: auto-anchor
      // it to git (commit / author / files) so later recall answers "who touched
      // this, what changed" without reading all of git blame. No-op off-repo.
      const finalTags = await (async () => {
        if (type !== 'context') return tags
        try {
          const { deriveGitContext } = await import('../services/git-context')
          const { livingContextTagsFromContent } = await import(
            '../services/living-context-contract'
          )
          const gc = await deriveGitContext(projectPath)
          const structuredTags = livingContextTagsFromContent(content)
          return {
            ...structuredTags,
            ...tags,
            ...(gc.commit ? { commit: gc.commit } : {}),
            ...(gc.author ? { author: gc.author } : {}),
            ...(gc.files?.length ? { files: gc.files.join(',') } : {}),
            ...(active?.id ? { taskId: active.id } : {}),
          }
        } catch {
          return tags
        }
      })()

      await projectMemory.remember(projectPath, {
        type,
        content,
        tags: finalTags,
        source: active?.id,
        requireWrite: true,
        force: options.force,
      })

      if (options.md) console.log(`✓ remembered ${type}: ${content}`)
      else out.done(`remembered ${type}`)

      return { success: true, type, content, tags }
    } catch (error) {
      const msg = getErrorMessage(error)
      return failHard(msg)
    }
  }

  /**
   * Forget a memory entry by id — the delete half of `remember`. Accepts
   * `mem_1234`, `mem-1234`, or a bare `1234`. Hard-deletes the source event
   * and drops the FTS mirror + any embedding so it can never resurface
   * (lexical OR semantic). See `projectMemory.forget` for the cross-surface
   * cleanup.
   *
   * Lives here (not as `remember forget <id>`, which only ever created a junk
   * `type:forget` entry) so an agent's instinct `prjct forget mem_1234`
   * actually deletes.
   */
  async forget(
    id: string | null = null,
    projectPath: string = process.cwd(),
    options: MdOption = {}
  ): Promise<CommandResult> {
    try {
      const target = (id ?? '').trim()
      if (!target) {
        out.info('Usage: prjct forget <id>   (e.g. prjct forget mem_1234)')
        return { success: false, error: 'Missing id' }
      }

      const pid = await requireProject(projectPath)
      if (!pid.ok) return pid.result

      const removal = tryForgetMemory(pid.value, target, options)
      if (!removal.ok) return removal.result

      if (options.md) console.log(`✓ forgot ${target}`)
      else out.done(`forgot ${target}`)

      return { success: true, id: target }
    } catch (error) {
      const msg = getErrorMessage(error)
      return failHard(msg)
    }
  }

  /**
   * Resolve/close a memory entry so it leaves rotation (inbox, signals, traps).
   * Soft-deletes like forget's memory surface, records a closed audit remember,
   * and is the hygiene verb memory plugins lack.
   */
  async close(
    id: string | null = null,
    projectPath: string = process.cwd(),
    options: MdOption & { reason?: string } = {}
  ): Promise<CommandResult> {
    try {
      const target = (id ?? '').trim()
      if (!target) {
        out.info('Usage: prjct close <id> [--reason "..."]')
        return { success: false, error: 'Missing id' }
      }

      const pid = await requireProject(projectPath)
      if (!pid.ok) return pid.result

      const removal = tryForgetMemory(pid.value, target, options)
      if (!removal.ok) return removal.result

      const reason = (options.reason ?? '').trim()
      try {
        await projectMemory.remember(projectPath, {
          type: 'context',
          content: reason
            ? `Closed ${target}: ${reason}`
            : `Closed ${target} (resolved — left rotation)`,
          tags: {
            status: 'closed',
            resolves: target.startsWith('mem_') ? target : `mem_${target}`,
            source: 'prjct-close',
          },
          provenance: 'declared',
          projectId: pid.value,
        })
      } catch {
        /* audit trail best-effort */
      }

      if (options.md) console.log(`✓ closed ${target}`)
      else out.done(`closed ${target}`)

      return { success: true, id: target }
    } catch (error) {
      const msg = getErrorMessage(error)
      return failHard(msg)
    }
  }
}

// Helpers (unexported)

function parseTagPairs(args: string): Record<string, string> {
  const pairs = args
    .split(/\s+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((pair): [string, string] | null => {
      const idx = pair.indexOf(':')
      if (idx <= 0) return null
      return [pair.slice(0, idx), pair.slice(idx + 1)]
    })
    .filter((p): p is [string, string] => p !== null)
  return Object.fromEntries(pairs)
}

/**
 * Attempt to forget a memory entry by id, printing + shaping the uniform
 * "no memory entry matched" failure on a miss. Shared by `forget` and
 * `close`, which otherwise only differ in what they do after success.
 */
function tryForgetMemory(
  projectId: string,
  target: string,
  options: MdOption
): { ok: true } | { ok: false; result: CommandResult } {
  const removed = projectMemory.forget(projectId, target)
  if (!removed) {
    if (options.md) console.log(`✗ no memory entry matched ${target}`)
    else out.fail(`no memory entry matched ${target}`)
    return { ok: false, result: { success: false, error: `No memory entry matched ${target}` } }
  }
  return { ok: true }
}

type ParsedRemember = { ok: true; type: MemoryType; content: string } | { ok: false; error: string }

function parseRememberArgs(args: string): ParsedRemember {
  const trimmed = args.trim()
  const firstSpace = trimmed.search(/\s/)
  if (firstSpace <= 0) return { ok: false, error: 'expected `<type> "<content>"`' }

  // Types are freeform — base types (fact, decision, learning, insight,
  // okr, person, ...) are the common vocabulary; custom ones like
  // `recipe` or `workout` persist without ceremony. Just disallow empty
  // and obvious garbage.
  const typeStr = trimmed.slice(0, firstSpace).toLowerCase().trim()
  if (!typeStr || !/^[a-z][a-z0-9-]*$/.test(typeStr)) {
    return {
      ok: false,
      error: `invalid type '${typeStr}'. Lowercase letters + dashes only. Base types: ${MEMORY_TYPES.join(', ')}`,
    }
  }
  const type = typeStr as MemoryType

  const rawContent = trimmed.slice(firstSpace + 1).trim()
  const content =
    (rawContent.startsWith('"') && rawContent.endsWith('"')) ||
    (rawContent.startsWith("'") && rawContent.endsWith("'"))
      ? rawContent.slice(1, -1)
      : rawContent
  if (!content) return { ok: false, error: 'content is required' }
  return { ok: true, type, content }
}
