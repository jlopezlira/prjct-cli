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
import { z } from 'zod'
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
export const PRJCT_INSTRUCTIONS = `# prjct — project memory + work cycles

Use when work needs durable project memory, intent, or harness gates. Prefer tools over Grep for recall.

## What's here
- Memory save/list/guard · work cycle start/status · analysis
- More (PRJCT_MCP_TOOLS=core|standard|all): similar/forget/resume, files, code-intel, typed verbs, signals, skills, artifacts, workflows, specs

## Gotchas
- Persist memories in ENGLISH. Secrets refused unless force=true.
- projectPath is optional — defaults to MCP cwd / PRJCT_PROJECT_PATH.
- Recall is ranked/best-effort, not a full dump.`

/**
 * Lean-tier instructions — non-caching hosts re-pay this block on every API
 * call, so it carries only what changes behavior. More tools: raise
 * PRJCT_MCP_TOOLS.
 */
export const PRJCT_INSTRUCTIONS_LEAN = `# prjct — project memory + work cycles

Prefer these tools over Grep for recall. Memories in ENGLISH; secrets refused unless force=true. projectPath optional (defaults to cwd). More tools: PRJCT_MCP_TOOLS=core|standard|all.`

/**
 * Micro-tier instructions — ONE dispatch tool; the verb map lives in its
 * description. Absolute minimum catalog for hosts that re-pay it per call.
 */
export const PRJCT_INSTRUCTIONS_MICRO = `prjct: project memory + work cycles via the single \`prjct\` tool. Memories in ENGLISH. More tools: PRJCT_MCP_TOOLS=lean|core|standard|all.`

/**
 * Tool surface tiers. Every registered tool costs schema tokens every session.
 *   micro    — ONE dispatch tool (verb + args) for non-caching hosts
 *              (Kimi/Codex) that re-pay the catalog on every API call
 *   lean     — 6 tools (fallback for micro; PRJCT_MCP_TOOLS=lean)
 *   core     — high-signal only (default, ~10 tools)
 *   standard — + files, code-intel, typed mem, cost, signals, skills, tiers, artifacts
 *   all      — + workflows + specs
 * Override with PRJCT_MCP_TOOLS=micro|lean|core|standard|all.
 */
export type ToolTier = 'micro' | 'lean' | 'core' | 'standard' | 'all'

export const DEFAULT_MCP_TOOL_TIER: ToolTier = 'core'
export const MCP_CATALOG_CACHE_TTL_MS = 24 * 60 * 60 * 1_000

const CATALOG_CACHE_HINT = {
  ttlMs: MCP_CATALOG_CACHE_TTL_MS,
  cacheScope: 'private' as const,
}

export function resolveTier(envValue: string | undefined = process.env.PRJCT_MCP_TOOLS): ToolTier {
  const raw = (envValue ?? DEFAULT_MCP_TOOL_TIER).toLowerCase()
  if (raw === 'micro' || raw === 'lean' || raw === 'standard' || raw === 'all' || raw === 'core')
    return raw
  return DEFAULT_MCP_TOOL_TIER
}

/** Micro dispatch verbs → the lean tool each one reuses (zero new logic). */
const MICRO_VERBS = {
  mem_save: 'prjct_mem_save',
  mem_list: 'prjct_mem_list',
  guard: 'prjct_guard',
  task_start: 'prjct_task_start',
  task_set_status: 'prjct_task_set_status',
  analysis: 'prjct_analysis',
} as const

type MicroVerb = keyof typeof MICRO_VERBS

/**
 * Micro tier: ONE `prjct` tool whose handler dispatches to the lean tools'
 * handlers, registered on a hidden inner server. Catalog drops from ~3,050
 * chars (lean, 6 schemas) to <800 — the whole point for hosts that re-send
 * the catalog on every API call. Rollback is env-only: PRJCT_MCP_TOOLS=lean.
 */
function registerMicroTool(server: McpServer): void {
  const inner = new McpServer(
    { name: 'prjct-micro-inner', version: VERSION },
    { capabilities: { tools: { listChanged: false } } }
  )
  registerMemoryTools(inner, { extended: false, lean: true })
  registerProjectTools(inner, { extended: false, lean: true })
  const handlers = (
    inner as unknown as {
      _registeredTools: Record<string, { handler?: (a: unknown, e: unknown) => Promise<unknown> }>
    }
  )._registeredTools

  // MCP SDK TS2589 workaround: cast server to any (same as tools/*)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const s: any = server
  s.registerTool(
    'prjct',
    {
      description:
        'prjct project memory + work cycles. verb+args: mem_save{content,type?,tags?} · ' +
        'mem_list{topic?,limit?,full?} · guard{file} · task_start{description} · ' +
        'task_set_status{status: done|paused|active} · analysis{mode?,full?}. ' +
        'args.projectPath optional (defaults to cwd). Memories in ENGLISH.',
      inputSchema: z.object({
        verb: z.enum(Object.keys(MICRO_VERBS) as [MicroVerb, ...MicroVerb[]]),
        args: z.record(z.string(), z.unknown()).optional(),
      }),
    },
    async (input: { verb: MicroVerb; args?: Record<string, unknown> }) => {
      const handler = handlers[MICRO_VERBS[input.verb]]?.handler
      if (!handler) {
        return {
          content: [
            {
              type: 'text',
              text: `Unknown verb "${input.verb}". Valid: ${Object.keys(MICRO_VERBS).join(', ')}.`,
            },
          ],
        }
      }
      return handler(input.args ?? {}, {})
    }
  )
}

export function createServer(): McpServer {
  const tier = resolveTier()
  const server = new McpServer(
    { name: 'prjct', version: VERSION },
    {
      capabilities: { tools: { listChanged: false } },
      instructions:
        tier === 'micro'
          ? PRJCT_INSTRUCTIONS_MICRO
          : tier === 'lean'
            ? PRJCT_INSTRUCTIONS_LEAN
            : PRJCT_INSTRUCTIONS,
      cacheHints: {
        'server/discover': CATALOG_CACHE_HINT,
        'tools/list': CATALOG_CACHE_HINT,
      },
    }
  )

  if (tier === 'micro') {
    registerMicroTool(server)
    return server
  }

  const lean = tier === 'lean'
  const extended = tier === 'standard' || tier === 'all'
  registerMemoryTools(server, { extended, lean })
  registerProjectTools(server, { extended, lean })
  if (tier === 'lean' || tier === 'core') return server

  registerFileTools(server)
  registerCodeIntelTools(server)
  if (tier === 'standard') return server

  registerWorkflowTools(server)
  registerSpecTools(server)
  return server
}
