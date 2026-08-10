/**
 * prjct MCP Server
 *
 * Exposes project data via Model Context Protocol.
 * Wraps existing storage and context modules — no new logic.
 *
 * Schema tax: every registered tool's name+description+JSON schema is
 * loaded into the host model every session. Keep DEFAULT tier lean.
 */
import { McpServer } from '@modelcontextprotocol/server'
import { VERSION } from '../utils/version'
import { registerCodeIntelTools } from './tools/code-intel'
import { registerFileTools } from './tools/files'
import { registerMemoryTools } from './tools/memory'
import { registerProjectTools } from './tools/project'
import { registerSpecTools } from './tools/spec'
import { registerWorkflowTools } from './tools/workflow'

/**
 * Compact instructions — hosts already list tool names; avoid duplicating
 * the tool laundry list here (token tax on every session).
 */
const PRJCT_INSTRUCTIONS = `# prjct — project memory + work cycles

Use when work needs durable project memory, intent, or harness gates. Prefer tools over Grep for recall.

## What's here
- Memory save/list/guard · work cycle status/start · analysis · session resume
- Extended (PRJCT_MCP_TOOLS=standard|all): files, code-intel, typed record verbs, signals, skills, tiers, artifacts, workflows, specs

## Gotchas
- Persist memories in ENGLISH. Secrets refused unless force=true.
- projectPath is optional — defaults to MCP cwd / PRJCT_PROJECT_PATH.
- Recall is ranked/best-effort, not a full dump.`

/**
 * Tool surface tiers. Every registered tool costs schema tokens every session.
 *   core     — high-signal only (default, ~10 tools)
 *   standard — + files, code-intel, typed mem, cost, signals, skills, tiers, artifacts
 *   all      — + workflows + specs
 * Override with PRJCT_MCP_TOOLS=core|standard|all.
 */
export type ToolTier = 'core' | 'standard' | 'all'

export const DEFAULT_MCP_TOOL_TIER: ToolTier = 'core'
export const MCP_CATALOG_CACHE_TTL_MS = 24 * 60 * 60 * 1_000

const CATALOG_CACHE_HINT = {
  ttlMs: MCP_CATALOG_CACHE_TTL_MS,
  cacheScope: 'private' as const,
}

export function resolveTier(envValue: string | undefined = process.env.PRJCT_MCP_TOOLS): ToolTier {
  const raw = (envValue ?? DEFAULT_MCP_TOOL_TIER).toLowerCase()
  if (raw === 'standard' || raw === 'all' || raw === 'core') return raw
  return DEFAULT_MCP_TOOL_TIER
}

export function createServer(): McpServer {
  const server = new McpServer(
    { name: 'prjct', version: VERSION },
    {
      capabilities: { tools: { listChanged: false } },
      instructions: PRJCT_INSTRUCTIONS,
      cacheHints: {
        'server/discover': CATALOG_CACHE_HINT,
        'tools/list': CATALOG_CACHE_HINT,
      },
    }
  )

  const tier = resolveTier()
  const extended = tier !== 'core'
  registerMemoryTools(server, { extended })
  registerProjectTools(server, { extended })
  if (tier === 'core') return server

  registerFileTools(server)
  registerCodeIntelTools(server)
  if (tier === 'standard') return server

  registerWorkflowTools(server)
  registerSpecTools(server)
  return server
}
