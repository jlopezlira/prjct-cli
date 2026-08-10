/**
 * Notification hook — Claude is waiting for the user (input or permission).
 * Fire a best-effort desktop notification so a wait never hangs silently.
 *
 * Side-effect only: it emits no context (returns null → `{}`), it just pings.
 * Gated by config.notify (default on). Best-effort + safeRun — never disturbs
 * the session.
 */

import configManager from '../infrastructure/config-manager'
import { collectActiveTasks } from '../services/task-overview'
import { effectiveNotifyMode, notifyDesktop } from '../utils/notify'
import { type HookIo, runHook } from './_runner'

export function runNotificationHook(
  projectPath: string = process.cwd(),
  io?: HookIo
): Promise<void> {
  return runHook(
    {
      event: 'Notification',
      projectPath,
      build: async (_input, p) => {
        const config = await configManager.readConfig(p).catch(() => null)
        if (!config?.projectId || effectiveNotifyMode(config) === 'off') return null
        const detail = await collectActiveTasks(config.projectId, p)
          .then((overview) =>
            overview.current
              ? `Waiting — active: ${overview.current.description}`
              : 'Waiting for your input'
          )
          .catch(() => 'Waiting for your input')
        await notifyDesktop('prjct — Claude needs you', detail)
        return null
      },
    },
    io
  )
}
