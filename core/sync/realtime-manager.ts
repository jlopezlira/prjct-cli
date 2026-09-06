/**
 * Realtime manager — one `RealtimeClient` per linked+active project, owned by
 * the long-lived daemon.
 *
 * Lifecycle:
 *  - daemon boot → `startAll()` reopens connections from the linked registry
 *  - `prjct cloud link` / `resume` → `start(projectId, projectPath)`
 *  - `prjct cloud pause` / `unlink` → `stop(projectId)`
 *  - daemon shutdown → `stopAll()`
 *
 * Realtime only runs INSIDE the daemon (the sole long-lived process).
 * In ephemeral (`PRJCT_NO_DAEMON`)
 * mode every method is a no-op — the command still updates the registry/config,
 * and the daemon picks it up on next boot. Pull-based sync covers that gap.
 */

import authConfig from './auth-config'
import { listLinkedProjects } from './cloud-registry'
import { RealtimeClient, type RealtimeState } from './realtime-client'
import syncManager from './sync-manager'

class RealtimeManager {
  private clients = new Map<string, RealtimeClient>()

  /** Ephemeral commands leave connection ownership with the daemon. */
  available(): boolean {
    return process.env.PRJCT_IN_DAEMON === '1'
  }

  /** Reopen connections for every linked project (daemon boot). Best-effort. */
  async startAll(): Promise<void> {
    if (!this.available()) return
    const linked = await listLinkedProjects()
    for (const p of linked) {
      try {
        await this.start(p.projectId, p.projectPath)
      } catch {
        // One bad project must not stop the rest.
      }
    }
  }

  /** Open a connection for one project if it's enabled, not paused, and authed. */
  async start(projectId: string, projectPath: string): Promise<void> {
    if (!this.available()) return
    if (this.clients.has(projectId)) return

    const { default: configManager } = await import('../infrastructure/config-manager')
    const config = await configManager.readConfig(projectPath).catch(() => null)
    if (!config?.cloud?.enabled || config.cloud.paused) return

    const auth = await authConfig.read()
    if (!auth.apiKey) return
    const [apiUrl, deviceId] = await Promise.all([authConfig.getApiUrl(), authConfig.getDeviceId()])

    const client = new RealtimeClient({
      projectId,
      apiUrl,
      apiKey: auth.apiKey,
      deviceId,
      apply: (pid, ev) => syncManager.applyRealtimeEvent(pid, ev),
    })
    this.clients.set(projectId, client)
    client.start()
  }

  /** Close one project's connection (pause/unlink). */
  stop(projectId: string): void {
    const client = this.clients.get(projectId)
    if (!client) return
    client.stop()
    this.clients.delete(projectId)
  }

  /** Close every connection (daemon shutdown). */
  stopAll(): void {
    for (const client of this.clients.values()) client.stop()
    this.clients.clear()
  }

  /** Connection state for `prjct cloud status` (or 'disabled' when not running). */
  status(projectId: string): RealtimeState | 'disabled' {
    return this.clients.get(projectId)?.state ?? 'disabled'
  }
}

export const realtimeManager = new RealtimeManager()
export default realtimeManager
