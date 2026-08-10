import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import authConfig from '../../sync/auth-config'
import { _setAuthTokenStoreForTests, type AuthTokenLocation } from '../../sync/secure-auth-token'
import { syncManager } from '../../sync/sync-manager'

const fixture: {
  tmpDir: string
  storedToken: string | null
} = {
  tmpDir: '',
  storedToken: null,
}
const originalConfigPath = (authConfig as unknown as { configPath: string }).configPath
const originalFetch = globalThis.fetch

beforeEach(async () => {
  fixture.tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'prjct-sync-manager-test-'))
  ;(authConfig as unknown as { configPath: string }).configPath = path.join(
    fixture.tmpDir,
    'auth.json'
  )
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
})

afterEach(async () => {
  globalThis.fetch = originalFetch
  _setAuthTokenStoreForTests(null)
  ;(authConfig as unknown as { configPath: string }).configPath = originalConfigPath
  authConfig.clearCache()
  try {
    await fs.rm(fixture.tmpDir, { recursive: true, force: true })
  } catch {
    // ignore
  }
})

describe('SyncManager short-circuits without auth', () => {
  it('hasAuth reflects auth state', async () => {
    expect(await syncManager.hasAuth()).toBe(false)
    await authConfig.saveAuth('sk', 'u', 'e@x')
    expect(await syncManager.hasAuth()).toBe(true)
  })

  it('getStatus returns null when unauthenticated', async () => {
    expect(await syncManager.getStatus('proj-1')).toBeNull()
  })

  it('sync skips with reason=no_auth when unauthenticated', async () => {
    const result = await syncManager.sync('proj-1')
    expect(result.success).toBe(true)
    expect(result.skipped).toBe(true)
    expect(result.reason).toBe('no_auth')
  })

  it('push skips with reason=no_auth when unauthenticated', async () => {
    const result = await syncManager.push('proj-1')
    expect(result.success).toBe(true)
    expect(result.skipped).toBe(true)
    expect(result.reason).toBe('no_auth')
  })

  it('pull skips with reason=no_auth when unauthenticated', async () => {
    const result = await syncManager.pull('proj-1')
    expect(result.success).toBe(true)
    expect(result.skipped).toBe(true)
    expect(result.reason).toBe('no_auth')
  })
})
