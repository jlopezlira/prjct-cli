/**
 * Run a verification command as a blocking check. Extracted from the workflow
 * engine's `verify:` action so the same runner powers `prjct verify` and the
 * proof-carrying contract (verify-contract.ts). Uses `runProc` deliberately:
 * stdin is closed so `bun test` cannot hang in watch mode, the process tree is
 * killed on timeout, and overflow surfaces as infra rather than a silent crash.
 */

import { matchProc, runProc } from '../utils/exec'
import { detectProjectCommands } from '../utils/project-commands'

export interface VerifyRun {
  ok: boolean
  /** Exit code when the process exited; null on timeout/spawn/overflow. */
  exitCode: number | null
  detail: string
  durationMs: number
}

const DETAIL_TAIL = 4000

/** Resolve `auto` to the project's own test command, or null when none. */
export async function detectVerifyCommand(projectPath: string): Promise<string | null> {
  const { test } = await detectProjectCommands(projectPath)
  return test?.command ?? null
}

export async function runVerifyCommand(
  projectPath: string,
  command: string,
  opts: { timeoutMs?: number } = {}
): Promise<VerifyRun> {
  const shell = process.platform === 'win32' ? 'cmd.exe' : '/bin/sh'
  const shellArgs = process.platform === 'win32' ? ['/d', '/s', '/c', command] : ['-c', command]
  const result = await runProc(shell, shellArgs, {
    timeoutMs: opts.timeoutMs ?? 900_000,
    cwd: projectPath,
    env: { ...process.env },
    maxBuffer: 32 * 1024 * 1024,
  })
  const durationMs = matchProc(result, {
    ok: (r) => r.durationMs,
    exit: (r) => r.durationMs,
    timeout: (r) => r.durationMs,
    spawn: (r) => r.durationMs,
    overflow: (r) => r.durationMs,
  })
  if (result.ok) return { ok: true, exitCode: 0, detail: '', durationMs }
  const exitCode = result.kind === 'exit' ? result.code : null
  const detail = matchProc(result, {
    ok: () => '',
    exit: (r) => {
      const out = `${r.stderr}\n${r.stdout}`.trim()
      return out ? out.slice(-DETAIL_TAIL) : `exit ${r.code}`
    },
    timeout: (r) => `timed out after ${r.budgetMs}ms`,
    spawn: (r) => r.cause.message,
    overflow: (r) => `output exceeded ${r.maxBuffer} bytes`,
  })
  return { ok: false, exitCode, detail, durationMs }
}
