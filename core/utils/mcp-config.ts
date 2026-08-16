import fsSync from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { getErrorMessage } from '../types/fs'
import type { MCPServerConfig } from '../types/utils.js'
import { writeJson } from './file-helper'
import { MCP_REMOTE_VERSION } from './mcp-config/tokens'

interface MCPConfig {
  mcpServers?: Record<string, MCPServerConfig>
  [key: string]: unknown
}

const PRJCT_MCP_DESCRIPTION =
  'prjct: agentic harness with project memory, workflow gates, intent briefs, and performance context. Use prjct_task_start as the MCP entrypoint for a work cycle; prjct retrieves focused context, persists evidence stations, and keeps humans in the loop for risky gates. Agents resume from prjct_task_status/workflow output, create or link reviewed intent/spec briefs when required, and persist synthesized learning instead of raw transcript fragments.'

/**
 * Get the prjct MCP server config for agent hosts (Codex/Claude/…).
 *
 * Production-only policy: never pin hosts to git worktrees, monorepo bins, or
 * unbuilt trees. Prefer the published npm package (`prjct-cli`) with absolute
 * `node` + `bin/prjct.cjs` so sparse-PATH hosts (Codex) can still spawn.
 * Opt-in only: PRJCT_MCP_ALLOW_LOCAL=1 may use a local bin for prjct dogfood.
 */
function getPrjctMcpConfig(): MCPServerConfig {
  const published = resolvePublishedPrjctMcpConfig()
  if (published) return published

  if (process.env.PRJCT_MCP_ALLOW_LOCAL === '1') {
    const localBin = resolveLocalPrjctBin()
    if (localBin) {
      return {
        command: localBin,
        args: ['mcp-server'],
        description: PRJCT_MCP_DESCRIPTION,
      }
    }
  }

  return {
    command: 'npx',
    args: ['-y', 'prjct-cli@latest', 'mcp-server'],
    description: PRJCT_MCP_DESCRIPTION,
  }
}

/** True if path is a git worktree or obvious monorepo source bin (not npm global). */
function isNonProductionPrjctPath(resolved: string): boolean {
  const norm = resolved.replace(/\\/g, '/')
  if (norm.includes('/.worktrees/')) return true
  // Unbuilt / source-tree bin without a package install layout
  if (norm.includes('/prjct-cli/bin/prjct') && !norm.includes('/node_modules/prjct-cli/')) {
    return true
  }
  return false
}

/**
 * Resolve published prjct-cli install for host MCP wiring.
 * Uses require.resolve when available, else walks known npm global prefixes.
 */
function resolvePublishedPrjctMcpConfig(): MCPServerConfig | null {
  const pkgDirs: string[] = []
  try {
    pkgDirs.push(path.dirname(require.resolve('prjct-cli/package.json')))
  } catch {
    /* not resolvable from this process */
  }
  // Common npm global layouts (nvm + homebrew node)
  const home = os.homedir()
  for (const prefix of [
    process.env.NVM_BIN ? path.resolve(process.env.NVM_BIN, '..') : '',
    path.join(home, '.nvm', 'versions', 'node', process.version, 'lib'),
    '/opt/homebrew/lib',
    '/usr/local/lib',
  ].filter(Boolean)) {
    pkgDirs.push(path.join(prefix, 'node_modules', 'prjct-cli'))
  }

  for (const pkgDir of pkgDirs) {
    if (isNonProductionPrjctPath(pkgDir)) continue
    const cjs = path.join(pkgDir, 'bin', 'prjct.cjs')
    const distOk =
      fsSync.existsSync(path.join(pkgDir, 'dist', 'bin', 'prjct.mjs')) ||
      fsSync.existsSync(path.join(pkgDir, 'dist', 'bin', 'prjct-core.mjs'))
    if (!fsSync.existsSync(cjs) || !distOk) continue

    // Prefer absolute node next to the install so Codex sparse PATH works
    // (prjct.cjs shebang is #!/usr/bin/env node).
    const nodeCandidates = [
      process.execPath,
      path.join(path.dirname(process.execPath), 'node'),
      path.join(pkgDir, '..', '..', 'bin', 'node'), // nvm: .../node/vX/lib/node_modules → .../bin/node
    ]
    const adjacentNode = nodeCandidates.find(
      (candidate) => candidate && fsSync.existsSync(candidate)
    )
    // nvm layout: pkgDir = .../node/vX/lib/node_modules/prjct-cli → bin/node at .../node/vX/bin/node
    const nvmNode = path.resolve(pkgDir, '..', '..', '..', 'bin', 'node')
    const nodeBin = fsSync.existsSync(nvmNode) ? nvmNode : (adjacentNode ?? process.execPath)

    return {
      command: nodeBin,
      args: [cjs, 'mcp-server'],
      env: {
        PATH: `${path.dirname(nodeBin)}${path.delimiter}/usr/bin${path.delimiter}/bin`,
      },
      description: PRJCT_MCP_DESCRIPTION,
    }
  }
  return null
}

function resolveLocalPrjctBin(): string | null {
  const argvPath = process.argv[1]
  const candidates = [
    argvPath ? path.resolve(path.dirname(argvPath), 'prjct') : '',
    argvPath ? path.resolve(path.dirname(argvPath), '..', 'bin', 'prjct') : '',
    path.resolve(process.cwd(), 'bin', 'prjct'),
  ].filter(Boolean)

  for (const candidate of candidates) {
    if (!fsSync.existsSync(candidate)) continue
    const resolved = (() => {
      try {
        return fsSync.realpathSync(candidate)
      } catch {
        return candidate
      }
    })()
    if (isNonProductionPrjctPath(resolved)) continue
    return resolved
  }
  return null
}

