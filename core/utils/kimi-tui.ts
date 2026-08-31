/**
 * Kimi Code TUI wiring — ensures `~/.kimi-code/tui.toml` runs the prjct
 * statusline as the footer, so Kimi sessions show the same toolbar Claude
 * Code does.
 *
 * Kimi's `[status_line].command` contract (verified against the bundled
 * FooterComponent): the command runs via `sh -c` every ≥1s with a 300ms hard
 * timeout, receives a FLAT JSON snapshot on stdin ({model, cwd, gitBranch,
 * contextTokens, maxContextTokens, …}), and its first stdout line replaces
 * footer line 1. The prjct statusline script parses that shape natively (see
 * assets/statusline/lib/cache.sh) and its 2s render cache keeps repeat runs
 * well under the timeout.
 *
 * Mirrors the Codex `[tui].status_line` policy in codex-mcp.ts: add ours only
 * when the user has no active `[status_line]` section; an existing one —
 * theirs or ours — is always preserved.
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import pathManager from '../infrastructure/path-manager'
import { getKimiHomeDir } from './kimi-mcp'
import { writeConfigIfChanged } from './mcp-config'

export function getKimiTuiTomlPath(): string {
  return path.join(getKimiHomeDir(), 'tui.toml')
}

/** Absolute path of the shared prjct statusline script (~/.prjct-cli). */
export function getPrjctStatusLineScriptPath(): string {
  return path.join(pathManager.getStatusLinePath(), 'statusline.sh')
}

function tomlString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

export function buildKimiStatusLineToml(command: string = getPrjctStatusLineScriptPath()): string {
  return ['[status_line]', `command = ${tomlString(command)}`, ''].join('\n')
}

/**
 * True when tui.toml already carries an ACTIVE `[status_line]` section.
 * Kimi ships a commented-out `# [status_line]` template — that does not count.
 */
function hasKimiStatusLine(existing: string): boolean {
  return /^\s*\[status_line\]/m.test(existing)
}

/**
 * Idempotently install the prjct statusline into Kimi's tui.toml.
 *
 * - No file → create it with our `[status_line]` block.
 * - File without an active `[status_line]` → append ours.
 * - Active `[status_line]` (user's items/command, or ours) → preserve as-is.
 */
export async function ensureKimiStatusLine(configPath = getKimiTuiTomlPath()): Promise<{
  path: string
  changed: boolean
}> {
  const existing = await fs.readFile(configPath, 'utf-8').catch(() => '')

  if (hasKimiStatusLine(existing)) return { path: configPath, changed: false }

  const block = buildKimiStatusLineToml()
  const next = existing.trim().length > 0 ? `${existing.trimEnd()}\n\n${block}` : block
  return writeConfigIfChanged(configPath, existing, next)
}
