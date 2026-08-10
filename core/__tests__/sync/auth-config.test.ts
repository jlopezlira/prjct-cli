import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import authConfig from '../../sync/auth-config'
import {
  _setAuthTokenStoreForTests,
  type AuthTokenLocation,
  setAuthToken,
} from '../../sync/secure-auth-token'

const fixture: {
  tmpDir: string
  tmpPath: string
  storedToken: string | null
} = {
  tmpDir: '',
  tmpPath: '',
  storedToken: null,
}

const originalConfigPath = (authConfig as unknown as { configPath: string }).configPath

async function setConfigPath(p: string) {
  ;(authConfig as unknown as { configPath: string }).configPath = p
  authConfig.clearCache()
}

function installTokenStore() {
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
}

describe('AuthConfig', () => {
  beforeEach(async () => {
    fixture.tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'prjct-auth-test-'))
    fixture.tmpPath = path.join(fixture.tmpDir, 'auth.json')
    installTokenStore()
    await setConfigPath(fixture.tmpPath)
  })

  afterEach(async () => {
    _setAuthTokenStoreForTests(null)
    await setConfigPath(originalConfigPath)
    try {
      await fs.rm(fixture.tmpDir, { recursive: true, force: true })
    } catch {
      // ignore
    }
  })

  describe('read', () => {
    it('returns defaults when file does not exist', async () => {
      const cfg = await authConfig.read()
      expect(cfg.apiKey).toBeNull()
      expect(cfg.apiUrl).toBe('https://api.prjct.app')
      expect(cfg.userId).toBeNull()
      expect(cfg.email).toBeNull()
      expect(cfg.lastAuth).toBeNull()
    })

    it('caches reads across calls', async () => {
      await authConfig.write({ apiKey: 'cached-key' })
      const a = await authConfig.read()
      // Manually corrupt the underlying file; cached read should not see it.
      await fs.writeFile(fixture.tmpPath, '{"apiKey":"disk-only"}')
      const b = await authConfig.read()
      expect(b.apiKey).toBe(a.apiKey)
      expect(b.apiKey).toBe('cached-key')
    })

    it('migrates legacy plaintext api keys out of auth.json', async () => {
      await fs.mkdir(path.dirname(fixture.tmpPath), { recursive: true })
      await fs.writeFile(
        fixture.tmpPath,
        JSON.stringify({
          apiKey: 'legacy-key',
          apiUrl: 'https://cli-api.prjct.app',
          userId: 'u',
          email: 'e@x',
          lastAuth: null,
        })
      )

      const cfg = await authConfig.read()
      const raw = JSON.parse(await fs.readFile(fixture.tmpPath, 'utf-8')) as {
        apiKey: string | null
        apiUrl: string
      }

      expect(cfg.apiKey).toBe('legacy-key')
      expect(fixture.storedToken).toBe('legacy-key')
      expect(raw.apiKey).toBeNull()
      // Legacy API host rewritten + persisted on read.
      expect(cfg.apiUrl).toBe('https://api.prjct.app')
      expect(raw.apiUrl).toBe('https://api.prjct.app')
    })

    it('refreshes auth when another process writes the secure token after an unauthenticated read', async () => {
      const before = await authConfig.read()
      expect(before.apiKey).toBeNull()

      fixture.storedToken = 'external-login-key'

      expect(await authConfig.hasAuth()).toBe(true)
      expect((await authConfig.read()).apiKey).toBe('external-login-key')
    })

    it('refreshes auth when another process clears the secure token after an authenticated read', async () => {
      await authConfig.saveAuth('sk_test_123', 'u', 'e@x')
      expect(await authConfig.hasAuth()).toBe(true)

      fixture.storedToken = null

      expect(await authConfig.hasAuth()).toBe(false)
      expect((await authConfig.read()).apiKey).toBeNull()
    })
  })

  describe('write + saveAuth', () => {
    it('saves api key, user id, and email', async () => {
      await authConfig.saveAuth('sk_test_123', 'user-1', 'user@example.com')
      const cfg = await authConfig.read()
      const raw = JSON.parse(await fs.readFile(fixture.tmpPath, 'utf-8')) as {
        apiKey: string | null
      }

      expect(cfg.apiKey).toBe('sk_test_123')
      expect(fixture.storedToken).toBe('sk_test_123')
      expect(raw.apiKey).toBeNull()
      expect(cfg.userId).toBe('user-1')
      expect(cfg.email).toBe('user@example.com')
      expect(cfg.lastAuth).not.toBeNull()
    })

    it('writes file with 0600 permissions', async () => {
      await authConfig.saveAuth('sk_test_123', 'u', 'e@x')
      const stat = await fs.stat(fixture.tmpPath)
      // Mask off the file type bits, keep permission bits.
      expect(stat.mode & 0o777).toBe(0o600)
    })

    it('merges partial updates with existing config', async () => {
      await authConfig.saveAuth('k1', 'u1', 'e1@x')
      await authConfig.write({ apiUrl: 'https://staging.prjct.app' })
      const cfg = await authConfig.read()
      const raw = JSON.parse(await fs.readFile(fixture.tmpPath, 'utf-8')) as {
        apiKey: string | null
      }

      expect(cfg.apiKey).toBe('k1')
      expect(raw.apiKey).toBeNull()
      expect(cfg.userId).toBe('u1')
      expect(cfg.apiUrl).toBe('https://staging.prjct.app')
    })
  })

  describe('hasAuth', () => {
    it('returns false when no api key', async () => {
      expect(await authConfig.hasAuth()).toBe(false)
    })

    it('returns true after saveAuth', async () => {
      await authConfig.saveAuth('sk_test_123', 'u', 'e@x')
      expect(await authConfig.hasAuth()).toBe(true)
    })

    it('returns false after clearAuth', async () => {
      await authConfig.saveAuth('sk_test_123', 'u', 'e@x')
      await authConfig.clearAuth()
      expect(await authConfig.hasAuth()).toBe(false)
    })
  })

  describe('getApiKey / getApiUrl', () => {
    it('returns null api key when unauthenticated', async () => {
      expect(await authConfig.getApiKey()).toBeNull()
    })

    it('returns the saved api key', async () => {
      await authConfig.saveAuth('sk_abc', 'u', 'e@x')
      expect(await authConfig.getApiKey()).toBe('sk_abc')
    })

    it('returns default api url when unset', async () => {
      expect(await authConfig.getApiUrl()).toBe('https://api.prjct.app')
    })

    it('rewrites legacy cli-api.prjct.app to api.prjct.app', async () => {
      await fs.mkdir(path.dirname(fixture.tmpPath), { recursive: true })
      await fs.writeFile(
        fixture.tmpPath,
        JSON.stringify({
          apiKey: null,
          apiUrl: 'https://cli-api.prjct.app',
          userId: 'u',
          email: 'e@x',
          lastAuth: null,
        })
      )

      expect(await authConfig.getApiUrl()).toBe('https://api.prjct.app')
    })
  })

  describe('getStatus', () => {
    it('reports unauthenticated when no key', async () => {
      const status = await authConfig.getStatus()
      expect(status.authenticated).toBe(false)
      expect(status.email).toBeNull()
      expect(status.apiKeyPrefix).toBeNull()
    })

    it('reports authenticated without exposing token material', async () => {
      await authConfig.saveAuth('sk_test_12345678901234', 'u', 'jane@example.com')
      const status = await authConfig.getStatus()
      expect(status.authenticated).toBe(true)
      expect(status.email).toBe('jane@example.com')
      expect(status.apiKeyPrefix).toBeNull()
    })
  })

  describe('clearAuth', () => {
    it('resets cached config and writes defaults to disk', async () => {
      await authConfig.saveAuth('sk_test_123', 'u', 'e@x')
      await authConfig.clearAuth()
      const cfg = await authConfig.read()
      expect(cfg.apiKey).toBeNull()
      expect(fixture.storedToken).toBeNull()
      expect(cfg.userId).toBeNull()
    })

    it('preserves the deviceId across logout (machine identity is not session state)', async () => {
      await authConfig.saveAuth('sk_test_123', 'u', 'e@x')
      const before = await authConfig.getDeviceId()
      await authConfig.clearAuth()
      const after = await authConfig.getDeviceId()
      expect(after).toBe(before)
    })
  })

  describe('keychain-only invariants', () => {
    it('setAuthToken refuses empty / whitespace tokens before touching the store', async () => {
      const setCalls: string[] = []
      _setAuthTokenStoreForTests({
        get: async () => fixture.storedToken,
        set: async (value) => {
          setCalls.push(value)
          fixture.storedToken = value
          return 'keychain'
        },
        clear: async () => {
          fixture.storedToken = null
        },
        location: async () => (fixture.storedToken ? 'keychain' : 'none'),
      })

      await expect(setAuthToken('')).rejects.toThrow(/empty/i)
      await expect(setAuthToken('   ')).rejects.toThrow(/empty/i)
      expect(setCalls).toHaveLength(0)
      expect(fixture.storedToken).toBeNull()
    })

    it('propagates store set failures — never falls back to writing the token into auth.json', async () => {
      _setAuthTokenStoreForTests({
        get: async () => null,
        set: async () => {
          throw new Error('No secure credential store is available for this platform.')
        },
        clear: async () => {},
        location: async () => 'none',
      })

      await expect(authConfig.saveAuth('sk_must_not_persist', 'u', 'e@x')).rejects.toThrow(
        /secure credential store/i
      )

      // No auth.json, or if partially created, must not contain the token.
      try {
        const raw = JSON.parse(await fs.readFile(fixture.tmpPath, 'utf-8')) as {
          apiKey: string | null
        }
        expect(raw.apiKey).toBeNull()
        expect(JSON.stringify(raw)).not.toContain('sk_must_not_persist')
      } catch (e) {
        // ENOENT is fine — never wrote the secret.
        expect((e as NodeJS.ErrnoException).code).toBe('ENOENT')
      }
    })

    it('every successful write leaves apiKey null on disk', async () => {
      await authConfig.saveAuth('sk_disk_never', 'u', 'e@x')
      await authConfig.write({ email: 'other@x' })
      const raw = JSON.parse(await fs.readFile(fixture.tmpPath, 'utf-8')) as {
        apiKey: string | null
      }
      expect(raw.apiKey).toBeNull()
      expect(JSON.stringify(raw)).not.toContain('sk_disk_never')
      expect(fixture.storedToken).toBe('sk_disk_never')
    })
  })
})