export const MCP_SERVER_PRESETS: Record<'context7' | 'linear' | 'jira' | 'prjct', MCPServerConfig> =
  {
    context7: {
      command: 'npx',
      args: ['-y', '@upstash/context7-mcp@latest'],
      description: 'Library documentation lookup',
    },
    prjct: getPrjctMcpConfig(),
    linear: {
      command: 'npx',
      args: ['-y', MCP_REMOTE_VERSION, 'https://mcp.linear.app/mcp'],
      description: 'Linear MCP server (OAuth)',
    },
    jira: {
      command: 'npx',
      args: ['-y', MCP_REMOTE_VERSION, 'https://mcp.atlassian.com/v1/mcp'],
      description: 'Atlassian MCP server for Jira (OAuth)',
    },
  }

export function getClaudeMcpConfigPath(): string {
  if (process.env.PRJCT_TEST_MODE === '1') {
    return path.join(os.tmpdir(), 'prjct-context7-test', 'mcp.json')
  }
  return path.join(os.homedir(), '.claude', 'mcp.json')
}

async function readMcpConfig(configPath = getClaudeMcpConfigPath()): Promise<MCPConfig> {
  try {
    const raw = await fs.readFile(configPath, 'utf-8')
    return JSON.parse(raw) as MCPConfig
  } catch (error) {
    const message = getErrorMessage(error).toLowerCase()
    if (message.includes('no such file') || message.includes('enoent')) return {}
    throw new Error(`Failed to read MCP config at ${configPath}: ${getErrorMessage(error)}`)
  }
}

async function writeMcpConfig(
  config: MCPConfig,
  configPath = getClaudeMcpConfigPath()
): Promise<void> {
  await writeJson(configPath, config)
}

export async function upsertMcpServer(
  serverName: string,
  serverConfig: MCPServerConfig,
  configPath = getClaudeMcpConfigPath()
): Promise<{ path: string; changed: boolean }> {
  const config = await readMcpConfig(configPath)
  const nextServers = { ...(config.mcpServers || {}) }
  const previous = nextServers[serverName]
  nextServers[serverName] = serverConfig
  config.mcpServers = nextServers

  const changed = JSON.stringify(previous) !== JSON.stringify(serverConfig)
  await writeMcpConfig(config, configPath)

  return { path: configPath, changed }
}

export async function hasMcpServer(
  serverName: string,
  configPath = getClaudeMcpConfigPath()
): Promise<boolean> {
  const config = await readMcpConfig(configPath)
  return Boolean(config.mcpServers?.[serverName])
}

/**
 * Remove a server entry from an `mcpServers` JSON config, leaving any
 * user-defined servers untouched. When `onlyIfMatches` is given, the entry is
 * removed only if it deep-equals that config — protecting a user-owned server
 * that happens to share the name of a prjct-managed preset. Missing file or
 * missing entry is a no-op (`changed: false`).
 */
export async function removeMcpServer(
  serverName: string,
  configPath = getClaudeMcpConfigPath(),
  onlyIfMatches?: MCPServerConfig
): Promise<{ path: string; changed: boolean }> {
  const config = await readMcpConfig(configPath)
  const servers = config.mcpServers
  const existing = servers?.[serverName]
  if (!servers || !existing) return { path: configPath, changed: false }
  if (onlyIfMatches && JSON.stringify(existing) !== JSON.stringify(onlyIfMatches)) {
    return { path: configPath, changed: false }
  }

  delete servers[serverName]
  if (Object.keys(servers).length === 0) delete config.mcpServers
  await writeMcpConfig(config, configPath)
  return { path: configPath, changed: true }
}

// Shared provider-config write helpers (Codex, Grok, …) — marker-delimited
// TOML block upsert + changed-aware write tail, factored out of the
// per-provider config writers so the byte-identical logic lives once.

/**
 * Upsert a marker-delimited block into `existing`. Returns the new text plus
 * whether a user-managed (marker-less) table of the same name was found — in
 * which case we leave their config untouched.
 */
export function upsertMarkedBlock(
  existing: string,
  block: string,
  startMarker: string,
  endMarker: string,
  tableName: string
): { next: string; skipped?: 'user-managed' } {
  const startIdx = existing.indexOf(startMarker)
  const endIdx = existing.indexOf(endMarker)

  if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
    const before = existing.slice(0, startIdx)
    const trailing = existing.slice(endIdx + endMarker.length)
    const after = trailing.startsWith('\n') ? trailing.slice(1) : trailing
    return { next: before + block + after }
  }
  if (new RegExp(`^\\s*\\[mcp_servers\\.${tableName}\\]`, 'm').test(existing)) {
    return { next: existing, skipped: 'user-managed' }
  }
  if (existing.trim().length > 0) {
    return { next: `${existing.trimEnd()}\n\n${block}` }
  }
  return { next: block }
}

/**
 * Write `next` to `configPath` only if it differs from `existing`, creating
 * parent directories as needed. Shared write-tail for the provider
 * MCP/config writers (Codex, Grok, …): "if unchanged, no-op; else mkdir +
 * write" — callers merge in their own extra result fields (e.g. `skipped`,
 * `statusLineChanged`) on top of `{ path, changed }`.
 */
export async function writeConfigIfChanged(
  configPath: string,
  existing: string,
  next: string
): Promise<{ path: string; changed: boolean }> {
  if (next === existing) {
    return { path: configPath, changed: false }
  }
  await fs.mkdir(path.dirname(configPath), { recursive: true })
  await fs.writeFile(configPath, next, 'utf-8')
  return { path: configPath, changed: true }
}
