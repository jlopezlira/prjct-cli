/**
 * PreToolUse hook (matcher: Grep|Glob) — non-blocking graph augment.
 *
 * CBM-inspired: when the agent greps/globs a token that matches indexed
 * symbols, inject those hits as additionalContext so the agent gets
 * structural context alongside search results. Never gates, never denies,
 * never blocks Read (read-before-edit invariant).
 *
 * Fail-open: any error → null context → host proceeds normally.
 */

import { hasSymbolIndex, searchSymbols } from '../domain/symbol-graph'
import configManager from '../infrastructure/config-manager'
import { gateDelivery } from '../services/session-context-cache'
import { type HookIo, runHook } from './_runner'
import { safeTruncate } from './_shared'

const MAX_CHARS = 900
/** Tail budget for guidance blocks — the closing action must survive the cut. */
const TAIL_CHARS = Math.floor(MAX_CHARS / 4)

const HARD_CAP_MS = 80
const MAX_HITS = 8
/** Sessionless dedupe window: symbol hits are static between syncs, so a
 *  short cwd-scoped TTL is safe even with two concurrent agents (identical
 *  advisory content for both). */
const NO_SESSION_TTL_MS = 15 * 60_000

interface HookInput {
  tool_name?: string
  tool_input?: {
    pattern?: string
    path?: string
    glob?: string
    /** Claude Code Grep */
    query?: string
  }
  session_id?: string
  conversation_id?: string
}

function extractToken(input: HookInput): string | null {
  const raw = input.tool_input?.pattern ?? input.tool_input?.query ?? input.tool_input?.glob ?? ''
  if (!raw || typeof raw !== 'string') return null
  // Pull the most symbol-like token (identifier, not pure regex noise)
  const identifiers = raw.match(/[A-Za-z_][A-Za-z0-9_]{2,}/g)
  if (!identifiers || identifiers.length === 0) return null
  // Prefer longest camel/Pascal token
  identifiers.sort((a, b) => b.length - a.length)
  const skip = new Set([
    'the',
    'and',
    'for',
    'from',
    'import',
    'export',
    'function',
    'class',
    'const',
    'type',
    'interface',
    'return',
    'async',
    'await',
    'true',
    'false',
    'null',
    'undefined',
    'test',
    'describe',
    'src',
    'core',
    'node',
    'modules',
  ])
  for (const id of identifiers) {
    if (!skip.has(id.toLowerCase())) return id
  }
  return identifiers[0] ?? null
}

async function buildSearchAugment(projectPath: string, input: HookInput): Promise<string | null> {
  const started = Date.now()
  try {
    const tool = (input.tool_name ?? '').toLowerCase()
    if (tool && !/grep|glob|search/i.test(tool)) return null

    const token = extractToken(input)
    if (!token) return null

    const config = await configManager.readConfig(projectPath)
    if (!config?.projectId) return null
    if (!hasSymbolIndex(config.projectId)) return null
    if (Date.now() - started > HARD_CAP_MS) return null

    const hits = searchSymbols(config.projectId, token, { limit: MAX_HITS })
    if (hits.length === 0) return null
    if (Date.now() - started > HARD_CAP_MS) return null

    const lines = [
      `# prjct code graph (non-blocking)`,
      ``,
      `Grep/Glob token \`${token}\` matches indexed symbols — prefer these before more tree walks:`,
      '',
    ]
    for (const h of hits) {
      lines.push(
        `- **${h.name}** (${h.kind}${h.exported ? ', exported' : ''}) — \`${h.file}:${h.startLine}\``
      )
    }
    lines.push('')
    lines.push(
      `> Expand: \`prjct code trace ${token}\` or MCP \`prjct_trace_path\`. This inject never blocks the tool.`
    )
    const augment = safeTruncate(lines.join('\n'), MAX_CHARS, undefined, TAIL_CHARS)
    // Same token → same hits until the next sync: inject ONCE per session
    // (durable stamp), not on every Grep/Glob of the same identifier.
    const gate = await gateDelivery({
      projectId: config.projectId,
      projectPath,
      sessionId: input.session_id ?? input.conversation_id,
      surface: 'pre-search',
      key: token,
      content: augment,
      noSession: { mode: 'static', ttlMs: NO_SESSION_TTL_MS },
    })
    return gate.suppressed ? null : augment
  } catch {
    return null
  }
}

export async function runPreSearchHook(projectPath?: string, io?: HookIo): Promise<void> {
  await runHook<HookInput>(
    {
      event: 'PreToolUse',
      projectPath,
      // Never deny — always fall through to build (or empty)
      build: (input, p) => buildSearchAugment(p, input),
    },
    io
  )
}

export const _internal = { extractToken, buildSearchAugment }
