/**
 * CwdChanged hook — fires when Claude Code's working directory changes.
 *
 * Use case: the human `cd`s into a different prjct project (or a
 * worktree with its own `.prjct/prjct.config.json`). Without a fresh
 * context dump, the session is still holding the previous project's
 * persona/memory. This hook re-injects whatever the new cwd declares.
 *
 * If the new cwd has no prjct project, we emit `{}` — no noise.
 */

import configManager from '../infrastructure/config-manager'
import { gateDelivery } from '../services/session-context-cache'
import { type HookIo, runHook } from './_runner'
import { buildSessionContext } from './session-start'

interface HookInput {
  cwd?: string
  session_id?: string
}

/** Sessionless dedupe window: persona-only content is static-ish; the TTL
 *  bounds the concurrent-agent exposure to identical advisory bytes. */
const NO_SESSION_TTL_MS = 10 * 60_000

export function runCwdChangedHook(fallbackCwd: string = process.cwd(), io?: HookIo): Promise<void> {
  return runHook<HookInput>(
    {
      event: 'CwdChanged',
      projectPath: fallbackCwd,
      build: async (input, fallback) => {
        const cwd = input.cwd || fallback
        const context = await buildSessionContext(cwd)
        if (!context) return null
        // Bouncing between two projects re-injected each persona block on
        // EVERY cd — gate per cwd so a session pays each project once.
        const config = await configManager.readConfig(cwd).catch(() => null)
        if (!config?.projectId) return context
        const gate = await gateDelivery({
          projectId: config.projectId,
          projectPath: cwd,
          sessionId: input.session_id,
          surface: 'cwd-changed',
          key: cwd,
          content: context,
          noSession: { mode: 'static', ttlMs: NO_SESSION_TTL_MS },
        })
        return gate.suppressed ? null : context
      },
    },
    io
  )
}
