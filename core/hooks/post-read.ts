/** PostToolUse(Read) — records concrete source inspection for the edit gate. */

import configManager from '../infrastructure/config-manager'
import { markSourceInspected } from '../services/source-first-gate'
import { type HookIo, runHook } from './_runner'
import { hookFilePaths } from './_tool-input'

interface HookInput {
  tool_input?: unknown
  toolInput?: unknown
  session_id?: string
  conversation_id?: string
}

export function runPostReadHook(projectPath: string = process.cwd(), io?: HookIo): Promise<void> {
  return runHook<HookInput>(
    {
      event: 'PostToolUse',
      projectPath,
      // This stamp is the prerequisite for the next PreToolUse(Edit). Keep it
      // in the synchronous build phase so an immediate edit cannot race a
      // detached after-effect and be denied despite a successful read.
      build: async (input, p) => {
        const filePath = hookFilePaths(input)[0]
        if (!filePath) return null
        const config = await configManager.readConfig(p)
        if (!config?.projectId) return null
        await markSourceInspected({
          projectId: config.projectId,
          projectPath: p,
          sessionId: input.session_id?.trim() || input.conversation_id?.trim() || undefined,
          filePath,
        })
        return null
      },
    },
    io
  )
}
