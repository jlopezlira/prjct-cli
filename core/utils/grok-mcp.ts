/**
 * Grok Build config wiring — ensures `~/.grok/config.toml` carries the prjct
 * MCP server entry.
 *
 * Grok uses the same TOML shape as Codex (`[mcp_servers.<name>]`). We manage
 * our entry between `# prjct:mcp` comment markers so re-runs replace our block
 * and never touch user content. If the user defined `[mcp_servers.prjct]`
 * themselves (no markers), we leave their config alone.
 *
 * Hooks stay on the Claude-compat path (`inherits-claude`); this module is
 * the native MCP wire so Grok users without a Claude install still get
 * `prjct_*` tools.
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import { resolveUserPath } from '../infrastructure/user-home'
import type { MCPServerConfig } from '../types/utils.js'
import { buildPrjctMcpTomlBlock } from './codex-mcp'
import { MCP_SERVER_PRESETS } from './mcp-config'

const START_MARKER = '# prjct:mcp:start - managed by prjct, do not edit between markers'
const END_MARKER = '# prjct:mcp:end'

export function getGrokConfigTomlPath(): string {
  if (process.env.PRJCT_TEST_MODE === '1') {
    return path.join(resolveUserPath('.prjct-tests'), 'grok', 'config.toml')
  }
  return resolveUserPath('.grok', 'config.toml')
}

/**
 * Upsert a marker-delimited block into `existing`. Returns the new text plus
 * whether a user-managed (marker-less) table of the same name was found — in
 * which case we leave their config untouched.
 */
function upsertMarkedBlock(
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
    const rawAfter = existing.slice(endIdx + endMarker.length)
    const after = rawAfter.startsWith('\n') ? rawAfter.slice(1) : rawAfter
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
 * Idempotently install/refresh the prjct MCP server in Grok's config.toml.
 *
 * - No file → create it with managed MCP.
 * - File with our markers → replace the MCP block in place.
 * - File with a user-managed `[mcp_servers.prjct]` (no markers) → preserve it.
 */
export async function ensureGrokMcpServer(
  configPath = getGrokConfigTomlPath(),
  server: MCPServerConfig = MCP_SERVER_PRESETS.prjct
): Promise<{
  path: string
  changed: boolean
  skipped?: 'user-managed'
}> {
  const existing = await fs.readFile(configPath, 'utf-8').catch(() => '')

  const block = buildPrjctMcpTomlBlock(server)
  const upserted = upsertMarkedBlock(existing, block, START_MARKER, END_MARKER, 'prjct')
  const next = upserted.next
  const skipped = upserted.skipped

  if (next === existing) {
    return { path: configPath, changed: false, skipped }
  }

  await fs.mkdir(path.dirname(configPath), { recursive: true })
  await fs.writeFile(configPath, next, 'utf-8')
  return {
    path: configPath,
    changed: true,
    skipped,
  }
}

/** True iff config.toml carries a `[mcp_servers.prjct]` table (managed or user). */
export async function grokHasPrjctMcpServer(
  configPath = getGrokConfigTomlPath()
): Promise<boolean> {
  try {
    const existing = await fs.readFile(configPath, 'utf-8')
    return /^\s*\[mcp_servers\.prjct\]/m.test(existing) || existing.includes(START_MARKER)
  } catch {
    return false
  }
}
