/**
 * Auth Config - Manages API key storage for cloud sync
 *
 * Stores non-sensitive auth metadata in ~/.prjct-cli/config/auth.json.
 * The Cloud API token is stored only in the platform credential store.
 * Used by SyncClient to authenticate with prjct API
 */

import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import pathManager from '../infrastructure/path-manager'
import type { AuthConfig } from '../types/sync'
import * as fileHelper from '../utils/file-helper'
import { clearAuthToken, getAuthToken, setAuthToken } from './secure-auth-token'

/** Canonical cloud API base (login exchange, sync, evals, realtime). */
export const DEFAULT_API_URL = 'https://api.prjct.app'

/** Canonical web SPA (device login /auth/cli, billing). */
export const DEFAULT_WEB_URL = 'https://prjct.app'

/** Retired hosts — rewrite stored auth.json so existing logins keep working. */
const LEGACY_API_URLS = new Set(['https://cli-api.prjct.app'])

const DEFAULT_CONFIG: AuthConfig = {
  apiKey: null,
  apiUrl: DEFAULT_API_URL,
  userId: null,
  email: null,
  lastAuth: null,
}

/**
 * Generate a stable UUIDv4 the first time we read an auth.json that
 * lacks one (B6 / Phase 1.5). Older auth.json files keep working —
 * the next `write` persists the new field.
 */
function freshDeviceId(): string {
  return crypto.randomUUID()
}

function metadataOnly(config: AuthConfig): AuthConfig {
  return {
    ...config,
    apiKey: null,
  }
}

class AuthConfigManager {
  private configPath: string
  private cachedConfig: AuthConfig | null = null

  constructor() {
    this.configPath = pathManager.getAuthConfigPath()
  }

  /**
   * Get the auth config file path
   */
  getConfigPath(): string {
    return this.configPath
  }

  /**
   * Read auth config from disk.
   *
   * Phase 1.5 / B6: synthesizes `deviceId` as a UUIDv4 if the
   * persisted file lacks it, and lazily persists it back so future
   * reads return a stable value. Non-breaking — pre-1.5 auth.json
   * files keep working.
   */
  async read(): Promise<AuthConfig> {
    if (this.cachedConfig) {
      this.cachedConfig = {
        ...this.cachedConfig,
        apiKey: await getAuthToken(),
      }
      return this.cachedConfig
    }

    const config = await fileHelper.readJson<AuthConfig>(this.configPath)
    const secureToken = await getAuthToken()
    const legacyToken = !secureToken ? config?.apiKey : undefined
    if (legacyToken) await setAuthToken(legacyToken)
    const base = config ?? DEFAULT_CONFIG
    const merged: AuthConfig = {
      ...base,
      apiKey: secureToken ?? legacyToken ?? null,
      deviceId: base.deviceId || freshDeviceId(),
      hostname: base.hostname || os.hostname(),
      apiUrl: base.apiUrl && LEGACY_API_URLS.has(base.apiUrl) ? DEFAULT_API_URL : base.apiUrl,
    }
    const mutated = Boolean(
      legacyToken ||
        !base.deviceId ||
        !base.hostname ||
        (base.apiUrl && LEGACY_API_URLS.has(base.apiUrl))
    )
    this.cachedConfig = merged
    // Lazy persist of deviceId/hostname/url only if we have an existing
    // file (don't write a fresh auth.json on a CLI that's never been
    // logged in — that would just create empty config files).
    if (mutated && config) {
      try {
        await fileHelper.writeJson(this.configPath, metadataOnly(this.cachedConfig))
        await fs.chmod(this.configPath, 0o600)
      } catch {
        // Best-effort — sync will still get a usable deviceId from cache.
      }
    }
    return this.cachedConfig
  }

  /**
   * Stable UUIDv4 for THIS device. Generated lazily; persisted on the
   * first write. Used by storages (publishEvent → SyncEvent.deviceId)
   * and by sync_cursors as part of the (user_id, device_id, project_id)
   * primary key.
   */
  async getDeviceId(): Promise<string> {
    const config = await this.read()
    return config.deviceId ?? freshDeviceId()
  }

  /** Hostname captured at first auth (B6) — surfaced in account UI. */
  async getHostname(): Promise<string> {
    const config = await this.read()
    return config.hostname ?? os.hostname()
  }

  /**
   * Write auth config to disk
   */
  async write(config: Partial<AuthConfig>): Promise<void> {
    const current = await this.read()

    if (Object.hasOwn(config, 'apiKey')) {
      if (config.apiKey) {
        await setAuthToken(config.apiKey)
      } else {
        await clearAuthToken()
      }
    }

    const updated: AuthConfig = {
      ...current,
      ...config,
      apiKey: await getAuthToken(),
      lastAuth: new Date().toISOString(),
    }

    await fileHelper.ensureDir(path.dirname(this.configPath))
    await fileHelper.writeJson(this.configPath, metadataOnly(updated))
    // Restrict metadata permissions to owner-only (0600).
    await fs.chmod(this.configPath, 0o600)
    this.cachedConfig = updated
  }

  /**
   * Check if user is authenticated (has valid API key)
   */
  async hasAuth(): Promise<boolean> {
    const apiKey = await this.getApiKey()
    return apiKey !== null && apiKey.length > 0
  }

  /**
   * Get the API key if available
   */
  async getApiKey(): Promise<string | null> {
    const config = await this.read()
    return config.apiKey || (await getAuthToken())
  }

  /**
   * Get the API URL (allows override for dev/staging)
   */
  async getApiUrl(): Promise<string> {
    const config = await this.read()
    return config.apiUrl || DEFAULT_API_URL
  }

  /**
   * Save API key and user info after successful auth
   */
  async saveAuth(apiKey: string, userId: string, email: string): Promise<void> {
    await this.write({
      apiKey,
      userId,
      email,
    })
  }

  /**
   * Clear all auth data (logout)
   */
  async clearAuth(): Promise<void> {
    await clearAuthToken()
    // Preserve the machine's install identity (deviceId/hostname) across logout
    // — it is NOT session state. Wiping it made every logout/login look like a
    // brand-new machine to the cloud, inflating the "machines" count.
    const prev = this.cachedConfig ?? (await fileHelper.readJson<AuthConfig>(this.configPath))
    this.cachedConfig = {
      ...DEFAULT_CONFIG,
      deviceId: prev?.deviceId ?? freshDeviceId(),
      hostname: prev?.hostname ?? os.hostname(),
    }
    await fileHelper.ensureDir(path.dirname(this.configPath))
    await fileHelper.writeJson(this.configPath, metadataOnly(this.cachedConfig))
    await fs.chmod(this.configPath, 0o600)
  }

  /**
   * Get auth status for display
   */
  async getStatus(): Promise<{
    authenticated: boolean
    email: string | null
    apiKeyPrefix: string | null
    lastAuth: string | null
  }> {
    const config = await this.read()

    return {
      authenticated: config.apiKey !== null,
      email: config.email,
      apiKeyPrefix: null,
      lastAuth: config.lastAuth,
    }
  }

  /**
   * Clear cache (useful for testing)
   */
  clearCache(): void {
    this.cachedConfig = null
  }
}

const authConfig = new AuthConfigManager()
export default authConfig
