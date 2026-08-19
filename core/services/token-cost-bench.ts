/**
 * Token-cost bench — measures what non-caching hosts (Kimi/Codex) actually
 * re-pay for prjct-injected context, deterministically and without a live
 * model. Anthropic prompt caching shields Claude from most of this; Kimi and
 * Codex re-send the full history plus the MCP tool catalog on EVERY API call
 * of their agentic loops, so every injected byte is paid many times over.
 *
 * Primary metric: replay-weighted injected chars per simulated session —
 *   M = Σ_turns(emittedChars_i × apiCallsFrom_i) + listToolsChars × totalCalls
 * with a fixed CALLS_PER_TURN. Tokens ≈ chars / 4.
 *
 * Used by:
 *   - scripts/bench-token-cost.ts (CLI report)
 *   - core/__tests__/services/token-cost-bench.test.ts (release ceiling)
 */

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { z } from 'zod'
import { indexSymbols } from '../domain/symbol-graph'
import type { HookHost } from '../hooks/_shared'
import { runPreEditHook } from '../hooks/pre-edit'
import { runPreSearchHook } from '../hooks/pre-search'
import { _resetGitSnapshotCacheForTests, runPromptHook } from '../hooks/prompt'
import { runSessionStartHook } from '../hooks/session-start'
import { runSubagentStartHook } from '../hooks/subagent-start'
import configManager from '../infrastructure/config-manager'
import pathManager from '../infrastructure/path-manager'
import { createServer, PRJCT_INSTRUCTIONS, PRJCT_INSTRUCTIONS_LEAN } from '../mcp/server'
import { projectMemory } from '../memory/project-memory'
import prjctDb from '../storage/database'
import llmAnalysisStorage from '../storage/llm-analysis-storage'
import { stateStorage } from '../storage/state-storage'
import { execFileAsync } from '../utils/exec'

/** Modeled API round-trips per user turn in an agentic loop. */
export const CALLS_PER_TURN = 4
/** Default simulated session length. */
export const SESSION_TURNS = 50
/** Rough chars-per-token for the report's token estimates. */
const CHARS_PER_TOKEN = 4

export interface ListToolsCost {
  tier: string
  toolCount: number
  descriptionChars: number
  schemaChars: number
  instructionChars: number
  totalChars: number
}

export interface SessionCost {
  host: HookHost
  turns: number
  /** Model-visible injected chars per turn (0 = deduped/no emission). */
  perTurnChars: number[]
  /** Turns that actually emitted a payload. */
  emittedTurns: number
  totalChars: number
}

export interface ReplayWeightedCost {
  host: HookHost
  /** Σ emitted_i × callsFrom_i — history re-pay in char-calls. */
  hookCharCalls: number
  /** listToolsChars × totalCalls — catalog re-pay in char-calls. */
  catalogCharCalls: number
  totalCharCalls: number
  approxTokenCalls: number
}

export interface TokenCostReport {
  listTools: ListToolsCost[]
  sessions: SessionCost[]
  replay: ReplayWeightedCost[]
}

type RegisteredTools = Record<string, { description?: string; inputSchema?: z.ZodType }>

/**
 * Wire-shape ListTools measurement: names + descriptions + the JSON Schema
 * the host actually receives (z.toJSONSchema), plus server instructions.
 * (The retired .tmp/mcp-measure.ts stringified the raw Zod object — wrong
 * bytes; this matches tool-tiers.test.ts.)
 */
export function measureListTools(tier: string): ListToolsCost {
  const previous = process.env.PRJCT_MCP_TOOLS
  process.env.PRJCT_MCP_TOOLS = tier
  try {
    const server = createServer() as unknown as { _registeredTools?: RegisteredTools }
    const tools = server._registeredTools ?? {}
    const totals = Object.entries(tools).reduce(
      (acc, [name, tool]) => ({
        descriptionChars: acc.descriptionChars + name.length + (tool.description ?? '').length,
        schemaChars:
          acc.schemaChars +
          (tool.inputSchema ? JSON.stringify(z.toJSONSchema(tool.inputSchema)).length : 0),
      }),
      { descriptionChars: 0, schemaChars: 0 }
    )
    const instructionChars =
      tier === 'lean' ? PRJCT_INSTRUCTIONS_LEAN.length : PRJCT_INSTRUCTIONS.length
    return {
      tier,
      toolCount: Object.keys(tools).length,
      descriptionChars: totals.descriptionChars,
      schemaChars: totals.schemaChars,
      instructionChars,
      totalChars: totals.descriptionChars + totals.schemaChars + instructionChars,
    }
  } finally {
    if (previous === undefined) delete process.env.PRJCT_MCP_TOOLS
    else process.env.PRJCT_MCP_TOOLS = previous
  }
}

