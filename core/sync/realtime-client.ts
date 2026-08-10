/**
 * Realtime client — ONE project's live WebSocket connection to the storage
 * API, for <5s cross-device propagation.
 *
 * Uses the PLATFORM global `WebSocket` (RFC 6455 — stable in Node ≥22.5 and
 * Bun), NOT a backend SDK and NOT the `ws` package. The WHATWG WebSocket API
 * can't set request headers, so the token + device + project are passed as
 * query params over `wss://` (TLS-encrypted), matching the spec's auth model.
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

export type WebSocketFactory = (url: string) => WebSocketLike

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

/** REST base → ws endpoint with auth query params. `https`→`wss`, `http`→`ws`. */
export function buildRealtimeUrl(
  apiUrl: string,
  projectId: string,
  apiKey: string,
  deviceId: string
): string {
  const base = apiUrl.replace(/\/$/, '').replace(/^http/, 'ws')
  const q = new URLSearchParams({ key: apiKey, device: deviceId, project: projectId })
  return `${base}/ws?${q.toString()}`
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
        ((url: string) =>
          new (globalThis as { WebSocket: new (u: string) => WebSocketLike }).WebSocket(url)),
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
    const url = buildRealtimeUrl(
      this.opts.apiUrl,
      this.opts.projectId,
      this.opts.apiKey,
      this.opts.deviceId
    )
    const ws = (() => {
      try {
        return this.opts.wsFactory(url)
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
