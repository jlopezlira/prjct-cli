/**
 * A/B graders: a deterministic regex/substring grader (the release-gate signal,
 * cheap and reproducible) and an independent LLM grader (tiebreak). Disagreement
 * between the two is surfaced, never silently resolved — the spec's "desacuerdos
 * visibles" requirement.
 */

import type { AbTask, DetClause, DetSpec } from './ab-tasks'

export interface DetResult {
  parts: Record<string, boolean>
  correct: boolean
}

export type LlmVerdict = 'correct' | 'partial' | 'wrong' | 'unparsed' | 'error'

export interface LlmResult {
  verdict: LlmVerdict
  reason: string
  cost: number | null
}

/** Runs a `claude -p` grader; injected so the graders are unit-testable. */
export type ClaudeGraderRunner = (prompt: string, jsonSchema: string) => Promise<string>

function clauseMatches(clause: DetClause, answerLower: string, answerRaw: string): boolean {
  if (clause.all && !clause.all.every((n) => answerLower.includes(n.toLowerCase()))) return false
  if (clause.any && !clause.any.some((n) => answerLower.includes(n.toLowerCase()))) return false
  if (clause.regex && !new RegExp(clause.regex, 'i').test(answerRaw)) return false
  return true
}

/** Deterministic grade: every part must have at least one passing clause. */
export function detGrade(det: DetSpec, answer: string): DetResult {
  const raw = answer ?? ''
  const lower = raw.toLowerCase()
  const parts: Record<string, boolean> = {}
  for (const part of det.parts) {
    parts[part.name] = part.clauses.some((c) => clauseMatches(c, lower, raw))
  }
  return { parts, correct: Object.values(parts).every(Boolean) }
}

export const LLM_GRADER_SCHEMA = JSON.stringify({
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['correct', 'partial', 'wrong'] },
    reason: { type: 'string' },
  },
  required: ['verdict', 'reason'],
})

export function buildGraderPrompt(gold: string, answer: string): string {
  return (
    'You are an independent grader. Do not use any tools. Compare the ANSWER to the hidden ' +
    'GOLD reference and return JSON only. verdict must be one of: correct (all key facts present ' +
    'and no contradicting claim), partial (some key facts), wrong.\n\nGOLD:\n' +
    gold +
    '\n\nANSWER:\n' +
    (answer || '(empty)')
  )
}

/** Parse the grader's `claude -p --output-format json` stdout into a verdict. */
export function parseGraderOutput(stdout: string): LlmResult {
  const lastLine = stdout.trim().split('\n').filter(Boolean).at(-1)
  if (!lastLine) return { verdict: 'error', reason: 'empty grader output', cost: null }
  const outer = (() => {
    try {
      return JSON.parse(lastLine) as Record<string, unknown>
    } catch {
      return null
    }
  })()
  if (!outer) return { verdict: 'error', reason: 'grader output not JSON', cost: null }
  const cost = typeof outer.total_cost_usd === 'number' ? outer.total_cost_usd : null
  const structured = outer.structured_output as
    | { verdict?: LlmVerdict; reason?: string }
    | undefined
  if (structured && typeof structured.verdict === 'string') {
    return { verdict: structured.verdict, reason: structured.reason ?? '', cost }
  }
  const text = String(outer.result ?? '')
  const m = /"verdict"\s*:\s*"(correct|partial|wrong)"/.exec(text)
  return { verdict: (m?.[1] as LlmVerdict) ?? 'unparsed', reason: text.slice(0, 300), cost }
}

export async function llmGrade(
  task: AbTask,
  answer: string,
  run: ClaudeGraderRunner
): Promise<LlmResult> {
  try {
    const stdout = await run(buildGraderPrompt(task.gold, answer), LLM_GRADER_SCHEMA)
    return parseGraderOutput(stdout)
  } catch (error) {
    return { verdict: 'error', reason: String(error).slice(0, 300), cost: null }
  }
}

/**
 * The two graders disagree when both produced a definite verdict and they
 * point opposite ways (det correct vs llm not-correct, or vice versa).
 * `unparsed`/`error` LLM verdicts are not definite, so they never count as a
 * disagreement — only as a reason to trust the deterministic signal.
 */
export function gradersDisagree(det: DetResult, llm: LlmResult): boolean {
  if (llm.verdict !== 'correct' && llm.verdict !== 'partial' && llm.verdict !== 'wrong') {
    return false
  }
  const llmCorrect = llm.verdict === 'correct'
  return det.correct !== llmCorrect
}
