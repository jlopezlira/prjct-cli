/**
 * Live A/B runner — same model, same task, with vs without the harness.
 * A faithful TS port of the Python runner that produced the fable-5.1 corpus,
 * with every side effect (spawning `claude`, git worktrees, provisioning an
 * isolated PRJCT_CLI_HOME) behind an injectable dependency so the orchestration
 * is unit-testable without a network or a real model.
 *
 * `with`  = worktree at HEAD keeping `.prjct`, an isolated home seeded with the
 *           task's memories and explicit isolated hook settings.
 * `without` = worktree with `.prjct` removed, empty home, `prjct` shimmed to
 *           exit 127 and an empty explicit hook configuration.
 * Both arms: corpus removed, Read/Grep/Glob allowlist, no ambient settings or
 * MCP servers, stdin closed. With-arm rows require observed prompt hooks.
 */

import { detGrade, llmGrade } from './ab-grader'
import type { AbRow } from './ab-report'
import type { AbTask } from './ab-tasks'

export const READONLY_CONSTRAINT =
  'Constraints: use only the Read, Grep and Glob tools. Do not run shell commands and do not ' +
  'edit files. Keep the final answer under 200 words and use exactly the requested reply format.'

export interface StreamSummary {
  apiCalls: number
  firstCallContext: number | null
  peakContext: number | null
  sumContext: number | null
  toolCalls: number
  toolNames: string[]
  result: Record<string, unknown> | null
}

/** Parse `claude --output-format stream-json` output (mirrors the Python parser). */
export function parseStream(text: string): StreamSummary {
  const frames = text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('{'))
    .map((l) => {
      try {
        return JSON.parse(l) as Record<string, unknown>
      } catch {
        return null
      }
    })
    .filter((d): d is Record<string, unknown> => d !== null)
  const assistant = frames.filter((d) => d.type === 'assistant')
  const contexts = assistant.map((d) => {
    const message = (d.message ?? {}) as Record<string, unknown>
    const usage = (message.usage ?? {}) as Record<string, number>
    return (
      (usage.input_tokens ?? 0) +
      (usage.cache_creation_input_tokens ?? 0) +
      (usage.cache_read_input_tokens ?? 0)
    )
  })
  const toolNames = assistant.flatMap((d) => {
    const message = (d.message ?? {}) as Record<string, unknown>
    return ((message.content ?? []) as Array<Record<string, unknown>>)
      .filter((c) => c.type === 'tool_use')
      .map((c) => String(c.name))
  })
  const result = frames.filter((d) => d.type === 'result').at(-1) ?? null
  return {
    apiCalls: contexts.length,
    firstCallContext: contexts[0] ?? null,
    peakContext: contexts.length ? Math.max(...contexts) : null,
    sumContext: contexts.reduce((a, b) => a + b, 0),
    toolCalls: toolNames.length,
    toolNames,
    result,
  }
}

export interface RunContext {
  model: string
  task: AbTask
  arm: 'with' | 'without'
  rep: number
  head: string
  /** Absolute path to the worktree the agent runs in. */
  worktree: string
  /** Isolated PRJCT_CLI_HOME for this run. */
  home: string
}

/** Injected side effects — real implementations spawn processes; tests stub them. */
export interface AbRunnerDeps {
  /** Resolve HEAD sha of the repo under test. */
  head(): Promise<string>
  /** Create an isolated worktree + home for a run; returns their paths. */
  setup(ctx: Omit<RunContext, 'worktree' | 'home' | 'head'> & { head: string }): Promise<{
    worktree: string
    home: string
  }>
  /** Run the agent under test; returns raw stream-json stdout + wall time. */
  runAgent(
    ctx: RunContext,
    prompt: string,
    budgetUsd: number
  ): Promise<{ stdout: string; wallMs: number; rc: number }>
  /** Run the independent grader (`claude -p --json-schema`). */
  runGrader(prompt: string, jsonSchema: string): Promise<string>
  /** Tear down the worktree + home for a run. */
  teardown(ctx: RunContext): Promise<void>
  /** Append a finished row to the results sink. */
  writeRow(row: AbRow): Promise<void>
}

export interface RunAbOptions {
  models: string[]
  tasks: AbTask[]
  reps: number
  graderModel?: string
  budgetUsd?: (model: string) => number
}

const DEFAULT_BUDGET: Record<string, number> = { haiku: 1.0, sonnet: 2.0, opus: 4.0 }

/** Alternate arm order per rep so a slow-warm cache can't bias one arm. */
export function armOrder(rep: number): Array<'with' | 'without'> {
  return rep % 2 === 1 ? ['with', 'without'] : ['without', 'with']
}

/** Run one (model, task, arm, rep) cell end to end and return its row. */
export async function runCell(
  base: Omit<RunContext, 'worktree' | 'home'>,
  task: AbTask,
  deps: AbRunnerDeps,
  graderModel: string,
  budgetUsd: number
): Promise<AbRow> {
  const { worktree, home } = await deps.setup(base)
  const ctx: RunContext = { ...base, worktree, home }
  try {
    const prompt = `${task.prompt}\n\n${READONLY_CONSTRAINT}`
    const { stdout, wallMs, rc } = await deps.runAgent(ctx, prompt, budgetUsd)
    const parsed = parseStream(stdout)
    const result = parsed.result ?? {}
    const usage = (result.usage ?? {}) as Record<string, number>
    const answer = typeof result.result === 'string' ? result.result : ''
    const det = detGrade(task.det, answer)
    const llm = await llmGrade(task, answer, (p, schema) => deps.runGrader(p, schema))
    const graderModelUsed = graderModel
    const row: AbRow = {
      model: base.model,
      task: task.id,
      taskClass: task.taskClass,
      arm: base.arm,
      rep: base.rep,
      head: base.head,
      rc,
      wall_ms: wallMs,
      duration_ms: typeof result.duration_ms === 'number' ? result.duration_ms : null,
      cost_usd: typeof result.total_cost_usd === 'number' ? result.total_cost_usd : null,
      input_tokens: usage.input_tokens ?? null,
      output_tokens: usage.output_tokens ?? null,
      sum_context: parsed.sumContext,
      peak_context: parsed.peakContext,
      tool_calls: parsed.toolCalls,
      denials: Array.isArray(result.permission_denials) ? result.permission_denials.length : 0,
      is_error: result.is_error === true,
      answer,
      det,
      llm: { verdict: llm.verdict, reason: llm.reason, cost: llm.cost },
      grader_model: graderModelUsed,
    }
    await deps.writeRow(row)
    return row
  } finally {
    await deps.teardown(ctx)
  }
}

/** Full sweep: every model × task × rep, both arms, alternating order. */
export async function runAb(opts: RunAbOptions, deps: AbRunnerDeps): Promise<AbRow[]> {
  const head = await deps.head()
  const graderModel = opts.graderModel ?? 'sonnet'
  const budgetFor = opts.budgetUsd ?? ((m: string) => DEFAULT_BUDGET[m] ?? 3.0)
  const rows: AbRow[] = []
  for (const model of opts.models) {
    for (const task of opts.tasks) {
      for (const rep of Array.from({ length: opts.reps }, (_, i) => i + 1)) {
        for (const arm of armOrder(rep)) {
          const row = await runCell(
            { model, task: task, arm, rep, head },
            task,
            deps,
            graderModel,
            budgetFor(model)
          )
          rows.push(row)
        }
      }
    }
  }
  return rows
}