/**
 * Scripted 50-prompt session: active cycle, seeded memories, and a git
 * mutation schedule that mirrors an agent editing files every turn — the
 * exact conditions that bust the whole-payload dedup hash today.
 */
const SESSION_PROMPTS: ReadonlyArray<string> = [
  'fix the auth token refresh bug',
  'run the tests',
  'continue',
  'refactor the session cache module',
  'add error handling to the api client',
  'check the migration gotchas',
  'implement rate limiting for the webhook',
  'clean up the parser',
  'update the readme',
  'review the auth changes',
]

interface SessionFixture {
  projectPath: string
  projectId: string
  sessionId: string
}

async function git(fixture: SessionFixture, args: string[]): Promise<void> {
  await execFileAsync('git', args, { cwd: fixture.projectPath })
}

async function createSessionFixture(): Promise<SessionFixture> {
  const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'prjct-token-bench-'))
  const projectId = `token-bench-${crypto.randomUUID()}`
  const fixture: SessionFixture = { projectPath, projectId, sessionId: 'token-bench-session' }
  await fs.mkdir(path.join(projectPath, '.prjct'), { recursive: true })
  await configManager.writeConfig(projectPath, {
    projectId,
    dataPath: path.join(projectPath, '.prjct-data'),
  } as Parameters<typeof configManager.writeConfig>[1])
  await pathManager.ensureProjectStructure(projectId)

  await git(fixture, ['init', '-q', '-b', 'main'])
  await git(fixture, ['config', 'user.email', 'bench@example.com'])
  await git(fixture, ['config', 'user.name', 'Bench'])
  await git(fixture, ['config', 'commit.gpgsign', 'false'])
  await fs.writeFile(path.join(projectPath, 'app.ts'), 'export const app = 1\n')
  await git(fixture, ['add', '.'])
  await git(fixture, ['commit', '-q', '-m', 'seed'])

  await stateStorage.startTask(projectId, {
    id: 'token-bench-task',
    description: 'improve api error handling',
    startedAt: new Date().toISOString(),
    sessionId: fixture.sessionId,
  } as Parameters<typeof stateStorage.startTask>[1])

  for (const seed of [
    { type: 'gotcha', content: 'Auth token refresh must retry once before failing the session' },
    { type: 'decision', content: 'Session cache entries expire after fifteen minutes' },
    { type: 'pattern', content: 'Webhook handlers validate signatures before parsing payloads' },
  ] as const) {
    await projectMemory
      .remember(projectPath, { type: seed.type, content: seed.content, projectId })
      .catch(() => undefined)
  }
  return fixture
}

/** Deterministic per-turn repo churn — models an agent editing files. */
async function mutateRepo(fixture: SessionFixture, turn: number): Promise<void> {
  await fs.appendFile(path.join(fixture.projectPath, 'app.ts'), `// turn ${turn}\n`)
  if (turn % 3 === 0) {
    await fs.writeFile(path.join(fixture.projectPath, `scratch-${turn}.ts`), `export {}\n`)
  }
  if (turn === 25) await git(fixture, ['checkout', '-q', '-b', 'feat/bench-branch'])
  if (turn === 40) {
    await git(fixture, ['add', '.'])
    await git(fixture, ['commit', '-q', '-m', `wip turn ${turn}`])
  }
}

/** Extract the model-visible injected content from a hook output line. */
function modelVisibleChars(line: string): number {
  const trimmed = line.trim()
  if (!trimmed || trimmed === '{}') return 0
  if (!trimmed.startsWith('{')) return trimmed.length
  try {
    const parsed = JSON.parse(trimmed) as {
      hookSpecificOutput?: { additionalContext?: string }
      systemMessage?: string
    }
    return (parsed.hookSpecificOutput?.additionalContext ?? parsed.systemMessage ?? '').length
  } catch {
    return trimmed.length
  }
}

