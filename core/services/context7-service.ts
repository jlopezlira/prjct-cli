import { constants as fsConstants } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { CONTEXT7_VERIFY_TTL_MS } from '../constants/timings'
import { resolveCliHome } from '../infrastructure/cli-home'
import { resolveUserHome, resolveUserPath } from '../infrastructure/user-home'
import { getErrorMessage, isNotFoundError } from '../types/fs'
import type { Context7Status } from '../types/services.js'
import {
  codexHasContext7Server,
  ensureCodexContext7Server,
  getCodexConfigTomlPath,
} from '../utils/codex-mcp'
import { execFileAsync } from '../utils/exec'
import { writeJson } from '../utils/file-helper'
import { MCP_SERVER_PRESETS } from '../utils/mcp-config'
export function getVerifyCachePath(): string {
  if (process.env.NODE_ENV === 'test') {
    return path.join(os.tmpdir(), 'prjct-context7-test', 'verify-cache.json')
  }
  return path.join(resolveCliHome(), 'state', 'context7-verify.json')
}

type PersistedVerify = { at: number; provider: string; status: Context7Status }

async function readPersistedVerify(): Promise<PersistedVerify | null> {
  try {
    const raw = await fs.readFile(getVerifyCachePath(), 'utf-8')
    const parsed = JSON.parse(raw) as PersistedVerify
    // `provider` defaults to 'claude' for caches written before provider-awareness.
    if (typeof parsed?.at === 'number' && parsed.status) {
      return { ...parsed, provider: parsed.provider ?? 'claude' }
    }
  } catch {
    // missing / corrupt — fall through to fresh verify
  }
  return null
}

async function writePersistedVerify(
  at: number,
  provider: string,
  status: Context7Status
): Promise<void> {
  const file = getVerifyCachePath()
  try {
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, JSON.stringify({ at, provider, status }), 'utf-8')
  } catch {
    // best-effort; cache miss is acceptable
  }
}

const CONTEXT7_DEFAULT = MCP_SERVER_PRESETS.context7
const verifyCache: { value: PersistedVerify | null } = { value: null }

const CONTEXT7_SMOKE_SYSTEM_PATH_DIRS = [
  path.dirname(process.execPath),
  '/opt/homebrew/bin',
  '/usr/local/bin',
  '/opt/local/bin',
  '/usr/bin',
  '/bin',
]

const CONTEXT7_SMOKE_HOME_RELATIVE_PATH_DIRS = [
  ['.bun', 'bin'],
  ['.local', 'bin'],
  ['.volta', 'bin'],
  ['.asdf', 'shims'],
  ['.local', 'share', 'mise', 'shims'],
  ['.rtx', 'shims'],
  ['.npm-global', 'bin'],
]

async function listChildDirs(parent: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(parent, { withFileTypes: true })
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name)
  } catch {
    return []
  }
}

async function discoverNodeManagerBinDirs(homeDir: string): Promise<string[]> {
  const dirs: string[] = []
  const nvmRoot = process.env.NVM_DIR || path.join(homeDir, '.nvm')
  const nvmVersions = path.join(nvmRoot, 'versions', 'node')
  for (const version of await listChildDirs(nvmVersions)) {
    dirs.push(path.join(nvmVersions, version, 'bin'))
  }

  const fnmRoot = process.env.FNM_DIR || path.join(homeDir, '.local', 'share', 'fnm')
  const fnmVersions = path.join(fnmRoot, 'node-versions')
  for (const version2 of await listChildDirs(fnmVersions)) {
    dirs.push(path.join(fnmVersions, version2, 'installation', 'bin'))
  }

  return dirs
}

