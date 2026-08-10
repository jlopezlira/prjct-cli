/**
 * Best-effort cloud flush for triggers (ship, session-end Stop hook).
 *
 * Gates on the project's opt-in (`cloud.enabled` + not paused) and auth, then
 * runs a push+pull. NEVER throws — a sync hiccup must not break ship or
 * session teardown. Safe to fire-and-forget: the pending queue
 * (`sync_pending`) is durable, so anything not confirmed this run is retried
 * by the next trigger / `prjct cloud sync`.
 */

import type { LocalConfig } from '../types/config'
import syncManager from './sync-manager'

export interface FlushResult {
  ran: boolean
  pushed?: number
  pulled?: number
  error?: string
}

export async function flushIfLinked(
  projectPath: string,
  preloadedConfig?: LocalConfig | null
): Promise<FlushResult> {
  try {
    const config =
      preloadedConfig ??
      (await import('../infrastructure/config-manager').then(({ default: configManager }) =>
        configManager.readConfig(projectPath).catch(() => null)
      ))
    if (!config?.projectId || !config.cloud?.enabled || config.cloud.paused) {
      return { ran: false }
    }
    if (!(await syncManager.hasAuth())) return { ran: false }

    const res = await syncManager.sync(config.projectId, {
      include: config.cloud.include ?? {},
    })
    return {
      ran: true,
      pushed: res.pushed?.count ?? 0,
      pulled: res.pulled?.count ?? 0,
      error: res.success ? undefined : res.error,
    }
  } catch {
    return { ran: false }
  }
}