export async function simulateSession(
  host: HookHost,
  turns: number = SESSION_TURNS
): Promise<SessionCost> {
  const fixture = await createSessionFixture()
  const perTurnChars: number[] = []
  try {
    for (const turn of Array.from({ length: turns }, (_, i) => i + 1)) {
      await mutateRepo(fixture, turn)
      _resetGitSnapshotCacheForTests()
      const captured: string[] = []
      const afterEmits: Array<() => Promise<void>> = []
      await runPromptHook(fixture.projectPath, {
        input: {
          prompt: SESSION_PROMPTS[(turn - 1) % SESSION_PROMPTS.length],
          session_id: fixture.sessionId,
        },
        hookHost: host,
        sink: (chunk) => captured.push(chunk),
        detachAfterEmit: (fn) => afterEmits.push(fn),
      })
      for (const fn of afterEmits) await fn().catch(() => undefined)
      perTurnChars.push(modelVisibleChars(captured.join('')))
    }
  } finally {
    await fs.rm(fixture.projectPath, { recursive: true, force: true }).catch(() => undefined)
    prjctDb.close()
  }
  return {
    host,
    turns,
    perTurnChars,
    emittedTurns: perTurnChars.filter((c) => c > 0).length,
    totalChars: perTurnChars.reduce((sum, c) => sum + c, 0),
  }
}

/**
 * Replay-weighted cost: chars injected at turn i ride the history of every
 * API call from turn i to the end; the tool catalog rides every call.
 */
export function replayWeighted(session: SessionCost, listTools: ListToolsCost): ReplayWeightedCost {
  const hookCharCalls = session.perTurnChars.reduce(
    (sum, chars, index) => sum + chars * (session.turns - index) * CALLS_PER_TURN,
    0
  )
  const catalogCharCalls = listTools.totalChars * session.turns * CALLS_PER_TURN
  const totalCharCalls = hookCharCalls + catalogCharCalls
  return {
    host: session.host,
    hookCharCalls,
    catalogCharCalls,
    totalCharCalls,
    approxTokenCalls: Math.round(totalCharCalls / CHARS_PER_TOKEN),
  }
}

/** Tier per host profile: non-caching hosts install with the lean tier. */
export function tierForHost(host: HookHost): string {
  return host === 'kimi' || host === 'codex' ? 'lean' : 'core'
}

export async function runTokenCostBench(turns: number = SESSION_TURNS): Promise<TokenCostReport> {
  const hosts: HookHost[] = ['claude', 'kimi', 'codex']
  const tiers = [...new Set(['core', ...hosts.map(tierForHost)])]
  const listTools = tiers.map(measureListTools)
  const sessions: SessionCost[] = []
  for (const host of hosts) {
    sessions.push(await simulateSession(host, turns))
  }
  const replay = sessions.map((session) =>
    replayWeighted(
      session,
      listTools.find((lt) => lt.tier === tierForHost(session.host)) ?? listTools[0]!
    )
  )
  return { listTools, sessions, replay }
}

