/**
 * Sync Client - HTTP client for prjct API
 *
 * Handles communication with the backend API for push/pull operations.
 * Uses native fetch API (available in Node 18+ and Bun).
 *
 * PRJ-111: Includes configurable timeout support via AbortController.
 */

import type { ProjectMetaPayload } from '../services/sync/project-meta'
import type { SyncEvent } from '../types/events'
import type {
  BenchmarkPublishPayload,
  BenchmarkPublishResult,
  SyncBatchResult,
  SyncClientError,
  SyncLinkResult,
  SyncPullResult,
  SyncStatus,
} from '../types/sync'
import { getTimeout } from '../utils/constants'
import authConfig from './auth-config'
import { mapCliEventsToWebFormat } from './event-mapper'

// Sync Client

class SyncClient {
  private retryConfig = {
    maxRetries: 3,
    baseDelayMs: 1000,
    maxDelayMs: 30000,
  }

  /**
   * Push local events to the server
   */
  async pushEvents(projectId: string, events: SyncEvent[]): Promise<SyncBatchResult> {
    const { apiUrl, apiKey, deviceId } = await this.getAuthHeaders()

    if (!apiKey) {
      throw this.createError('AUTH_REQUIRED', 'No API key configured')
    }

    // Transform CLI events to web format before sending
    const webEvents = mapCliEventsToWebFormat(projectId, events)

    const response = await this.fetchWithRetry(`${apiUrl}/sync/batch`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...this.authHeaders(apiKey, deviceId),
      },
      body: JSON.stringify({
        projectId,
        events: webEvents,
      }),
    })

    if (!response.ok) {
      const error = await this.parseErrorResponse(response)
      throw error
    }

    return (await response.json()) as SyncBatchResult
  }

  /**
   * Pull events from the server.
   *
   * Phase 1.6 / B4: cli sends only `sinceEventId` (server-assigned
   * monotonic id). The legacy `since` (timestamp) is no longer sent —
   * prjct-cloud is pre-MVP and no pre-1.5 servers exist in production
   * that would need the timestamp fallback. Removing it eliminates a
   * parallel cursor that could disagree with the event_id under
   * rebase / partial pulls.
   *
   * The `sinceTimestamp` parameter is retained on the signature but
   * unused; internal callers stay source-compatible. Drop the
   * parameter in a future major bump.
   */
  async pullEvents(
    projectId: string,
    sinceEventId?: number,
    _sinceTimestamp?: string
  ): Promise<SyncPullResult> {
    const { apiUrl, apiKey, deviceId } = await this.getAuthHeaders()

    if (!apiKey) {
      throw this.createError('AUTH_REQUIRED', 'No API key configured')
    }

    const body: Record<string, unknown> = { projectId }
    if (typeof sinceEventId === 'number' && sinceEventId > 0) {
      body.sinceEventId = sinceEventId
    }

    const response = await this.fetchWithRetry(`${apiUrl}/sync/pull`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...this.authHeaders(apiKey, deviceId),
      },
      body: JSON.stringify(body),
    })

    if (!response.ok) {
      const error = await this.parseErrorResponse(response)
      throw error
    }

    return (await response.json()) as SyncPullResult
  }

  /**
   * Get sync status for a project
   */
  async getStatus(projectId: string): Promise<SyncStatus> {
    const { apiUrl, apiKey, deviceId } = await this.getAuthHeaders()

    if (!apiKey) {
      throw this.createError('AUTH_REQUIRED', 'No API key configured')
    }

    const response = await this.fetchWithRetry(`${apiUrl}/sync/status/${projectId}`, {
      method: 'GET',
      headers: {
        ...this.authHeaders(apiKey, deviceId),
      },
    })

    if (!response.ok) {
      const error = await this.parseErrorResponse(response)
      throw error
    }

    return (await response.json()) as SyncStatus
  }

  async linkProject(
    projectId: string,
    name?: string,
    meta?: ProjectMetaPayload
  ): Promise<SyncLinkResult> {
    const { apiUrl, apiKey, deviceId } = await this.getAuthHeaders()

    if (!apiKey) {
      throw this.createError('AUTH_REQUIRED', 'No API key configured')
    }

    const response = await this.fetchWithRetry(`${apiUrl}/sync/link`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...this.authHeaders(apiKey, deviceId),
      },
      body: JSON.stringify({
        projectId,
        ...(name ? { name } : {}),
        ...(meta ? { meta } : {}),
      }),
    })

    if (!response.ok) {
      const error = await this.parseErrorResponse(response)
      throw error
    }

    return (await response.json()) as SyncLinkResult
  }

  /**
   * Reflect a soft lifecycle action on the cloud (pause/resume/unlink). All are
   * non-destructive — they keep every record. Best-effort: returns false on any
   * failure so the local action still completes (the CLI never blocks on cloud).
   */
  async setCloudLifecycle(
    projectId: string,
    action: 'pause' | 'resume' | 'unlink'
  ): Promise<boolean> {
    try {
      const { apiUrl, apiKey, deviceId } = await this.getAuthHeaders()
      if (!apiKey) return false
      const response = await this.fetchWithRetry(`${apiUrl}/sync/projects/${projectId}/${action}`, {
        method: 'POST',
        headers: { ...this.authHeaders(apiKey, deviceId) },
      })
      return response.ok
    } catch {
      return false
    }
  }

  /**
   * Upload compact structural code graph (Function/Class/File + CALLS/IMPORTS)
   * for the cloud 3D visualizer. Best-effort — returns false if offline/unauthed.
   */
  async uploadCodeGraph(
    projectId: string,
    graph: {
      version: number
      builtAt?: string
      symbolCount?: number
      edgeCount?: number
      nodes: Array<{
        id: string
        name: string
        kind: string
        file?: string | null
        exported?: boolean
      }>
      links: Array<{ source: string; target: string; type: string }>
    }
  ): Promise<{ ok: boolean; nodes?: number; links?: number; reason?: string }> {
    try {
      const { apiUrl, apiKey, deviceId } = await this.getAuthHeaders()
      if (!apiKey) return { ok: false, reason: 'unauthenticated' }
      const response = await this.fetchWithRetry(
        `${apiUrl}/sync/projects/${projectId}/code-graph`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...this.authHeaders(apiKey, deviceId),
          },
          body: JSON.stringify(graph),
        }
      )
      if (!response.ok) {
        const detail = await (async () => {
          const fallback = `${response.status} ${response.statusText}`
          try {
            const errBody = (await response.json()) as { detail?: unknown }
            if (typeof errBody.detail === 'string') return errBody.detail
            return errBody.detail != null ? JSON.stringify(errBody.detail).slice(0, 300) : fallback
          } catch {
            return fallback
          }
        })()
        return { ok: false, reason: detail }
      }
      const body = (await response.json()) as { ok?: boolean; nodes?: number; links?: number }
      return { ok: body.ok !== false, nodes: body.nodes, links: body.links }
    } catch (e) {
      return { ok: false, reason: e instanceof Error ? e.message : String(e) }
    }
  }

  /**
   * Publish a product benchmark to the cloud API.
   *
   * This is intentionally a cloud operation, not a GitHub write. The server is
   * responsible for ownership/subscription checks and returns 402 when the
   * account cannot publish benchmarks.
   */
  async publishBenchmark(
    projectId: string,
    payload: BenchmarkPublishPayload
  ): Promise<BenchmarkPublishResult> {
    const { apiUrl, apiKey, deviceId } = await this.getAuthHeaders()

    if (!apiKey) {
      throw this.createError('AUTH_REQUIRED', 'No API key configured')
    }

    const response = await this.fetchWithRetry(`${apiUrl}/benchmarks/evals`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...this.authHeaders(apiKey, deviceId),
      },
      body: JSON.stringify({
        projectId,
        ...payload,
      }),
    })

    if (!response.ok) {
      const error = await this.parseErrorResponse(response)
      throw error
    }

    return (await response.json()) as BenchmarkPublishResult
  }

  /**
   * Test connection to the API
   */
  async testConnection(): Promise<boolean> {
    // PRJ-111: Add timeout to connection test
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), getTimeout('API_REQUEST'))

    try {
      const { apiUrl, apiKey, deviceId } = await this.getAuthHeaders()

      if (!apiKey) {
        clearTimeout(timeoutId)
        return false
      }

      const response = await fetch(`${apiUrl}/auth/verify`, {
        method: 'GET',
        headers: {
          ...this.authHeaders(apiKey, deviceId),
        },
        signal: controller.signal,
      })

      clearTimeout(timeoutId)
      if (response.status === 401 || response.status === 403) {
        await authConfig.clearAuth()
        return false
      }
      return response.ok
    } catch (_error) {
      // Network error, timeout, or other issue - expected
      clearTimeout(timeoutId)
      return false
    }
  }

  /**
   * Check if we have valid authentication
   */
  async hasAuth(): Promise<boolean> {
    return await authConfig.hasAuth()
  }

  // Private helpers

  private async getAuthHeaders(): Promise<{
    apiUrl: string
    apiKey: string | null
    deviceId: string
  }> {
    const [apiUrl, apiKey, deviceId] = await Promise.all([
      authConfig.getApiUrl(),
      authConfig.getApiKey(),
      authConfig.getDeviceId(),
    ])
    return { apiUrl, apiKey, deviceId }
  }

  /**
   * Token + device identity sent on every request. The server maps the
   * API key → user and scopes the cursor / echo-loop filter by device. The
   * CLI never sees anything about how the data is stored — just these headers.
   */
  private authHeaders(apiKey: string, deviceId: string): Record<string, string> {
    return { 'X-Api-Key': apiKey, 'X-Device-Id': deviceId }
  }

  private async fetchWithRetry(
    url: string,
    options: RequestInit,
    retryCount = 0
  ): Promise<Response> {
    // PRJ-111: Add AbortController-based timeout (default: 30s, configurable via PRJCT_TIMEOUT_API_REQUEST)
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), getTimeout('API_REQUEST'))

    // Only auto-retry IDEMPOTENT requests. A POST /sync/batch that 5xx'd or
    // failed post-send may have ALREADY been applied server-side — retrying
    // (up to maxRetries+1 times) duplicated the batch. GET/HEAD are safe to
    // replay; non-idempotent verbs surface the error to the caller, and the
    // next sync reconciles via the server's content-hash dedup.
    const method = (options.method ?? 'GET').toUpperCase()
    const idempotent = method === 'GET' || method === 'HEAD'

    try {
      const response = await fetch(url, {
        ...options,
        signal: controller.signal,
      })

      clearTimeout(timeoutId)

      // Retry on server errors (5xx) but not client errors (4xx) — idempotent only
      if (idempotent && response.status >= 500 && retryCount < this.retryConfig.maxRetries) {
        return this.scheduleRetry(url, options, retryCount)
      }

      return response
    } catch (error) {
      clearTimeout(timeoutId)

      if (error instanceof Error && error.name === 'AbortError') {
        throw this.createError(
          'NETWORK_ERROR',
          `Request timed out. Try increasing PRJCT_TIMEOUT_API_REQUEST (current: ${getTimeout('API_REQUEST')}ms)`
        )
      }

      // Retry on network errors — idempotent only (a POST may have landed
      // server-side before the connection dropped; replaying duplicates it).
      if (idempotent && retryCount < this.retryConfig.maxRetries) {
        return this.scheduleRetry(url, options, retryCount)
      }

      throw this.createError(
        'NETWORK_ERROR',
        error instanceof Error ? error.message : 'Network request failed'
      )
    }
  }

  /**
   * Wait out the exponential backoff window, then replay the request with
   * an incremented retry count. Shared by both the 5xx branch and the
   * network-error branch of `fetchWithRetry`.
   */
  private async scheduleRetry(
    url: string,
    options: RequestInit,
    retryCount: number
  ): Promise<Response> {
    const delay = Math.min(
      this.retryConfig.baseDelayMs * 2 ** retryCount,
      this.retryConfig.maxDelayMs
    )
    await this.sleep(delay)
    return this.fetchWithRetry(url, options, retryCount + 1)
  }

  private async parseErrorResponse(response: Response): Promise<SyncClientError> {
    try {
      const body = (await response.json()) as {
        detail?: string
        message?: string
        error?: string
      }
      const message = body.detail || body.message || body.error || `HTTP ${response.status}`

      if (response.status === 401 || response.status === 403) {
        await authConfig.clearAuth()
        return this.createError('AUTH_REQUIRED', message, response.status)
      }

      // Server-side paid gating: surface the upgrade message verbatim. The
      // CLI has no paywall logic of its own — it only relays what the API says.
      if (response.status === 402) {
        return this.createError('PAYMENT_REQUIRED', message, response.status)
      }

      return this.createError('API_ERROR', message, response.status)
    } catch (_error) {
      // JSON parse error - use generic message (expected for non-JSON responses)
      if (response.status === 401 || response.status === 403) {
        await authConfig.clearAuth()
        return this.createError('AUTH_REQUIRED', `HTTP ${response.status}`, response.status)
      }
      return this.createError('API_ERROR', `HTTP ${response.status}`, response.status)
    }
  }

  private createError(
    code: SyncClientError['code'],
    message: string,
    status?: number
  ): SyncClientError {
    return { code, message, status }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }
}

export const syncClient = new SyncClient()
export default syncClient
