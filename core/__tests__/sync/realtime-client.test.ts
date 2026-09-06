/**
 * RealtimeClient — connection + apply + reconnect logic, driven through an
 * injected fake WebSocket (no real network). Covers the URL/backoff helpers,
 * event dispatch, malformed-frame tolerance, reconnect-on-drop, and that
 * stop() prevents further reconnects.
 */

import { describe, expect, it } from 'bun:test'
import {
  backoffDelay,
  buildRealtimeUrl,
  RealtimeClient,
  realtimeAuthHeaders,
  type WebSocketLike,
} from '../../sync/realtime-client'

class FakeWebSocket implements WebSocketLike {
  readyState = 0
  onopen: ((ev: unknown) => void) | null = null
  onmessage: ((ev: { data: unknown }) => void) | null = null
  onclose: ((ev: unknown) => void) | null = null
  onerror: ((ev: unknown) => void) | null = null
  closeCalls = 0

  close(): void {
    this.closeCalls += 1
    this.readyState = 3
  }

  // Test drivers
  open(): void {
    this.readyState = 1
    this.onopen?.(null)
  }
  message(data: unknown): void {
    this.onmessage?.({ data })
  }
  drop(): void {
    this.readyState = 3
    this.onclose?.(null)
  }
}

function makeClient(overrides: Partial<Parameters<typeof clientWith>[0]> = {}) {
  return clientWith(overrides)
}

function clientWith(opts: {
  apply?: (pid: string, ev: Record<string, unknown>) => Promise<boolean>
  baseDelayMs?: number
  maxDelayMs?: number
}) {
  const sockets: FakeWebSocket[] = []
  const dials: Array<{ url: string; headers?: Record<string, string> }> = []
  const applied: Array<{ pid: string; ev: Record<string, unknown> }> = []
  const client = new RealtimeClient({
    projectId: 'proj-1',
    apiUrl: 'https://api.example.test',
    apiKey: 'pk_live_abc',
    deviceId: 'dev-1',
    apply:
      opts.apply ??
      (async (pid, ev) => {
        applied.push({ pid, ev })
        return true
      }),
    wsFactory: (url, headers) => {
      dials.push({ url, headers })
      const ws = new FakeWebSocket()
      sockets.push(ws)
      return ws
    },
    baseDelayMs: opts.baseDelayMs ?? 1,
    maxDelayMs: opts.maxDelayMs ?? 2,
  })
  return { client, sockets, applied, dials }
}

const tick = (ms = 25) => new Promise((r) => setTimeout(r, ms))

describe('buildRealtimeUrl', () => {
  it('swaps https→wss, carries only non-secret routing, never the key (SEC-10)', () => {
    const url = buildRealtimeUrl('https://api.prjct.app', 'p1', 'd1')
    expect(url.startsWith('wss://api.prjct.app/ws?')).toBe(true)
    const q = new URL(url).searchParams
    expect(q.get('key')).toBeNull()
    expect(url).not.toContain('pk_live')
    expect(q.get('device')).toBe('d1')
    expect(q.get('project')).toBe('p1')
    expect(q.get('auth')).toBeNull()
  })

  it('swaps http→ws and tolerates a trailing slash', () => {
    expect(buildRealtimeUrl('http://localhost:3000/', 'p', 'd')).toContain(
      'ws://localhost:3000/ws?'
    )
  })
})

