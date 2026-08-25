/**
 * Global test isolation preload (wired via `bunfig.toml` → [test].preload).
 *
 * Resets module-level singletons that leak across test files in a single
 * process. The worst offender is the circuit-breaker registry in
 * `core/utils/retry.ts`: shared across every RetryPolicy, so once
 * `agent-initialization` fails enough times in one suite the breaker opens and
 * every later test fails fast with "circuit breaker is open" — a cascade
 * unrelated to the code under test. Clearing it before each test makes the
 * suite order-independent.
 *
 * (The HOME / PRJCT_CLI_HOME / PRJCT_TEST_MODE sandbox lives in the FIRST
 * preload, `isolate-cli-home.ts`, so it is in effect before any prjct module
 * import — including the imports this file pulls in.)
 */

import { beforeEach } from 'bun:test'
import { resetCircuitBreakers } from '../../utils/retry'

// Deterministic agent detection for the whole test process. agentDetector
// falls back to `terminal` when it can't prove a Claude environment (env, MCP,
// a CLAUDE.md in cwd, or ~/.claude in HOME); on a CI runner none hold, so init
// would fail with "Unsupported agent type: terminal". Pinning the env makes
// detection deterministic everywhere, exactly as if running under Claude.
process.env.CLAUDE_AGENT = '1'

// Reset the module-level circuit-breaker registry before every test so one
// suite's failures can't open the shared breaker and cascade into later tests.
beforeEach(() => {
  resetCircuitBreakers()
})
