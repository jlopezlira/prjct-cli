/**
 * Global test isolation — FIRST preload (mem_1560 + the ~/.kimi-code/mcp.json
 * incident class, mem_19026).
 *
 * Runs before ANY prjct module import, so every module-level capture
 * (`const HOME = resolveUserHome()`, pathManager's home) resolves inside the
 * sandbox instead of the developer's real home. Three guards, each honoring an
 * explicit override (e.g. a CI sandbox) so the override wins:
 *
 *  1. PRJCT_TEST_MODE — the one flag all foreign-config writers
 *     (kimi/codex/grok/cursor/gemini/opencode mcp+hooks, mcp-config, secure-key,
 *     skill generators) honor to divert their DEFAULT destination to a
 *     temp/no-op path. Needed because those writers resolve via os.homedir(),
 *     which Bun freezes to the launch HOME and so ignores guard #2.
 *  2. HOME/USERPROFILE — sandboxes every resolveUserHome()-based path
 *     (`~/.claude/CLAUDE.md`, agent configs, the `~/.prjct-cli` fallback).
 *  3. PRJCT_CLI_HOME — points pathManager (resolved at import time) at a
 *     throwaway dir so nothing writes into the real ~/.prjct-cli.
 *
 * The companion preload `assert-real-home-untouched.ts` turns any remaining
 * hole (a writer still on raw os.homedir()) into a loud non-zero exit — the
 * incident class as a red test, not silent corruption.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.PRJCT_TEST_MODE ??= '1'

if (!process.env.PRJCT_TEST_HOME) {
  const homeSandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'prjct-test-home-'))
  process.env.PRJCT_TEST_HOME = homeSandbox
  process.env.HOME = homeSandbox
  process.env.USERPROFILE = homeSandbox
  const cleanupHome = () => {
    try {
      fs.rmSync(homeSandbox, { recursive: true, force: true })
    } catch {
      /* best-effort */
    }
  }
  process.on('exit', cleanupHome)
  process.on('SIGINT', () => {
    cleanupHome()
    process.exit(130)
  })
}

if (!process.env.PRJCT_CLI_HOME) {
  process.env.PRJCT_CLI_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'prjct-test-cli-home-'))
}
