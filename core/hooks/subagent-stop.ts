/**
 * SubagentStop hook — a subagent (Task tool) just finished. Fire a best-effort
 * desktop notification so the user, who may have tabbed away during the wait,
 * learns it's done and sees what's still active + pending.
 *
 * Side-effect only (returns null → `{}`). The ping runs in `afterEmit` —
 * `notifyDesktop` forks `osascript` (~50-200ms on macOS), which must never
 * sit between stdin and the host-visible response. Gated by config.notify
 * (default on). Best-effort + safeRun — never disturbs the session.
 */

import configManager from '../infrastructure/config-manager'
import { collectActiveTasks } from '../services/task-overview'
import { queueStorage } from '../storage/queue-storage'
import { effectiveNotifyMode, notifyDesktop } from '../utils/notify'
import { type HookIo, runHook } from './_runner'

export function runSubagentStopHook(
  projectPath: string = process.cwd(),
  io?: HookIo
): Promise<void> {
  return runHook(
    {
      event: 'SubagentStop',
      projectPath,
      afterEmit: async (_input, p) => {
        const config = await configManager.readConfig(p).catch(() => null)
        if (!config?.projectId || effectiveNotifyMode(config) === 'off') return
        const bits: string[] = []
        try {
          const overview = await collectActiveTasks(config.projectId, p)
          if (overview.current) bits.push(`active: ${overview.current.description}`)
        } catch {
          /* best-effort */
        }
        try {
          const pending = await queueStorage.getActiveTasks(config.projectId)
          if (pending.length > 0) bits.push(`pending: ${pending.length}`)
        } catch {
          /* best-effort */
        }
        await notifyDesktop('prjct — subagent finished', bits.join(' · ') || 'A subagent finished')
      },
    },
    io
  )
}
