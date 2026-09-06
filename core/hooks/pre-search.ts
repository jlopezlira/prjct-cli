/**
 * PreToolUse hook (matcher: Grep|Glob) — graph augment + knowledge injection.
 *
 * The augment: grep a token that matches indexed symbols and the structural
 * hits ride along as additionalContext.
 *
 * Knowledge-first: when prjct holds judgment-typed knowledge about the very
 * token being grepped (decisions, gotchas, learnings — things no amount of grep
 * can recover, because they were never written to a file), that judgment is
 * placed in front of the model. The DEFAULT is `inject`: the decision/gotcha
 * text rides the Grep as additionalContext (once per token/session) and the
 * search still runs. This replaced a hard DENY — advisory text was measured not
 * to make the agent consult prjct, but the deny then taxed the obedient model
 * (the Grok 2.7× lookup-first tax). Inject needs neither: the model sees the
 * recorded judgment without being told to fetch it, and pays no round trip.
 *
 * `enforce.knowledgeFirst: 'deny'` (or `true`) restores the blocking gate;
 * `false` turns it off. Rollover-stop still denies regardless of mode.
 *
 * Deliberately narrow: fires only on real stored judgment, at most once per
 * token per session, never on Read, never on a project with no such knowledge.
 * Fail-open everywhere: any error → no deny, no context, host proceeds.
 */

import { hasSymbolIndex, searchSymbols } from '../domain/symbol-graph'
import configManager from '../infrastructure/config-manager'
import { gateDelivery, readSessionTurnCount } from '../services/session-context-cache'
import { sessionRolloverVerdict } from '../services/session-rollover'
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

/** Knowledge that grep can never recover: it lives in judgment, not in files. */
const KNOWLEDGE_TYPES = ['decision', 'gotcha', 'anti-pattern', 'learning', 'fact']
/** One stray match is noise; two is a repo that has actually decided something. */
const MIN_KNOWLEDGE_HITS = 2
const KNOWLEDGE_LOOKUP_LIMIT = 6

type KnowledgeMode = 'off' | 'inject' | 'deny'

/**
 * Default is `inject`: advisory text the model may ignore was measured to fail,
 * and a hard deny taxes the obedient model (the Grok 2.7× lookup-first tax).
 * Injecting the recorded judgment inline needs neither — the model sees the
 * decision without being told to fetch it, and the grep still runs.
 */
function resolveKnowledgeMode(value: boolean | 'inject' | 'deny' | undefined): KnowledgeMode {
  if (value === false) return 'off'
  if (value === true || value === 'deny') return 'deny'
  return 'inject'
}

/** Judgment hits for a token, or [] — the content grep can never recover. */
async function knowledgeHits(projectId: string, token: string) {
  const { projectMemory } = await import('../memory/project-memory')
  return projectMemory
    .searchFts(projectId, [token], KNOWLEDGE_LOOKUP_LIMIT)
    .filter((entry) => KNOWLEDGE_TYPES.includes(entry.type))
}

async function decideKnowledgeFirst(
  projectPath: string,
  input: HookInput
): Promise<{ deny: string } | null> {
  try {
    const tool = (input.tool_name ?? '').toLowerCase()
    if (tool && !/grep|glob|search/i.test(tool)) return null

    const config = await configManager.readConfig(projectPath)
    if (!config?.projectId) return null
    const sessionId = input.session_id?.trim() || input.conversation_id?.trim() || undefined
    const sessionTurns = await readSessionTurnCount({
      projectId: config.projectId,
      projectPath,
      sessionId,
    })
    // Rollover stop is a deterministic MUST, independent of knowledge mode.
    const rollover = sessionRolloverVerdict(config, sessionTurns)
    if (rollover.stopped && rollover.cue) return { deny: rollover.cue }

    // Only the legacy `deny` mode blocks; `inject` (default) and `off` never do
    // — the judgment rides `build` as additionalContext instead.
    if (resolveKnowledgeMode(config.enforce?.knowledgeFirst) !== 'deny') return null

    const token = extractToken(input)
    if (!token || token.length < 4) return null
    // Budget bail returns null — the 'nothing to say' contract (mem_91).
    const started = Date.now()
    const hits = await knowledgeHits(config.projectId, token)
    if (hits.length < MIN_KNOWLEDGE_HITS) return null
    if (Date.now() - started > HARD_CAP_MS) return null

    const reason = [
      `prjct holds ${hits.length} recorded ${hits.length === 1 ? 'judgment' : 'judgments'} about \`${token}\` — decisions and gotchas that live in project memory, not in any file, so no grep will find them.`,
      '',
      `Run this first: \`prjct search "${token}"\``,
      '',
      'Then repeat this Grep/Glob if you still need the code — the same token will not be blocked again this session.',
    ].join('\n')

    const gate = await gateDelivery({
      projectId: config.projectId,
      projectPath,
      sessionId: input.session_id ?? input.conversation_id,
      surface: 'pre-search-knowledge-gate',
      key: token,
      content: reason,
      noSession: { mode: 'static', ttlMs: NO_SESSION_TTL_MS },
    })
    return gate.suppressed ? null : { deny: reason }
  } catch {
    return null // enforcement never bricks a session
  }
}