export async function buildContext7SmokePath(
  basePath: string = process.env.PATH || '',
  homeDir: string = resolveUserHome()
): Promise<string> {
  const seen = new Set<string>()
  const dirs: string[] = []
  const homeDirs = CONTEXT7_SMOKE_HOME_RELATIVE_PATH_DIRS.map((segments) =>
    path.join(homeDir, ...segments)
  )
  const extraDirs = [
    ...CONTEXT7_SMOKE_SYSTEM_PATH_DIRS,
    ...homeDirs,
    ...(process.env.NVM_BIN ? [process.env.NVM_BIN] : []),
    ...(process.env.VOLTA_HOME ? [path.join(process.env.VOLTA_HOME, 'bin')] : []),
    ...(process.env.ASDF_DIR ? [path.join(process.env.ASDF_DIR, 'shims')] : []),
    ...(process.env.MISE_DATA_DIR ? [path.join(process.env.MISE_DATA_DIR, 'shims')] : []),
    ...(await discoverNodeManagerBinDirs(homeDir)),
  ]

  for (const raw of [...basePath.split(path.delimiter), ...extraDirs]) {
    const dir = raw.trim()
    if (!dir || seen.has(dir)) continue
    seen.add(dir)
    dirs.push(dir)
  }
  return dirs.join(path.delimiter)
}

async function resolveExecutable(command: string, searchPath: string): Promise<string> {
  if (path.isAbsolute(command) || command.includes(path.sep)) return command

  const extensions =
    process.platform === 'win32'
      ? (process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean)
      : ['']

  for (const dir of searchPath.split(path.delimiter)) {
    if (!dir) continue
    for (const ext of extensions) {
      const candidate = path.join(dir, command + ext)
      try {
        await fs.access(candidate, fsConstants.X_OK)
        return candidate
      } catch {
        // keep searching
      }
    }
  }

  return command
}

function getConfigPath(): string {
  if (process.env.PRJCT_CONTEXT7_CONFIG) return process.env.PRJCT_CONTEXT7_CONFIG
  if (process.env.NODE_ENV === 'test') {
    return path.join(os.tmpdir(), 'prjct-context7-test', 'mcp.json')
  }
  return resolveUserPath('.claude', 'mcp.json')
}

async function readConfig(filePath: string): Promise<Record<string, unknown>> {
  try {
    const content = await fs.readFile(filePath, 'utf-8')
    return JSON.parse(content) as Record<string, unknown>
  } catch (error) {
    if (isNotFoundError(error)) return {}
    throw error
  }
}

async function runSmokeCheck(): Promise<void> {
  if (process.env.PRJCT_SKIP_CONTEXT7_SMOKE === '1' || process.env.NODE_ENV === 'test') return

  const cfg = CONTEXT7_DEFAULT
  const args = [...(cfg.args || []), '--help']
  const smokePath = await buildContext7SmokePath()
  const command = await resolveExecutable(cfg.command || 'npx', smokePath)
  await execFileAsync(command, args, {
    timeout: 15000,
    env: { ...process.env, PATH: smokePath },
  })
}

class Context7Service {
  /**
   * Configure the Context7 MCP server for the given harness. Claude uses
   * `~/.claude/mcp.json`; Codex uses `[mcp_servers.context7]` in its TOML.
   * Providers without a managed path return a non-error "unsupported" status
   * so callers can skip rather than fail.
   */
  async install(provider: string = 'claude'): Promise<Context7Status> {
    if (provider === 'codex') return this.installCodex()
    if (provider !== 'claude') {
      return {
        installed: false,
        verified: false,
        configPath: '',
        message: `Context7 auto-config not supported for ${provider}; skipping`,
      }
    }

    const configPath = getConfigPath()
    const claudeDir = path.dirname(configPath)
    await fs.mkdir(claudeDir, { recursive: true })

    const config = await readConfig(configPath)
    const mcpServers = ((config.mcpServers as Record<string, unknown>) || {}) as Record<
      string,
      unknown
    >

    const desired = CONTEXT7_DEFAULT
    const current = mcpServers.context7
    // Skip the write — and the verify-cache invalidation — when the existing
    // entry already matches. Avoids invalidating the persisted verify cache
    // on every `prjct sync`, which costs ~1.1s for the next smoke check.
    if (current && JSON.stringify(current) === JSON.stringify(desired)) {
      return {
        installed: true,
        verified: false,
        configPath,
        message: 'Context7 MCP already configured',
      }
    }

    mcpServers.context7 = desired
    config.mcpServers = mcpServers
    await writeJson(configPath, config)
    verifyCache.value = null

    return {
      installed: true,
      verified: false,
      configPath,
      message: 'Context7 MCP configured',
    }
  }

