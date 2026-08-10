/**
 * Global config — small typed key/value store at
 * `~/.prjct-cli/config/global.json`. Lets users opt into behaviors
 * (e.g. auto-update) without per-project state.
 *
 * Design: deliberately minimal. No schema versioning, no migrations.
 * Unknown keys are preserved on round-trip so newer/older versions of
 * prjct don't trample each other's settings.
 */

import fs from 'node:fs'
import path from 'node:path'
import { resolveCliHome } from '../infrastructure/cli-home'

/**
 * Resolve the config dir at call time. Honors `PRJCT_CLI_HOME` (the same
 * override `system-database.ts` uses) so tests and alt-home installs redirect
 * cleanly. Resolving lazily — not once at module load — matters because tests
 * can't rely on `os.homedir()`: Bun ignores a mutated `process.env.HOME`, so a
 * test that only patched HOME would silently read/write the user's REAL config.
 */
function configDir(): string {
  return path.join(resolveCliHome(), 'config')
}

function configFilePath(): string {
  return path.join(configDir(), 'global.json')
}

type GlobalConfigValue = string | number | boolean

interface GlobalConfig {
  /** Opt into silent self-update (1/hour throttled). Default: false. */
  'auto-update'?: 'on' | 'off'
  /** ISO timestamp of last update check. Internal — set by auto-updater. */
  'auto-update-last-check'?: string
  /** Suppress proactive workflow suggestions in the prompt hook. */
  suggestions?: 'on' | 'off'
  /** Global root for readable project vaults, configured by `prjct setup`. */
  'vault-root'?: string
  // Free-form bag for forward compat — readers preserve unknown keys.
  [key: string]: GlobalConfigValue | undefined
}

// Parsed-config cache validated by file identity (path + mtime + size).
// `resolveGlobalEmbeddings` calls getConfig 7× per invocation, on every
// Stop hook — each was a readFileSync + JSON.parse. A stat is ~10× cheaper
// and stays correct across processes (a CLI `prjct embeddings set` bumps
// the mtime, so a long-lived daemon picks the change up on its next read).
const globalConfigCache: { config: GlobalConfig | null; stamp: string } = {
  config: null,
  stamp: '',
}

function fileStamp(file: string): string {
  try {
    const st = fs.statSync(file)
    return `${file}|${st.mtimeMs}|${st.size}`
  } catch {
    return `${file}|absent`
  }
}

function readRaw(): GlobalConfig {
  const file = configFilePath()
  const stamp = fileStamp(file)
  if (globalConfigCache.config !== null && stamp === globalConfigCache.stamp) {
    return globalConfigCache.config
  }
  const cfg = (() => {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'))
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as GlobalConfig)
        : {}
    } catch {
      return {}
    }
  })()
  globalConfigCache.config = cfg
  globalConfigCache.stamp = stamp
  return cfg
}

function writeRaw(cfg: GlobalConfig): void {
  fs.mkdirSync(configDir(), { recursive: true })
  fs.writeFileSync(configFilePath(), `${JSON.stringify(cfg, null, 2)}\n`, 'utf-8')
  globalConfigCache.config = cfg
  globalConfigCache.stamp = fileStamp(configFilePath())
}

export function getConfig<K extends keyof GlobalConfig>(key: K): GlobalConfig[K] {
  return readRaw()[key]
}

export function getAll(): GlobalConfig {
  return readRaw()
}

export function setConfig<K extends keyof GlobalConfig>(key: K, value: GlobalConfig[K]): void {
  const cfg = readRaw()
  if (value === undefined) delete cfg[key]
  else cfg[key] = value
  writeRaw(cfg)
}

export function unsetConfig(key: keyof GlobalConfig): void {
  setConfig(key, undefined as GlobalConfig[typeof key])
}

export function configPath(): string {
  return configFilePath()
}