export function formatTokenCostMarkdown(report: TokenCostReport): string {
  const lines = [
    '# prjct token-cost bench',
    '',
    `Session model: ${report.sessions[0]?.turns ?? SESSION_TURNS} turns × ${CALLS_PER_TURN} API calls/turn (non-caching host re-pays history + tool catalog every call).`,
    '',
    '## ListTools catalog (per API call)',
    '',
    '| Tier | Tools | Descriptions | Schemas | Instructions | Total chars | ≈Tokens |',
    '|---|---:|---:|---:|---:|---:|---:|',
  ]
  for (const lt of report.listTools) {
    lines.push(
      `| ${lt.tier} | ${lt.toolCount} | ${lt.descriptionChars} | ${lt.schemaChars} | ${lt.instructionChars} | ${lt.totalChars} | ${Math.round(lt.totalChars / CHARS_PER_TOKEN)} |`
    )
  }
  lines.push('', '## Per-turn hook emission', '')
  lines.push('| Host | Emitted turns | Total chars | Avg/turn | ≈Tokens |')
  lines.push('|---|---:|---:|---:|---:|')
  for (const s of report.sessions) {
    lines.push(
      `| ${s.host} | ${s.emittedTurns}/${s.turns} | ${s.totalChars} | ${Math.round(s.totalChars / s.turns)} | ${Math.round(s.totalChars / CHARS_PER_TOKEN)} |`
    )
  }
  lines.push('', '## Replay-weighted cost (primary metric M)', '')
  lines.push('| Host | Hook char-calls | Catalog char-calls | Total | ≈Token-calls |')
  lines.push('|---|---:|---:|---:|---:|')
  for (const r of report.replay) {
    lines.push(
      `| ${r.host} | ${r.hookCharCalls.toLocaleString()} | ${r.catalogCharCalls.toLocaleString()} | ${r.totalCharCalls.toLocaleString()} | ${r.approxTokenCalls.toLocaleString()} |`
    )
  }
  lines.push('', 'Reproduce: `bun scripts/bench-token-cost.ts`')
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Full-harness simulation — EVERY surface prjct injects into an agent context:
// SessionStart (startup + mid-session compact), per-prompt hook, PreToolUse
// augments (pre-search, pre-edit), subagent digests, and repeated MCP tool
// results. This is the metric the universal delivery gate is ratcheted on;
// the prompt-only simulateSession above remains the v3.99 regression floor.
// ---------------------------------------------------------------------------

export interface SurfaceCost {
  events: number
  emitted: number
  chars: number
}

export interface HarnessSessionCost {
  host: HookHost
  turns: number
  sessionStart: { startupChars: number; compactChars: number; resumeChars: number }
  prompt: SessionCost
  preSearch: SurfaceCost
  preEdit: SurfaceCost
  subagent: SurfaceCost
  mcp: SurfaceCost
  totalChars: number
  /**
   * Replay-weighted char-calls: every injected char rides the history of all
   * API calls from its turn to session end (catalog rides every call).
   * Model: startup rides all turns; compact rides turns 26..end; per-turn
   * surfaces ride (turns − turn_i); consistent pre/post so ratchets compare.
   */
  totalCharCalls: number
  approxTokenCalls: number
}

/** Symbols the fixture indexes so pre-search has real hits to inject. */
const HARNESS_SRC = [
  'export function refreshAuthToken(session: string): string { return session }',
  'export class SessionCacheStore { get(key: string): string { return key } }',
  'export function validateWebhookSignature(payload: string): boolean { return payload.length > 0 }',
  'export function parseRateLimitHeaders(input: string): number { return input.length }',
].join('\n')

const SEARCH_TOKENS = ['refreshAuthToken', 'SessionCacheStore', 'validateWebhookSignature']
const EDIT_FILES = ['app.ts', 'harness-src.ts', 'app.ts', 'harness-src.ts']

/** Minimal relational analysis so prjct_analysis has real content to serve. */
async function seedHarnessFixture(fixture: SessionFixture): Promise<void> {
  await fs.writeFile(path.join(fixture.projectPath, 'harness-src.ts'), `${HARNESS_SRC}\n`)
  await indexSymbols(fixture.projectPath, fixture.projectId).catch(() => undefined)
  try {
    llmAnalysisStorage.save(fixture.projectId, {
      version: 1,
      commitHash: null,
      analyzedAt: new Date().toISOString(),
      projectType: 'cli',
      stack: { languages: ['TypeScript'], frameworks: ['Bun'] },
      architecture: {
        style: 'modular services',
        domains: ['auth', 'webhooks'],
        insights: ['Session cache is the hot path', 'Webhook handlers are pure functions'],
      },
      patterns: [
        { name: 'validate-before-parse', description: 'Signatures checked before payload parse' },
      ],
      antiPatterns: [
        {
          issue: 'Retry loops without backoff',
          suggestion: 'Add jittered backoff',
          severity: 'medium',
        },
      ],
      techDebt: [],
      riskAreas: [],
      refactorSuggestions: [],
      conventions: [{ rule: 'const-only modules' }, { rule: 'no barrel files' }],
      commands: { test: 'bun test', build: 'bun run build' },
      projectInsights: ['Rate limits are per-webhook, not global'],
    } as unknown as Parameters<typeof llmAnalysisStorage.save>[1])
  } catch {
    /* analysis seeding is best-effort; surfaces still measure consistently */
  }
}

interface HookRun {
  chars: number
}

/** Drive one hook end-to-end through HookIo and measure model-visible chars. */
async function driveHook(
  run: (projectPath: string, io: Parameters<typeof runPromptHook>[1]) => Promise<void>,
  fixture: SessionFixture,
  input: Record<string, unknown>,
  host: HookHost
): Promise<HookRun> {
  const captured: string[] = []
  const afterEmits: Array<() => Promise<void>> = []
  await run(fixture.projectPath, {
    input,
    hookHost: host,
    sink: (chunk) => captured.push(chunk),
    detachAfterEmit: (fn) => afterEmits.push(fn),
  })
  for (const fn of afterEmits) await fn().catch(() => undefined)
  return { chars: modelVisibleChars(captured.join('')) }
}

type McpTool = { handler?: (args: unknown, extra: unknown) => Promise<unknown> }

function mcpResultChars(result: unknown): number {
  const content = (result as { content?: Array<{ text?: string }> })?.content
  if (!Array.isArray(content)) return 0
  return content.reduce((sum, item) => sum + (item.text?.length ?? 0), 0)
}

/** Deterministic MCP call schedule: tools available in EVERY tier. */
const MCP_SCHEDULE: ReadonlyArray<{
  turn: number
  tool: string
  args: (f: SessionFixture) => unknown
}> = [
  { turn: 5, tool: 'prjct_analysis', args: (f) => ({ projectPath: f.projectPath }) },
  {
    turn: 8,
    tool: 'prjct_mem_list',
    args: (f) => ({ projectPath: f.projectPath, topic: 'auth token refresh' }),
  },
  { turn: 12, tool: 'prjct_guard', args: (f) => ({ projectPath: f.projectPath, file: 'app.ts' }) },
  {
    turn: 20,
    tool: 'prjct_mem_list',
    args: (f) => ({ projectPath: f.projectPath, topic: 'auth token refresh' }),
  },
  { turn: 30, tool: 'prjct_analysis', args: (f) => ({ projectPath: f.projectPath }) },
  { turn: 36, tool: 'prjct_guard', args: (f) => ({ projectPath: f.projectPath, file: 'app.ts' }) },
  {
    turn: 40,
    tool: 'prjct_mem_list',
    args: (f) => ({ projectPath: f.projectPath, topic: 'auth token refresh' }),
  },
]

const COMPACT_TURN = 25

export async function simulateHarnessSession(
  host: HookHost,
  turns: number = SESSION_TURNS
): Promise<HarnessSessionCost> {
  const fixture = await createSessionFixture()
  const sessionStart = { startupChars: 0, compactChars: 0, resumeChars: 0 }
  const perTurnChars: number[] = []
  const preSearch: SurfaceCost = { events: 0, emitted: 0, chars: 0 }
  const preEdit: SurfaceCost = { events: 0, emitted: 0, chars: 0 }
  const subagent: SurfaceCost = { events: 0, emitted: 0, chars: 0 }
  const mcp: SurfaceCost = { events: 0, emitted: 0, chars: 0 }
  // Char-calls accumulate as we go: chars at turn i ride (turns − i) turns.
  const charCalls = { value: 0 }
  const ride = (chars: number, fromTurn: number): void => {
    charCalls.value += chars * Math.max(turns - fromTurn, 1) * CALLS_PER_TURN
  }

  const previousTier = process.env.PRJCT_MCP_TOOLS
  process.env.PRJCT_MCP_TOOLS = tierForHost(host)
  try {
    await seedHarnessFixture(fixture)
    const server = createServer() as unknown as { _registeredTools?: Record<string, McpTool> }

    const startup = await driveHook(
      runSessionStartHook,
      fixture,
      { source: 'startup', session_id: fixture.sessionId },
      host
    )
    sessionStart.startupChars = startup.chars
    ride(startup.chars, 0)

    for (const turn of Array.from({ length: turns }, (_, i) => i + 1)) {
      await mutateRepo(fixture, turn)
      _resetGitSnapshotCacheForTests()

      if (turn === COMPACT_TURN) {
        const compact = await driveHook(
          runSessionStartHook,
          fixture,
          { source: 'compact', session_id: fixture.sessionId },
          host
        )
        sessionStart.compactChars = compact.chars
        ride(compact.chars, turn)
      }

      const prompt = await driveHook(
        runPromptHook,
        fixture,
        {
          prompt: SESSION_PROMPTS[(turn - 1) % SESSION_PROMPTS.length],
          session_id: fixture.sessionId,
        },
        host
      )
      perTurnChars.push(prompt.chars)
      ride(prompt.chars, turn)

      if (turn % 2 === 0) {
        preSearch.events += 1
        const hit = await driveHook(
          runPreSearchHook,
          fixture,
          {
            tool_name: 'Grep',
            tool_input: { pattern: SEARCH_TOKENS[(turn / 2 - 1) % SEARCH_TOKENS.length] },
            session_id: fixture.sessionId,
          },
          host
        )
        if (hit.chars > 0) preSearch.emitted += 1
        preSearch.chars += hit.chars
        ride(hit.chars, turn)
      }

      if (turn % 3 === 0) {
        preEdit.events += 1
        const hit = await driveHook(
          runPreEditHook,
          fixture,
          {
            tool_name: 'Edit',
            tool_input: {
              file_path: path.join(
                fixture.projectPath,
                EDIT_FILES[(turn / 3 - 1) % EDIT_FILES.length]!
              ),
            },
            session_id: fixture.sessionId,
          },
          host
        )
        if (hit.chars > 0) preEdit.emitted += 1
        preEdit.chars += hit.chars
        ride(hit.chars, turn)
      }

      if (turn === 10 || turn === 35) {
        subagent.events += 1
        const hit = await driveHook(
          runSubagentStartHook,
          fixture,
          { session_id: fixture.sessionId },
          host
        )
        if (hit.chars > 0) subagent.emitted += 1
        subagent.chars += hit.chars
        ride(hit.chars, turn)
      }

      for (const call of MCP_SCHEDULE.filter((c) => c.turn === turn && c.turn <= turns)) {
        const tool = server._registeredTools?.[call.tool]
        if (!tool?.handler) continue
        mcp.events += 1
        const chars = mcpResultChars(await tool.handler(call.args(fixture), {}).catch(() => null))
        if (chars > 0) mcp.emitted += 1
        mcp.chars += chars
        ride(chars, turn)
      }
    }
  } finally {
    if (previousTier === undefined) delete process.env.PRJCT_MCP_TOOLS
    else process.env.PRJCT_MCP_TOOLS = previousTier
    await fs.rm(fixture.projectPath, { recursive: true, force: true }).catch(() => undefined)
    prjctDb.close()
  }

  const prompt: SessionCost = {
    host,
    turns,
    perTurnChars,
    emittedTurns: perTurnChars.filter((c) => c > 0).length,
    totalChars: perTurnChars.reduce((sum, c) => sum + c, 0),
  }
  const catalog = measureListTools(tierForHost(host))
  const catalogCharCalls = catalog.totalChars * turns * CALLS_PER_TURN
  const totalChars =
    sessionStart.startupChars +
    sessionStart.compactChars +
    sessionStart.resumeChars +
    prompt.totalChars +
    preSearch.chars +
    preEdit.chars +
    subagent.chars +
    mcp.chars
  const totalCharCalls = charCalls.value + catalogCharCalls
  return {
    host,
    turns,
    sessionStart,
    prompt,
    preSearch,
    preEdit,
    subagent,
    mcp,
    totalChars,
    totalCharCalls,
    approxTokenCalls: Math.round(totalCharCalls / CHARS_PER_TOKEN),
  }
}

export function formatHarnessMarkdown(costs: HarnessSessionCost[]): string {
  const lines = [
    '# prjct full-harness bench (all surfaces)',
    '',
    '| Host | SessionStart (startup/compact) | Prompt (turns · chars) | pre-search | pre-edit | subagent | MCP results | Total chars | Char-calls M | ≈Token-calls |',
    '|---|---|---|---|---|---|---|---:|---:|---:|',
  ]
  for (const c of costs) {
    lines.push(
      `| ${c.host} | ${c.sessionStart.startupChars}/${c.sessionStart.compactChars} | ${c.prompt.emittedTurns}/${c.prompt.turns} · ${c.prompt.totalChars} | ${c.preSearch.emitted}/${c.preSearch.events} · ${c.preSearch.chars} | ${c.preEdit.emitted}/${c.preEdit.events} · ${c.preEdit.chars} | ${c.subagent.chars} | ${c.mcp.emitted}/${c.mcp.events} · ${c.mcp.chars} | ${c.totalChars.toLocaleString()} | ${c.totalCharCalls.toLocaleString()} | ${c.approxTokenCalls.toLocaleString()} |`
    )
  }
  return lines.join('\n')
}
