/**
 * Secure storage for the BYOT embeddings API key.
 *
 * The key is a secret, so it never lands in `global.json` (plaintext). Order
 * of resolution, most-trusted first:
 *   1. `PRJCT_EMBEDDINGS_API_KEY` env var — CI / ephemeral override.
 *   2. macOS Keychain (`security` CLI) — the secure store on the user's Mac.
 *   3. `~/.prjct-cli/config/embeddings.key`, perms 0600 — non-mac fallback.
 *
 * Stored GLOBALLY (one key for every project), not per-project. The resolved
 * value is cached for the process so HttpEmbeddingProvider.embed() doesn't
 * re-shell to Keychain on every call.
 */

import fs from 'node:fs'
import path from 'node:path'
import { resolveCliHome } from '../../infrastructure/cli-home'
import { execFileAsync } from '../../utils/exec'
export const EMBEDDINGS_API_KEY_ENV = 'PRJCT_EMBEDDINGS_API_KEY'

const KEYCHAIN_SERVICE = 'prjct-embeddings'
const KEYCHAIN_ACCOUNT = 'prjct'
// Per call, not a module const — honors PRJCT_CLI_HOME so tests and
// alt-home installs never touch the user's real key file.
function keyFilePath(): string {
  return path.join(resolveCliHome(), 'config', 'embeddings.key')
}

// undefined = not yet resolved; null = resolved-and-absent.
const keyCache: { value: string | null | undefined } = { value: undefined }

function isDarwin(): boolean {
  return process.platform === 'darwin'
}

async function readKeychain(signal?: AbortSignal): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      'security',
      ['find-generic-password', '-a', KEYCHAIN_ACCOUNT, '-s', KEYCHAIN_SERVICE, '-w'],
      { signal, timeout: 10_000, killSignal: 'SIGKILL' }
    )
    const v = stdout.trim()
    return v || null
  } catch {
    signal?.throwIfAborted()
    return null
  }
}

function readFileKey(): string | null {
  try {
    const v = fs.readFileSync(keyFilePath(), 'utf-8').trim()
    return v || null
  } catch {
    return null
  }
}

/** Resolve the key (env → Keychain → file), cached for the process. */
export async function getEmbeddingsKey(
  options: { signal?: AbortSignal } = {}
): Promise<string | null> {
  options.signal?.throwIfAborted()
  if (keyCache.value !== undefined) return keyCache.value
  const env = process.env[EMBEDDINGS_API_KEY_ENV]?.trim()
  if (env) {
    keyCache.value = env
    return env
  }
  const resolved = (isDarwin() ? await readKeychain(options.signal) : null) ?? readFileKey()
  options.signal?.throwIfAborted()
  keyCache.value = resolved
  return resolved
}

/** Where the key lives, for status output (never prints the value). */
export type KeyLocation = 'env' | 'keychain' | 'file' | 'none'

export async function getKeyLocation(): Promise<KeyLocation> {
  if (process.env[EMBEDDINGS_API_KEY_ENV]?.trim()) return 'env'
  if (isDarwin() && (await readKeychain())) return 'keychain'
  if (readFileKey()) return 'file'
  return 'none'
}

/** Persist the key to the most secure store available. Returns where it went. */
export async function setEmbeddingsKey(value: string): Promise<'keychain' | 'file'> {
  const key = value.trim()
  keyCache.value = key
  if (isDarwin()) {
    try {
      // -U updates an existing item instead of erroring on duplicate.
      await execFileAsync('security', [
        'add-generic-password',
        '-U',
        '-a',
        KEYCHAIN_ACCOUNT,
        '-s',
        KEYCHAIN_SERVICE,
        '-w',
        key,
      ])
      return 'keychain'
    } catch {
      // Keychain unavailable (locked, headless) → fall through to file.
    }
  }
  fs.mkdirSync(path.dirname(keyFilePath()), { recursive: true })
  fs.writeFileSync(keyFilePath(), key, { mode: 0o600 })
  try {
    fs.chmodSync(keyFilePath(), 0o600)
  } catch {
    /* best-effort on platforms without POSIX perms */
  }
  return 'file'
}

/** Remove the key from every store. */
export async function clearEmbeddingsKey(): Promise<void> {
  keyCache.value = null
  if (isDarwin()) {
    try {
      await execFileAsync('security', [
        'delete-generic-password',
        '-a',
        KEYCHAIN_ACCOUNT,
        '-s',
        KEYCHAIN_SERVICE,
      ])
    } catch {
      /* not present */
    }
  }
  try {
    fs.rmSync(keyFilePath())
  } catch {
    /* not present */
  }
}

/** Test seam — reset the process cache. */
export function _resetKeyCache(): void {
  keyCache.value = undefined
}
