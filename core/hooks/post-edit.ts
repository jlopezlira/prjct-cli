/**
 * PostToolUse hook (matcher: Edit|Write). Records files touched and, only
 * when newly-written code crosses a conservative comment-sprawl threshold,
 * surfaces the package-owned comment-discipline reference once per signal.
 * Normal edits stay silent and pay no model-context cost.
 */

import { spawnSync } from 'node:child_process'
import configManager from '../infrastructure/config-manager'
import { analyzeCommentDiscipline } from '../services/comment-discipline-detector'
import { memoryService } from '../services/memory-service'
import { resolvePrivateSkillPath } from '../services/private-skill-router'
import { gateDelivery } from '../services/session-context-cache'
import { type HookIo, runHook } from './_runner'

interface EditOrWriteToolInput {
  file_path?: string
  filePath?: string
  path?: string
  new_string?: string
  newString?: string
  content?: string
  text?: string
}

interface HookInput {
  tool_name?: string
  tool_input?: EditOrWriteToolInput
  session_id?: string
  conversation_id?: string
}

function editPath(input: HookInput): string | null {
  const toolInput = input.tool_input
  return (toolInput?.file_path ?? toolInput?.filePath ?? toolInput?.path)?.trim() || null
}

function changedText(input: HookInput): string | null {
  const toolInput = input.tool_input
  const text =
    toolInput?.new_string ?? toolInput?.newString ?? toolInput?.content ?? toolInput?.text
  return typeof text === 'string' && text.trim() ? text : null
}

/**
 * Write payloads contain the whole file. After a cheap positive prefilter,
 * narrow tracked files to added diff lines so old comments do not trigger.
 * New/untracked files legitimately treat the whole payload as newly written.
 */
function newlyWrittenTextForSignal(
  input: HookInput,
  projectPath: string,
  filePath: string,
  text: string
): string | null {
  if (input.tool_name !== 'Write') return text

  const diff = spawnSync('git', ['diff', '--unified=0', '--no-ext-diff', '--', filePath], {
    cwd: projectPath,
    encoding: 'utf8',
    timeout: 800,
    maxBuffer: 256 * 1024,
  })
  if (diff.status === 0 && diff.stdout) {
    return diff.stdout
      .split(/\r?\n/)
      .filter((line) => line.startsWith('+') && !line.startsWith('+++'))
      .map((line) => line.slice(1))
      .join('\n')
  }

  const tracked = spawnSync('git', ['ls-files', '--error-unmatch', '--', filePath], {
    cwd: projectPath,
    encoding: 'utf8',
    timeout: 800,
    maxBuffer: 64 * 1024,
  })
  return tracked.status === 0 ? null : text
}

async function buildCommentSignal(input: HookInput, projectPath: string): Promise<string | null> {
  const filePath = editPath(input)
  const text = changedText(input)
  if (!filePath || !text) return null

  // Avoid git entirely for the overwhelming majority of ordinary writes.
  const prefiltered = analyzeCommentDiscipline({ filePath, changedText: text })
  if (!prefiltered) return null
  const newlyWrittenText = newlyWrittenTextForSignal(input, projectPath, filePath, text)
  if (!newlyWrittenText) return null
  const signal = analyzeCommentDiscipline({ filePath, changedText: newlyWrittenText })
  if (!signal) return null

  const config = await configManager.readConfig(projectPath)
  if (!config?.projectId) return null
  const reference = (() => {
    try {
      return resolvePrivateSkillPath('comment-discipline.md')
    } catch {
      return null
    }
  })()
  const message = [
    '# prjct: comment signal',
    signal.observedBehavior,
    `Standard: ${signal.expectedBehavior}`,
    reference
      ? `Private reference (auto; read on demand): reference:comment-discipline=\`${reference}\``
      : null,
  ]
    .filter(Boolean)
    .join('\n')

  const sessionId = input.session_id?.trim() || input.conversation_id?.trim() || undefined
  const gate = await gateDelivery({
    projectId: config.projectId,
    projectPath,
    sessionId,
    surface: 'post-edit',
    key: signal.fingerprint,
    content: message,
    noSession: { mode: 'memory' },
  })
  return gate.suppressed ? null : message
}

export function runPostEditHook(projectPath: string = process.cwd(), io?: HookIo): Promise<void> {
  return runHook<HookInput>(
    {
      event: 'PostToolUse',
      projectPath,
      build: buildCommentSignal,
      afterEmit: async (input, p) => {
        const file = editPath(input)
        if (!file) return
        const config = await configManager.readConfig(p)
        if (!config?.projectId) return
        // Event-sourced — downstream consumers query the events table
        // (`memoryService.getRecentEvents`). Fire and forget; any
        // failure is non-critical.
        try {
          await memoryService.log(p, 'post_edit', {
            file,
            tool: input.tool_name ?? 'unknown',
          })
        } catch {
          /* swallow — hook must never surface errors */
        }
      },
    },
    io
  )
}
