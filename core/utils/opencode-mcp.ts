/**
 * OpenCode MCP wiring — ensures `~/.config/opencode/opencode.json` carries
 * a managed `mcp.prjct` local server entry.
 *
 * OpenCode uses a different shape than Claude's mcpServers JSON:
 *   mcp.<name> = { type: "local", command: [bin, ...args], enabled, environment? }
 *
 * We merge via jsonc-parser so JSONC comments on existing configs are
 * preserved when possible. Prefer global config (user-wide) so every project
 * gets prjct tools without per-repo commits.
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import * as jsonc from 'jsonc-parser'
import { resolveUserPath } from '../infrastructure/user-home'
import type { MCPServerConfig } from '../types/utils.js'
import { MCP_SERVER_PRESETS } from './mcp-config'

export interface OpenCodeLocalMcp {
  type: 'local'
  command: string[]
  enabled: boolean
  environment?: Record<string, string>
}

export function getOpenCodeConfigPath(): string {
  if (process.env.PRJCT_TEST_MODE === '1') {
    return path.join(resolveUserPath('.prjct-tests'), 'opencode', 'opencode.json')
  }
  return resolveUserPath('.config', 'opencode', 'opencode.json')
}

/** Alternate JSONC path — only used when opencode.json is missing but .jsonc exists. */
export function getOpenCodeJsoncConfigPath(): string {
  if (process.env.PRJCT_TEST_MODE === '1') {
    return path.join(resolveUserPath('.prjct-tests'), 'opencode', 'opencode.jsonc')
  }
  return resolveUserPath('.config', 'opencode', 'opencode.jsonc')
}

/**
 * Map prjct MCPServerConfig → OpenCode local MCP entry.
 */
export function toOpenCodeLocalMcp(
  server: MCPServerConfig = MCP_SERVER_PRESETS.prjct
): OpenCodeLocalMcp {
  const command = [server.command, ...(server.args ?? [])]
  const entry: OpenCodeLocalMcp = {
    type: 'local',
    command,
    enabled: true,
  }
  if (server.env && Object.keys(server.env).length > 0) {
    entry.environment = { ...server.env }
  }
  return entry
}

async function resolveWritePath(preferred = getOpenCodeConfigPath()): Promise<string> {
  // Prefer explicit preferred path (tests pass this). Otherwise prefer existing
  // jsonc over creating a new .json when only jsonc is present.
  try {
    await fs.access(preferred)
    return preferred
  } catch {
    /* fall through */
  }
  if (preferred === getOpenCodeConfigPath()) {
    const jsoncPath = getOpenCodeJsoncConfigPath()
    try {
      await fs.access(jsoncPath)
      return jsoncPath
    } catch {
      /* create preferred */
    }
  }
  return preferred
}

function parseOpenCodeConfig(raw: string): Record<string, unknown> {
  if (!raw.trim()) return {}
  const errors: jsonc.ParseError[] = []
  const result = jsonc.parse(raw, errors, {
    allowTrailingComma: true,
    disallowComments: false,
  })
  if (errors.length > 0) {
    // Fall back to empty object only on total failure; prefer partial?
    // Hard-fail so we never clobber a broken file silently.
    const first = errors[0]
    throw new SyntaxError(
      `OpenCode config parse error at offset ${first.offset}: ${jsonc.printParseErrorCode(first.error)}`
    )
  }
  if (result === null || typeof result !== 'object' || Array.isArray(result)) {
    return {}
  }
  return result as Record<string, unknown>
}

/**
 * Idempotently install/refresh mcp.prjct in OpenCode global config.
 */
export async function ensureOpenCodeMcpServer(
  configPath?: string,
  server: MCPServerConfig = MCP_SERVER_PRESETS.prjct
): Promise<{ path: string; changed: boolean }> {
  const target = configPath ?? (await resolveWritePath())
  await fs.mkdir(path.dirname(target), { recursive: true })

  const existingRaw = await fs.readFile(target, 'utf-8').catch((error) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''
    throw error
  })

  const entry = toOpenCodeLocalMcp(server)

  if (!existingRaw.trim()) {
    const fresh = {
      $schema: 'https://opencode.ai/config.json',
      mcp: {
        prjct: entry,
      },
    }
    await fs.writeFile(target, `${JSON.stringify(fresh, null, 2)}\n`, 'utf-8')
    return { path: target, changed: true }
  }

  const parsed = parseOpenCodeConfig(existingRaw)
  const mcp = (parsed.mcp ?? {}) as Record<string, unknown>
  const previous = mcp.prjct
  const changed = JSON.stringify(previous) !== JSON.stringify(entry)
  if (!changed) {
    return { path: target, changed: false }
  }

  // Use jsonc modify so comments / trailing commas are preserved when possible.
  const formatting = { tabSize: 2, insertSpaces: true } as const
  const withMcp =
    !parsed.mcp || typeof parsed.mcp !== 'object'
      ? jsonc.applyEdits(
          existingRaw,
          jsonc.modify(existingRaw, ['mcp'], {}, { formattingOptions: formatting })
        )
      : existingRaw
  const withPrjct = jsonc.applyEdits(
    withMcp,
    jsonc.modify(withMcp, ['mcp', 'prjct'], entry, { formattingOptions: formatting })
  )
  // Ensure schema hint for editors when missing
  const next = !parsed.$schema
    ? jsonc.applyEdits(
        withPrjct,
        jsonc.modify(withPrjct, ['$schema'], 'https://opencode.ai/config.json', {
          formattingOptions: formatting,
          isArrayInsertion: false,
        })
      )
    : withPrjct

  await fs.writeFile(target, next.endsWith('\n') ? next : `${next}\n`, 'utf-8')
  return { path: target, changed: true }
}

/** True iff config has a local mcp.prjct entry (any shape with command/mcp-server). */
export function hasOpenCodePrjctMcp(raw: string | null | undefined): boolean {
  if (!raw) return false
  try {
    const parsed = parseOpenCodeConfig(raw)
    const mcp = parsed.mcp as Record<string, unknown> | undefined
    const prjct = mcp?.prjct as Record<string, unknown> | undefined
    if (!prjct) return false
    const command = prjct.command
    if (Array.isArray(command)) {
      return command.some(
        (c) => typeof c === 'string' && (c.includes('prjct') || c.includes('mcp-server'))
      )
    }
    if (typeof command === 'string') {
      return command.includes('prjct') || command.includes('mcp-server')
    }
    // Heuristic for partially-written configs
    return JSON.stringify(prjct).includes('mcp-server') || JSON.stringify(prjct).includes('prjct')
  } catch {
    return raw.includes('"prjct"') && (raw.includes('mcp-server') || raw.includes('type'))
  }
}
