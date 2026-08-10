import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import authConfig from '../../sync/auth-config'
import { _setAuthTokenStoreForTests, type AuthTokenLocation } from '../../sync/secure-auth-token'
import syncClient from '../../sync/sync-client'
import type { SyncEvent } from '../../types/events'

type FetchCall = { url: string; init: RequestInit | undefined }

const fixture: {
  tmpDir: string
  tmpPath: string
  calls: FetchCall[]
  storedToken: string | null
} = {
  tmpDir: '',
  tmpPath: '',
  calls: [],
  storedToken: null,
}

const originalConfigPath = (authConfig as unknown as { configPath: string }).configPath
const originalFetch = globalThis.fetch

async function seedAuth(apiKey: string | null = 'sk_test_key') {
  fixture.tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'prjct-sync-client-test-'))
  fixture.tmpPath = path.join(fixture.tmpDir, 'auth.json')
  ;(authConfig as unknown as { configPath: string }).configPath = fixture.tmpPath
  authConfig.clearCache()
  fixture.storedToken = null
  _setAuthTokenStoreForTests({
    get: async () => fixture.storedToken,
    set: async (value: string): Promise<AuthTokenLocation> => {
      fixture.storedToken = value
      return 'keychain'
    },
    clear: async () => {
      fixture.storedToken = null
    },
    location: async () => (fixture.storedToken ? 'keychain' : 'none'),
  })
  if (apiKey) {
    await authConfig.saveAuth(apiKey, 'user-1', 'u@x')
  }
}

function stubFetch(impl: (url: string, init?: RequestInit) => Response | Promise<Response>): void {
  fixture.calls = []
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const urlStr = typeof url === 'string' ? url : url.toString()
    fixture.calls.push({ url: urlStr, init })
    return impl(urlStr, init)
  }) as typeof fetch
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

afterEach(async () => {
  globalThis.fetch = originalFetch
  _setAuthTokenStoreForTests(null)
  ;(authConfig as unknown as { configPath: string }).configPath = originalConfigPath
  authConfig.clearCache()
  if (fixture.tmpDir) {
    try {
      await fs.rm(fixture.tmpDir, { recursive: true, force: true })
    } catch {
      // ignore
    }
  }
})

describe('SyncClient.pushEvents', () => {
  beforeEach(async () => {
    await seedAuth()
  })

  it('throws AUTH_REQUIRED when no api key', async () => {
    await authConfig.clearAuth()
    await expect(syncClient.pushEvents('proj-1', [])).rejects.toMatchObject({
      code: 'AUTH_REQUIRED',
    })
  })

  it('posts transformed events to /sync/batch', async () => {
    const payload = { success: true, processed: 1, errors: [], syncedAt: '2026-04-10T00:00:00Z' }
    stubFetch(() => jsonResponse(200, payload))

    const events: SyncEvent[] = [
      {
        type: 'task.created',
        path: [],
        data: { id: 't1', title: 'hello' },
        timestamp: '2026-04-10T00:00:00Z',
        projectId: 'proj-1',
      },
    ]

    const result = await syncClient.pushEvents('proj-1', events)

    expect(result).toEqual(payload)
    expect(fixture.calls).toHaveLength(1)
    expect(fixture.calls[0].url).toContain('/sync/batch')
    expect(fixture.calls[0].init?.method).toBe('POST')
    const headers = fixture.calls[0].init?.headers as Record<string, string>
    expect(headers['X-Api-Key']).toBe('sk_test_key')

    const body = JSON.parse(fixture.calls[0].init?.body as string)
    expect(body.projectId).toBe('proj-1')
    expect(body.events).toHaveLength(1)
    expect(body.events[0].entity_type).toBe('tasks')
  })

  it('surfaces 401 as AUTH_REQUIRED error and clears local auth', async () => {
    stubFetch(() => jsonResponse(401, { error: 'bad key' }))
    await expect(syncClient.pushEvents('proj-1', [])).rejects.toMatchObject({
      code: 'AUTH_REQUIRED',
      status: 401,
    })
    expect(await authConfig.hasAuth()).toBe(false)
    expect(fixture.storedToken).toBeNull()
  })

  it('surfaces 400 as API_ERROR', async () => {
    stubFetch(() => jsonResponse(400, { message: 'malformed' }))
    await expect(syncClient.pushEvents('proj-1', [])).rejects.toMatchObject({
      code: 'API_ERROR',
      status: 400,
      message: 'malformed',
    })
  })

  it('does NOT retry a 5xx POST /sync/batch (no duplicate-batch storm)', async () => {
    // The batch may have applied server-side before the 500 — replaying it
    // (old behavior: up to maxRetries+1 = 4 POSTs) duplicates data. POST is
    // non-idempotent → exactly ONE attempt, error surfaced to the caller.
    stubFetch(() => jsonResponse(503, { message: 'upstream down' }))
    await expect(syncClient.pushEvents('proj-1', [])).rejects.toBeTruthy()
    expect(fixture.calls).toHaveLength(1)
    expect(fixture.calls[0].init?.method).toBe('POST')
  })
})

