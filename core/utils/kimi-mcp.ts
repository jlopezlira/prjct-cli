/**
 * Kimi Code CLI MCP wiring — ensures `~/.kimi-code/mcp.json` carries the prjct
 * (and Context7) MCP server entries so Kimi agents get the `prjct_*` tools,
 * not just the AGENTS.md routing text.
 *
 * The current product (Kimi Code CLI) lives in `~/.kimi-code/`; the legacy
 * Kimi CLI used `~/.kimi/`. We prefer `.kimi-code` and only write to the
 * legacy directory when it is the only one present.
 *
 * Unlike Codex (TOML tables in config.toml), Kimi stores MCP servers as a
 * standard `{ "mcpServers": { ... } }` JSON document — the same shape Claude
 * uses — so we reuse the JSON upsert helpers. Each server is upserted by
 * name, leaving any user-defined servers in the file untouched.
 */

import { existsSync } from 'node:fs'
import path from 'node:path'
import { resolveUserPath } from '../infrastructure/user-home'
import { MCP_SERVER_PRESETS, removeMcpServer, upsertMcpServer } from './mcp-config'

/** Candidate Kimi config dirs, preferred first (`.kimi-code`, legacy `.kimi`). */
function kimiHomeDirs(): string[] {
  if (process.env.PRJCT_TEST_MODE === '1') {
    return [resolveUserPath('.prjct-tests', 'kimi-code'), resolveUserPath('.prjct-tests', 'kimi')]
  }
  return [resolveUserPath('.kimi-code'), resolveUserPath('.kimi')]
}

/** Every mcp.json Kimi may read — used by uninstall to clean both locations. */
export function getKimiMcpConfigPaths(): string[] {
  return kimiHomeDirs().map((dir) => path.join(dir, 'mcp.json'))
}

/**
 * Resolve the mcp.json to write to: `~/.kimi-code/mcp.json` when that dir
 * exists (or when neither does — a fresh install), the legacy
 * `~/.kimi/mcp.json` only when it is the sole Kimi home present.
 */
export function getKimiMcpConfigPath(): string {
  const [kimiCodeDir, legacyDir] = kimiHomeDirs()
  const dir = existsSync(legacyDir) && !existsSync(kimiCodeDir) ? legacyDir : kimiCodeDir
  return path.join(dir, 'mcp.json')
}

/**
 * Idempotently install/refresh the prjct + Context7 MCP servers in Kimi's
 * mcp.json. Returns whether the file changed so callers can report "added" vs
 * "already ready".
 */
export async function ensureKimiMcpServer(configPath = getKimiMcpConfigPath()): Promise<{
  path: string
  changed: boolean
}> {
  const context7 = await upsertMcpServer('context7', MCP_SERVER_PRESETS.context7, configPath)
  const prjct = await upsertMcpServer('prjct', MCP_SERVER_PRESETS.prjct, configPath)
  return { path: configPath, changed: context7.changed || prjct.changed }
}

/**
 * Strip the prjct-managed servers (`prjct`, plus `context7` when it still
 * matches our preset) from every Kimi mcp.json. User-defined servers — and a
 * user-owned `context7` entry — are left untouched.
 */
export async function uninstallKimiMcpServer(): Promise<{
  paths: string[]
  serversRemoved: number
}> {
  const results = await Promise.all(
    getKimiMcpConfigPaths().map(async (configPath) => {
      // Sequential: both removals rewrite the same file.
      const prjct = await removeMcpServer('prjct', configPath)
      const context7 = await removeMcpServer('context7', configPath, MCP_SERVER_PRESETS.context7)
      return { path: configPath, removed: (prjct.changed ? 1 : 0) + (context7.changed ? 1 : 0) }
    })
  )
  return {
    paths: results.filter((r) => r.removed > 0).map((r) => r.path),
    serversRemoved: results.reduce((sum, r) => sum + r.removed, 0),
  }
}