/**
 * Inject recorded judgment about the grepped token as non-blocking context —
 * the model-independent replacement for the deny. The decision/gotcha text is
 * placed in front of the model inline, once per token/session, and the Grep
 * proceeds. Returns null outside `inject` mode. Budget bail → null (mem_91).
 */
async function buildKnowledgeInject(projectPath: string, input: HookInput): Promise<string | null> {
  try {
    const tool = (input.tool_name ?? '').toLowerCase()
    if (tool && !/grep|glob|search/i.test(tool)) return null
    const config = await configManager.readConfig(projectPath)
    if (!config?.projectId) return null
    if (resolveKnowledgeMode(config.enforce?.knowledgeFirst) !== 'inject') return null
    const token = extractToken(input)
    if (!token || token.length < 4) return null
    const started = Date.now()
    const hits = await knowledgeHits(config.projectId, token)
    if (hits.length < MIN_KNOWLEDGE_HITS) return null
    if (Date.now() - started > HARD_CAP_MS) return null

    const { formatMemoryDigestLine } = await import('../memory/format')
    const lines = [
      `# prjct: recorded judgment about \`${token}\` (grep won't find this)`,
      '',
      ...hits.slice(0, MAX_HITS).map((h) => {
        const digest = formatMemoryDigestLine(h, { minTeaser: 24, maxTeaser: 160 })
        const file = h.tags?.file
        const where = file ? ` · \`${file}\`` : ''
        return `- **[${h.type}]** ${digest}${where}`
      }),
      '',
      '> Injected once this session; your Grep/Glob is running. Supersede stale calls with `prjct remember`.',
    ]
    const content = safeTruncate(lines.join('\n'), MAX_CHARS, undefined, TAIL_CHARS)
    const gate = await gateDelivery({
      projectId: config.projectId,
      projectPath,
      sessionId: input.session_id ?? input.conversation_id,
      surface: 'pre-search-knowledge-inject',
      key: token,
      content,
      noSession: { mode: 'static', ttlMs: NO_SESSION_TTL_MS },
    })
    return gate.suppressed ? null : content
  } catch {
    return null
  }
}

export async function runPreSearchHook(projectPath?: string, io?: HookIo): Promise<void> {
  await runHook<HookInput>(
    {
      event: 'PreToolUse',
      projectPath,
      decide: (input, p) => decideKnowledgeFirst(p, input),
      build: (input, p) => buildPreSearchContext(p, input),
    },
    io
  )
}

/**
 * Non-blocking additionalContext for a Grep/Glob: recorded judgment about the
 * token (inject mode) first, then the symbol-graph hits. Either may be null.
 */
async function buildPreSearchContext(
  projectPath: string,
  input: HookInput
): Promise<string | null> {
  const [knowledge, augment] = await Promise.all([
    buildKnowledgeInject(projectPath, input),
    buildSearchAugment(projectPath, input),
  ])
  const blocks = [knowledge, augment].filter((b): b is string => Boolean(b))
  return blocks.length ? blocks.join('\n\n') : null
}

export const _internal = {
  extractToken,
  buildSearchAugment,
  buildKnowledgeInject,
  buildPreSearchContext,
  resolveKnowledgeMode,
  decideKnowledgeFirst,
}