describe('SyncClient.pullEvents', () => {
  beforeEach(async () => {
    await seedAuth()
  })

  it('calls /sync/pull with sinceEventId in the body', async () => {
    stubFetch(() => jsonResponse(200, { events: [] }))

    await syncClient.pullEvents('proj-1', 42)

    expect(fixture.calls[0].url).toContain('/sync/pull')
    const body = JSON.parse(fixture.calls[0].init?.body as string)
    expect(body.projectId).toBe('proj-1')
    expect(body.sinceEventId).toBe(42)
  })

  it('Phase 1.6 / B4: NEVER sends `since` (legacy timestamp), even when caller passes one', async () => {
    stubFetch(() => jsonResponse(200, { events: [] }))

    // Caller still allowed to pass sinceTimestamp for source-compat —
    // it must be silently ignored, not forwarded on the wire.
    await syncClient.pullEvents('proj-1', 42, '2026-04-01T00:00:00Z')

    const body = JSON.parse(fixture.calls[0].init?.body as string)
    expect(body.since).toBeUndefined()
    expect('since' in body).toBe(false)
    // sinceEventId still rides through.
    expect(body.sinceEventId).toBe(42)
  })

  it('omits sinceEventId when zero or missing (initial pull)', async () => {
    stubFetch(() => jsonResponse(200, { events: [] }))

    await syncClient.pullEvents('proj-1')

    const body = JSON.parse(fixture.calls[0].init?.body as string)
    expect(body.projectId).toBe('proj-1')
    expect('sinceEventId' in body).toBe(false)
    expect('since' in body).toBe(false)
  })

  it('throws AUTH_REQUIRED when unauthenticated', async () => {
    await authConfig.clearAuth()
    await expect(syncClient.pullEvents('proj-1')).rejects.toMatchObject({
      code: 'AUTH_REQUIRED',
    })
  })
})

describe('SyncClient.publishBenchmark', () => {
  beforeEach(async () => {
    await seedAuth()
  })

  it('posts benchmark payload to /benchmarks/evals with auth headers', async () => {
    stubFetch(() =>
      jsonResponse(200, {
        success: true,
        benchmarkId: 'bench-1',
        url: 'https://app.prjct.app/benchmarks/bench-1',
        publishedAt: '2026-06-23T00:00:00Z',
      })
    )

    const result = await syncClient.publishBenchmark('proj-1', {
      schemaVersion: 1,
      artifactType: 'run',
      artifactId: 'eval_1',
      repo: 'acme/prjct-evals',
      createdAt: '2026-06-23T00:00:00Z',
      run: { runId: 'eval_1' },
      reportMarkdown: '# report\n',
    })

    expect(result.benchmarkId).toBe('bench-1')
    expect(fixture.calls).toHaveLength(1)
    expect(fixture.calls[0].url).toContain('/benchmarks/evals')
    expect(fixture.calls[0].init?.method).toBe('POST')
    const headers = fixture.calls[0].init?.headers as Record<string, string>
    expect(headers['X-Api-Key']).toBe('sk_test_key')
    expect(headers['X-Device-Id']).toBeString()

    const body = JSON.parse(fixture.calls[0].init?.body as string)
    expect(body.projectId).toBe('proj-1')
    expect(body.artifactType).toBe('run')
    expect(body.artifactId).toBe('eval_1')
  })

  it('surfaces server subscription gate as PAYMENT_REQUIRED', async () => {
    stubFetch(() => jsonResponse(402, { detail: 'Upgrade required to publish benchmarks.' }))

    await expect(
      syncClient.publishBenchmark('proj-1', {
        schemaVersion: 1,
        artifactType: 'comparison',
        artifactId: 'comparison_1',
        repo: 'acme/prjct-evals',
        createdAt: '2026-06-23T00:00:00Z',
        comparison: { comparisonId: 'comparison_1' },
        reportMarkdown: '# comparison\n',
      })
    ).rejects.toMatchObject({
      code: 'PAYMENT_REQUIRED',
      status: 402,
      message: 'Upgrade required to publish benchmarks.',
    })
  })
})

describe('SyncClient.testConnection', () => {
  it('returns false when no api key', async () => {
    await seedAuth(null)
    expect(await syncClient.testConnection()).toBe(false)
  })

  it('returns true on healthy 200', async () => {
    await seedAuth()
    stubFetch(() => new Response('ok', { status: 200 }))
    expect(await syncClient.testConnection()).toBe(true)
  })

  it('clears local auth on server auth rejection', async () => {
    await seedAuth()
    stubFetch(() => new Response('bad key', { status: 403 }))
    expect(await syncClient.testConnection()).toBe(false)
    expect(await authConfig.hasAuth()).toBe(false)
    expect(fixture.storedToken).toBeNull()
  })

  it('returns false on network error', async () => {
    await seedAuth()
    stubFetch(() => {
      throw new Error('network down')
    })
    expect(await syncClient.testConnection()).toBe(false)
  })
})

describe('SyncClient.hasAuth', () => {
  it('reflects authConfig state', async () => {
    await seedAuth()
    expect(await syncClient.hasAuth()).toBe(true)
    await authConfig.clearAuth()
    expect(await syncClient.hasAuth()).toBe(false)
  })
})
