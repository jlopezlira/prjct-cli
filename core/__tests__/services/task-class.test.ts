/**
 * Turn classifier: a labeled corpus (≥40 prompts spanning the classes) must be
 * classified with ≥90% accuracy, in well under the 5ms/turn budget, and with
 * UNKNOWN never silenced by construction.
 */

import { describe, expect, it } from 'bun:test'
import { classifyTurn, type TaskClass } from '../../services/task-class'

type Label = TaskClass | 'UNKNOWN'
const CASES: Array<{ prompt: string; expect: Label }> = [
  // SELF_CONTAINED — names a file/symbol, no cross-file spread.
  { prompt: 'In core/hooks/prompt.ts what is STATE_BUDGET?', expect: 'SELF_CONTAINED' },
  { prompt: 'Fix the typo in core/utils/output.ts line 42', expect: 'SELF_CONTAINED' },
  {
    prompt: 'What does resolveProjectPath return in core/mcp/resolve.ts?',
    expect: 'SELF_CONTAINED',
  },
  { prompt: 'Add a comment to core/domain/bm25.ts explaining BM25_K1', expect: 'SELF_CONTAINED' },
  { prompt: 'Show the default weights in core/domain/file-ranker.ts', expect: 'SELF_CONTAINED' },
  { prompt: 'Read scripts/build.js and summarize deriveShimSkipSet', expect: 'SELF_CONTAINED' },
  { prompt: 'Update the version string in package.json', expect: 'SELF_CONTAINED' },
  {
    prompt: 'Rename the local var in core/agent/paths.ts resolveSafePath',
    expect: 'SELF_CONTAINED',
  },

  // PROJECT_KNOWLEDGE — decision / why / where-should.
  { prompt: 'Why did we move config out of the client repo?', expect: 'PROJECT_KNOWLEDGE' },
  {
    prompt: 'Where should a new mutable per-project setting be persisted?',
    expect: 'PROJECT_KNOWLEDGE',
  },
  { prompt: 'Which approach did we pick for daemon auth and why?', expect: 'PROJECT_KNOWLEDGE' },
  { prompt: 'What is the rationale for the micro MCP tier?', expect: 'PROJECT_KNOWLEDGE' },
  { prompt: 'Should we store review.maxRounds in the locator?', expect: 'PROJECT_KNOWLEDGE' },
  { prompt: 'What is the convention for hook budget bails here?', expect: 'PROJECT_KNOWLEDGE' },
  { prompt: 'Por qué usamos un token para autenticar el daemon?', expect: 'PROJECT_KNOWLEDGE' },
  { prompt: 'Do we use realpath jails or lexical checks, and why?', expect: 'PROJECT_KNOWLEDGE' },

  // EXPLORATION — cross-file / find-where / refactor.
  { prompt: 'Where are all the callers of evaluateWorkflowRuleExecutable?', expect: 'EXPLORATION' },
  { prompt: 'Find every place that reads PRJCT_CLI_HOME', expect: 'EXPLORATION' },
  { prompt: 'Trace how a hook request flows through the daemon', expect: 'EXPLORATION' },
  { prompt: 'Refactor the gate delivery calls across the codebase', expect: 'EXPLORATION' },
  { prompt: 'What calls buildRealtimeUrl anywhere in the repo?', expect: 'EXPLORATION' },
  { prompt: 'Find where the secret scanner is invoked', expect: 'EXPLORATION' },
  { prompt: 'How does the stop hook capture learnings across files?', expect: 'EXPLORATION' },
  { prompt: 'Rename sessionId to conversationId everywhere', expect: 'EXPLORATION' },

  // VERIFY — implement/fix with tests, make-pass, reproduce.
  { prompt: 'Make the failing test in prompt.test.ts pass', expect: 'VERIFY' },
  { prompt: 'Fix the failing CI build', expect: 'VERIFY' },
  { prompt: 'The tests are failing on another machine — reproduce the bug', expect: 'VERIFY' },
  { prompt: 'Get the gauntlet green again', expect: 'VERIFY' },
  { prompt: 'Why is qa-probes.test.ts failing and fix it', expect: 'VERIFY' },
  { prompt: 'Implement retry and write a test that proves it', expect: 'VERIFY' },
  { prompt: 'Turn the red suite green', expect: 'VERIFY' },
  { prompt: 'Reproduce the crash then fix the root cause', expect: 'VERIFY' },

  // UNKNOWN — no strong signal. Prose slashes are NOT paths (they must never
  // silence the harness): and/or, A/B, with/without.
  { prompt: 'Thanks, that looks good', expect: 'UNKNOWN' },
  { prompt: 'add tests and/or docs for the parser', expect: 'UNKNOWN' },
  { prompt: 'compare the A/B numbers with/without the harness', expect: 'UNKNOWN' },
  { prompt: 'Let us continue with the plan', expect: 'UNKNOWN' },
  { prompt: 'Summarize what we did today', expect: 'UNKNOWN' },
  { prompt: 'Good morning', expect: 'UNKNOWN' },
  { prompt: 'Keep going', expect: 'UNKNOWN' },

  // Priority checks: verify wins over a named path; decision wins over a path.
  { prompt: 'Make core/hooks/prompt.test.ts pass', expect: 'VERIFY' },
  {
    prompt: 'Why is STATE_BUDGET in core/hooks/prompt.ts set to 700?',
    expect: 'PROJECT_KNOWLEDGE',
  },
  {
    prompt: 'Find all callers of resolveProjectPath in core/mcp/resolve.ts',
    expect: 'EXPLORATION',
  },
]

describe('classifyTurn', () => {
  it('classifies the labeled corpus with ≥90% accuracy', () => {
    const wrong = CASES.filter((c) => classifyTurn(c.prompt).cls !== c.expect)
    const accuracy = (CASES.length - wrong.length) / CASES.length
    if (accuracy < 0.9) {
      throw new Error(
        `accuracy ${accuracy.toFixed(2)} < 0.90. Misses:\n` +
          wrong.map((c) => `  [${c.expect} → ${classifyTurn(c.prompt).cls}] ${c.prompt}`).join('\n')
      )
    }
    expect(accuracy).toBeGreaterThanOrEqual(0.9)
  })

  it('stays well under the 5ms/turn budget', () => {
    const started = performance.now()
    const rounds = 200
    for (const _ of Array.from({ length: rounds })) for (const c of CASES) classifyTurn(c.prompt)
    const perCall = (performance.now() - started) / (rounds * CASES.length)
    expect(perCall).toBeLessThan(5)
  })

  it('uses an injected symbol probe to sharpen SELF_CONTAINED', () => {
    const out = classifyTurn('inspect evaluateWorkflowRuleExecutable behaviour', {
      hasSymbol: (t) => t === 'evaluateWorkflowRuleExecutable',
    })
    expect(out.cls).toBe('SELF_CONTAINED')
    expect(out.signals).toContain('symbols:1')
  })

  it('never returns SELF_CONTAINED silence for an empty or vague prompt', () => {
    expect(classifyTurn('').cls).toBe('UNKNOWN')
    expect(classifyTurn('   ').cls).toBe('UNKNOWN')
  })
})
