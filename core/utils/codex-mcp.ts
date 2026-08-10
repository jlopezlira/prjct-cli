/**
 * Codex config wiring — ensures `~/.codex/config.toml` carries the prjct
 * MCP server entry and a visible TUI status line.
 *
 * Codex has no JSON mcp config like Claude's `~/.claude/mcp.json`; its
 * MCP servers live as `[mcp_servers.<name>]` TOML tables in config.toml.
 * We manage our entry between `# prjct:mcp` comment markers (TOML has no
 * HTML comments) so re-runs replace our block and never touch user
 * content. If the user defined `[mcp_servers.prjct]` themselves (no
 * markers), we leave their config alone.
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import { resolveUserPath } from '../infrastructure/user-home'
import type { MCPServerConfig } from '../types/utils.js'
import { MCP_SERVER_PRESETS } from './mcp-config'

const START_MARKER = '# prjct:mcp:start - managed by prjct, do not edit between markers'
const END_MARKER = '# prjct:mcp:end'
// Context7 gets its own marker pair so it co-exists with the prjct block and
// either can be re-managed independently. Keeping the prjct markers unnamed
// preserves backward compatibility with configs written by older versions.
const CONTEXT7_START_MARKER =
  '# prjct:mcp:context7:start - managed by prjct, do not edit between markers'
const CONTEXT7_END_MARKER = '# prjct:mcp:context7:end'
const CODEX_STATUS_LINE_ITEMS = [
  'model-with-reasoning',
  'current-dir',
  'git-branch',
  'context-remaining',
  'five-hour-limit',
  'weekly-limit',
  'task-progress',
]

export function getCodexConfigTomlPath(): string {
  if (process.env.PRJCT_TEST_MODE === '1') {
    return path.join(resolveUserPath('.prjct-tests'), 'codex', 'config.toml')
  }
  return resolveUserPath('.codex', 'config.toml')
}

function tomlString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

function buildMcpTomlBlock(
  name: string,
  server: MCPServerConfig,
  startMarker: string,
  endMarker: string
): string {
  const args = (server.args ?? []).map(tomlString).join(', ')
  const lines = [
    startMarker,
    `[mcp_servers.${name}]`,
    `command = ${tomlString(server.command)}`,
    `args = [${args}]`,
  ]
  // Codex supports env tables for MCP servers (needed for sparse PATH hosts).
  if (server.env && Object.keys(server.env).length > 0) {
    const pairs = Object.entries(server.env)
      .map(([k, v]) => `${k} = ${tomlString(v)}`)
      .join(', ')
    lines.push(`env = { ${pairs} }`)
  }
  lines.push(endMarker, '')
  return lines.join('\n')
}

export function buildPrjctMcpTomlBlock(server: MCPServerConfig = MCP_SERVER_PRESETS.prjct): string {
  return buildMcpTomlBlock('prjct', server, START_MARKER, END_MARKER)
}

export function buildContext7McpTomlBlock(
  server: MCPServerConfig = MCP_SERVER_PRESETS.context7
): string {
  return buildMcpTomlBlock('context7', server, CONTEXT7_START_MARKER, CONTEXT7_END_MARKER)
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

export function buildCodexStatusLineToml(): string {
  const items = CODEX_STATUS_LINE_ITEMS.map(tomlString).join(', ')
  return ['[tui]', `status_line = [${items}]`, ''].join('\n')
}

function hasCodexStatusLine(existing: string): boolean {
  return /^\s*(?:tui\.)?status_line\s*=/m.test(existing)
}

function ensureCodexStatusLineToml(existing: string): { toml: string; changed: boolean } {
  if (hasCodexStatusLine(existing)) return { toml: existing, changed: false }

  const items = CODEX_STATUS_LINE_ITEMS.map(tomlString).join(', ')
  const statusLine = `status_line = [${items}]\n`
  const tuiMatch = /^\s*\[tui\]\s*$/m.exec(existing)

  if (tuiMatch) {
    const insertAt = tuiMatch.index + tuiMatch[0].length
    const before = existing.slice(0, insertAt)
    const trailing = existing.slice(insertAt)
    const after = trailing.startsWith('\n') ? trailing.slice(1) : trailing
    return {
      toml: `${before}\n${statusLine}${after}`,
      changed: true,
    }
  }

  const block = buildCodexStatusLineToml()
  return {
    toml: existing.trim().length > 0 ? `${existing.trimEnd()}\n\n${block}` : block,
    changed: true,
  }
}

/**
 * Idempotently install/refresh the prjct MCP server and Codex TUI status line.
 *
 * - No file → create it with managed MCP + `[tui].status_line`.
 * - File with our markers → replace the MCP block in place.
 * - File with a user-managed `[mcp_servers.prjct]` (no markers) → preserve it.
 * - Existing `status_line` → preserve the user's selection.
 */
export async function ensureCodexMcpServer(configPath = getCodexConfigTomlPath()): Promise<{
  path: string
  changed: boolean
  skipped?: 'user-managed'
  statusLineChanged?: boolean
}> {
  const existing = await fs.readFile(configPath, 'utf-8').catch(() => '')

  const block = buildPrjctMcpTomlBlock()
  const upserted = upsertMarkedBlock(existing, block, START_MARKER, END_MARKER, 'prjct')
  const skipped = upserted.skipped

  const withStatusLine = ensureCodexStatusLineToml(upserted.next)
  const next = withStatusLine.toml

  if (next === existing) {
    return { path: configPath, changed: false, skipped }
  }

  await fs.mkdir(path.dirname(configPath), { recursive: true })
  await fs.writeFile(configPath, next, 'utf-8')
  return {
    path: configPath,
    changed: true,
    skipped,
    statusLineChanged: withStatusLine.changed,
  }
}

/**
 * Idempotently register the Context7 MCP server in Codex's config.toml so
 * Codex gets the same deterministic-docs capability Claude has via
 * `~/.claude/mcp.json`. Managed between its own marker pair; a user-defined
 * `[mcp_servers.context7]` (no markers) is preserved.
 */
export async function ensureCodexContext7Server(configPath = getCodexConfigTomlPath()): Promise<{
  path: string
  changed: boolean
  skipped?: 'user-managed'
}> {
  const existing = await fs.readFile(configPath, 'utf-8').catch(() => '')

  const block = buildContext7McpTomlBlock()
  const { next, skipped } = upsertMarkedBlock(
    existing,
    block,
    CONTEXT7_START_MARKER,
    CONTEXT7_END_MARKER,
    'context7'
  )

  if (next === existing) {
    return { path: configPath, changed: false, skipped }
  }

  await fs.mkdir(path.dirname(configPath), { recursive: true })
  await fs.writeFile(configPath, next, 'utf-8')
  return { path: configPath, changed: true, skipped }
}

/** True iff config.toml carries a `[mcp_servers.context7]` table (managed or user). */
export async function codexHasContext7Server(
  configPath = getCodexConfigTomlPath()
): Promise<boolean> {
  try {
    const existing = await fs.readFile(configPath, 'utf-8')
    return /^\s*\[mcp_servers\.context7\]/m.test(existing)
  } catch {
    return false
  }
}