describe('realtimeAuthHeaders', () => {
  it('uses the x-api-key contract already accepted by the server', () => {
    expect(realtimeAuthHeaders('pk_live_x')).toEqual({ 'x-api-key': 'pk_live_x' })
    expect(realtimeAuthHeaders('')).toEqual({})
  })

  it('the client dials with the key in headers, not the URL', () => {
    const { client, dials } = makeClient({})
    client.start()
    expect(dials).toHaveLength(1)
    expect(dials[0].url).not.toContain('pk_live')
    expect(dials[0].headers).toEqual({ 'x-api-key': 'pk_live_abc' })
    client.stop()
  })

  it('authenticates a real WebSocket and applies a server event without a URL credential', async () => {
    const requests: Array<{ url: string; key: string | null }> = []
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch(request, server) {
        requests.push({ url: request.url, key: request.headers.get('x-api-key') })
        if (server.upgrade(request)) return
        return new Response('Upgrade required', { status: 426 })
      },
      websocket: {
        open(socket) {
          socket.send(JSON.stringify({ type: 'event', event: { id: 'actual-event' } }))
        },
        message() {},
      },
    })
    const applied: string[] = []
    const client = new RealtimeClient({
      projectId: 'p',
      deviceId: 'd',
      apiKey: 'test-key',
      apiUrl: `http://127.0.0.1:${server.port}`,
      apply: async (_id, event) => {
        applied.push(String(event.id))
        return true
      },
    })
    try {
      client.start()
      for (const _ of Array.from({ length: 40 })) {
        if (applied.length) break
        await tick(25)
      }
      expect(applied).toEqual(['actual-event'])
      expect(requests[0].key).toBe('test-key')
      expect(requests[0].url).not.toContain('test-key')
      expect(new URL(requests[0].url!, 'http://local').searchParams.has('key')).toBe(false)
    } finally {
      client.stop()
      server.stop(true)
    }
  })

  it('does not forward credentials through a handshake redirect', async () => {
    const received: string[] = []
    const target = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch(request) {
        received.push(request.url)
        return new Response('unexpected')
      },
    })
    const redirected: boolean[] = []
    const source = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch() {
        redirected.push(true)
        return new Response(null, {
          status: 302,
          headers: { location: `http://127.0.0.1:${target.port}/ws` },
        })
      },
    })
    const client = new RealtimeClient({
      projectId: 'p',
      deviceId: 'd',
      apiKey: 'test-key',
      apiUrl: `http://127.0.0.1:${source.port}`,
      apply: async () => true,
    })
    try {
      client.start()
      await tick(100)
      expect(redirected.length).toBeGreaterThan(0)
      expect(received).toEqual([])
      expect(client.state).not.toBe('open')
    } finally {
      client.stop()
      source.stop(true)
      target.stop(true)
    }
  })
})

describe('backoffDelay', () => {
  it('never exceeds the ceiling and grows with attempt', () => {
    for (const attempt of Array.from({ length: 6 }, (_, index) => index)) {
      const d = backoffDelay(attempt, 1000, 30_000)
      expect(d).toBeGreaterThanOrEqual(0)
      expect(d).toBeLessThanOrEqual(Math.min(30_000, 1000 * 2 ** attempt))
    }
  })
})

describe('RealtimeClient', () => {
  it('applies an inbound event frame to the apply callback', async () => {
    const { client, sockets, applied } = makeClient({})
    client.start()
    sockets[0].open()
    expect(client.state).toBe('open')

    sockets[0].message(
      JSON.stringify({ type: 'event', event: { entity_type: 'memories', data: { id: 'm1' } } })
    )
    await tick(5)

    expect(applied.length).toBe(1)
    expect(applied[0].pid).toBe('proj-1')
    expect(applied[0].ev.entity_type).toBe('memories')
    client.stop()
  })

  it('ignores non-event frames and malformed JSON', async () => {
    const { client, sockets, applied } = makeClient({})
    client.start()
    sockets[0].open()
    sockets[0].message(JSON.stringify({ type: 'ping' }))
    sockets[0].message('not json {{{')
    sockets[0].message(JSON.stringify({ type: 'event' })) // missing event payload
    await tick(5)
    expect(applied.length).toBe(0)
    client.stop()
  })

  it('reconnects after an unexpected drop', async () => {
    const { client, sockets } = makeClient({})
    client.start()
    sockets[0].open()
    sockets[0].drop()
    expect(client.state).toBe('reconnecting')

    await tick(40)
    expect(sockets.length).toBeGreaterThanOrEqual(2) // a fresh socket was created
    client.stop()
  })

  it('stop() prevents any further reconnect', async () => {
    const { client, sockets } = makeClient({})
    client.start()
    sockets[0].open()
    client.stop()
    sockets[0].drop() // a drop after stop must NOT spawn a new socket
    await tick(40)
    expect(sockets.length).toBe(1)
    expect(client.state).toBe('closed')
  })

  it('start() is idempotent while connecting/open', () => {
    const { client, sockets } = makeClient({})
    client.start()
    client.start()
    sockets[0].open()
    client.start()
    expect(sockets.length).toBe(1)
    client.stop()
  })
})