  private async installCodex(): Promise<Context7Status> {
    const result = await ensureCodexContext7Server()
    if (result.changed) verifyCache.value = null
    return {
      installed: true,
      verified: false,
      configPath: result.path,
      message:
        result.skipped === 'user-managed'
          ? 'Context7 MCP user-managed in config.toml'
          : 'Context7 MCP configured in config.toml',
    }
  }

  /** Whether Context7 is registered for `provider`, and where. */
  private async resolveConfigured(
    provider: string
  ): Promise<{ ok: boolean; configPath: string; message?: string }> {
    if (provider === 'codex') {
      const configPath = getCodexConfigTomlPath()
      const has = await codexHasContext7Server(configPath)
      return has
        ? { ok: true, configPath }
        : { ok: false, configPath, message: 'Context7 MCP not configured in ~/.codex/config.toml' }
    }
    if (provider !== 'claude') {
      return { ok: false, configPath: '', message: `Context7 not managed for ${provider}` }
    }
    const configPath = getConfigPath()
    const config = await readConfig(configPath)
    const mcpServers = (config.mcpServers as Record<string, unknown>) || {}
    const context7 = mcpServers.context7 as { command?: string; args?: string[] } | undefined
    if (!context7?.command || !Array.isArray(context7.args) || context7.args.length === 0) {
      return { ok: false, configPath, message: 'Context7 MCP not configured in ~/.claude/mcp.json' }
    }
    return { ok: true, configPath }
  }

  async verify(provider: string = 'claude'): Promise<Context7Status> {
    const now = Date.now()
    if (
      verifyCache.value &&
      verifyCache.value.provider === provider &&
      now - verifyCache.value.at < CONTEXT7_VERIFY_TTL_MS
    ) {
      return verifyCache.value.status
    }

    // Persistent cache — skip the ~1.1s `npx ... --help` smoke check when a
    // recent successful verify exists for the same provider.
    const persisted = await readPersistedVerify()
    if (
      persisted?.status.verified &&
      persisted.provider === provider &&
      now - persisted.at < CONTEXT7_VERIFY_TTL_MS
    ) {
      verifyCache.value = persisted
      return persisted.status
    }

    const configured = await this.resolveConfigured(provider)
    if (!configured.ok) {
      return {
        installed: false,
        verified: false,
        configPath: configured.configPath,
        message: configured.message,
      }
    }

    try {
      await runSmokeCheck()
      const status = { installed: true, verified: true, configPath: configured.configPath }
      verifyCache.value = { at: now, provider, status }
      // Persist successful verify so subsequent CLI invocations skip the smoke check.
      await writePersistedVerify(now, provider, status)
      return status
    } catch (error) {
      const status = {
        installed: true,
        verified: false,
        configPath: configured.configPath,
        message: `Context7 smoke check failed: ${getErrorMessage(error)}`,
      }
      verifyCache.value = { at: now, provider, status }
      // Don't persist failures — next invocation should retry.
      return status
    }
  }

  async ensureReady(provider: string = 'claude'): Promise<Context7Status> {
    await this.install(provider)
    const status = await this.verify(provider)
    if (!status.verified) {
      const msg =
        status.message ||
        'Context7 MCP is required but not ready. Run `prjct start` to repair configuration.'
      throw new Error(msg)
    }
    return status
  }
}

const context7Service = new Context7Service()
export default context7Service
