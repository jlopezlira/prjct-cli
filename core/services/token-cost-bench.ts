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
import type { HookHost } from '../hooks/_shared'
import { _resetGitSnapshotCacheForTests, runPromptHook } from '../hooks/prompt'
import configManager from '../infrastructure/config-manager'
import pathManager from '../infrastructure/path-manager'
import { createServer, PRJCT_INSTRUCTIONS, PRJCT_INSTRUCTIONS_LEAN } from '../mcp/server'
import { projectMemory } from '../memory/project-memory'
import prjctDb from '../storage/database'
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
