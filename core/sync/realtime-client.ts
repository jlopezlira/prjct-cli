/**
 * Realtime client — ONE project's live WebSocket connection to the storage
 * API, for <5s cross-device propagation.
 *
 * Uses the PLATFORM global `WebSocket` (RFC 6455 — stable in Node ≥22.5 and
 * Bun), NOT a backend SDK and NOT the `ws` package.
 *
 * Auth: the WHATWG WebSocket API cannot set arbitrary request headers, but it
 * CAN set one — `Sec-WebSocket-Protocol`, via the constructor's `protocols`
 * argument. The API key rides there (`prjct.auth.v1, <key>`), NOT in the URL
 * query, so it never lands in server access logs, proxy logs, or a Referer.
 * Only non-secret routing (device, project) stays in the query, plus an
 * `auth=subprotocol` marker so the server knows where to read the credential
 * (and can still accept legacy query-key clients during rollout). The key is
 * base64url/`pk_`-shaped, so it is a valid subprotocol token. Server contract:
 * `GET /ws` reads `Sec-WebSocket-Protocol: prjct.auth.v1, <key>`, authenticates
 * on `<key>`, and echoes back `prjct.auth.v1` as the accepted subprotocol.
 *
 * Responsibilities: connect, parse inbound `{type:'event', event}` frames and
 * hand them to `apply`, and reconnect with exponential backoff + jitter on
 * drop. The WebSocket is injectable (`wsFactory`) so the reconnect / apply /
 * echo logic is unit-testable without a real socket.
 */

/** Minimal subset of the WHATWG WebSocket we depend on (keeps it injectable). */
export interface WebSocketLike {
  readyState: number
  close(code?: number, reason?: string): void
  onopen: ((ev: unknown) => void) | null
  onmessage: ((ev: { data: unknown }) => void) | null
  onclose: ((ev: unknown) => void) | null
  onerror: ((ev: unknown) => void) | null
}

export type WebSocketFactory = (url: string, protocols?: string[]) => WebSocketLike

/** Subprotocol scheme marker; the key follows it as the second token. */
export const REALTIME_AUTH_SCHEME = 'prjct.auth.v1'

export type RealtimeState = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'closed'

export interface RealtimeClientOptions {
  projectId: string
  /** REST base, e.g. `https://api.prjct.app`. */
  apiUrl: string
  apiKey: string
  deviceId: string
  /** Applies a received event locally (echo-guarded). Returns applied?. */
  apply: (projectId: string, event: Record<string, unknown>) => Promise<boolean>
  /** Injected for tests; defaults to the platform global WebSocket. */
  wsFactory?: WebSocketFactory
  baseDelayMs?: number
  maxDelayMs?: number
}

/** Whether this runtime exposes a usable global WebSocket client. */
export function hasGlobalWebSocket(): boolean {
  return typeof (globalThis as { WebSocket?: unknown }).WebSocket === 'function'
}

/**
 * REST base → ws endpoint with NON-SECRET routing params only. `https`→`wss`,
 * `http`→`ws`. The credential never appears here — see `realtimeAuthProtocols`.
 */
export function buildRealtimeUrl(apiUrl: string, projectId: string, deviceId: string): string {
  const base = apiUrl.replace(/\/$/, '').replace(/^http/, 'ws')
  const q = new URLSearchParams({ device: deviceId, project: projectId, auth: 'subprotocol' })
  return `${base}/ws?${q.toString()}`
}

/**
 * The `Sec-WebSocket-Protocol` values that carry auth: the scheme marker then
 * the key. Returns no auth protocol when the key is empty (caller sends none).
 */
export function realtimeAuthProtocols(apiKey: string): string[] {
  return apiKey ? [REALTIME_AUTH_SCHEME, apiKey] : []
}

/** Exponential backoff with full jitter, capped. Pure — unit tested. */
export function backoffDelay(attempt: number, baseMs: number, maxMs: number): number {
  const ceiling = Math.min(maxMs, baseMs * 2 ** attempt)
  return Math.round(Math.random() * ceiling)
}

export class RealtimeClient {
  private readonly opts: Required<Omit<RealtimeClientOptions, 'wsFactory'>> & {
    wsFactory: WebSocketFactory
  }
  private ws: WebSocketLike | null = null
  private _state: RealtimeState = 'idle'
  private attempt = 0
  private stopped = false
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null

  constructor(options: RealtimeClientOptions) {
    this.opts = {
      ...options,
      wsFactory:
        options.wsFactory ??
        ((url: string, protocols?: string[]) =>
          new (
            globalThis as { WebSocket: new (u: string, p?: string[]) => WebSocketLike }
          ).WebSocket(url, protocols)),
      baseDelayMs: options.baseDelayMs ?? 1000,
      maxDelayMs: options.maxDelayMs ?? 30_000,
    }
  }

  get state(): RealtimeState {
    return this._state
  }

  /** Open the connection (idempotent — a no-op if already connecting/open). */
  start(): void {
    if (this.stopped) return
    if (this._state === 'connecting' || this._state === 'open') return
    this.connect()
  }

  /** Close for good — cancels any pending reconnect. */
  stop(): void {
    this.stopped = true
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.closeSocket()
    this._state = 'closed'
  }

  private connect(): void {
    this._state = this.attempt === 0 ? 'connecting' : 'reconnecting'
    const url = buildRealtimeUrl(this.opts.apiUrl, this.opts.projectId, this.opts.deviceId)
    const protocols = realtimeAuthProtocols(this.opts.apiKey)
    const ws = (() => {
      try {
        return this.opts.wsFactory(url, protocols)
      } catch {
        return null
      }
    })()
    if (!ws) {
      this.scheduleReconnect()
      return
    }
    this.ws = ws

    ws.onopen = () => {
      this._state = 'open'
      this.attempt = 0
    }
    ws.onmessage = (ev) => {
      void this.handleMessage(ev?.data)
    }
    ws.onerror = () => {
      // A close event follows; reconnect is handled there.
    }
    ws.onclose = () => {
      if (this.stopped) return
      this.scheduleReconnect()
    }
  }

  private async handleMessage(data: unknown): Promise<void> {
    const parsed = (() => {
      try {
        return typeof data === 'string' ? (JSON.parse(data) as unknown) : data
      } catch {
        return null
      }
    })()
    if (!parsed || typeof parsed !== 'object') return
    const msg = parsed as { type?: string; event?: Record<string, unknown> }
    if (msg.type === 'event' && msg.event && typeof msg.event === 'object') {
      try {
        await this.opts.apply(this.opts.projectId, msg.event)
      } catch {
        // apply is already best-effort internally; never let it kill the socket.
      }
    }
    // Other frame types (ping/welcome/etc.) are ignored.
  }

  private scheduleReconnect(): void {
    if (this.stopped) return
    this.closeSocket()
    this._state = 'reconnecting'
    const delay = backoffDelay(this.attempt, this.opts.baseDelayMs, this.opts.maxDelayMs)
    this.attempt += 1
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      if (!this.stopped) this.connect()
    }, delay)
    // Don't keep the event loop alive just for a reconnect timer.
    ;(this.reconnectTimer as { unref?: () => void })?.unref?.()
  }

  private closeSocket(): void {
    if (!this.ws) return
    const ws = this.ws
    ws.onopen = null
    ws.onmessage = null
    ws.onclose = null
    ws.onerror = null
    try {
      ws.close()
    } catch {
      // already closed
    }
    this.ws = null
  }
}
