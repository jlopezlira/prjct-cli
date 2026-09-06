/**
 * PreToolUse credential guard — security MUST.
 *
 * Scans tool arguments (Bash command, Edit/Write contents, Gemini
 * run_shell_command / write_file args, …) for secret material before the
 * tool runs. On a hit: DENY the tool call so credentials never leave the
 * machine via curl, git commit, file write, or similar.
 *
 * Trust decision lives in `trust-boundary` (single enforcement place).
 *
 * Design constraints (from multi-runtime reality):
 *  - No `$PPID` / host-only env. Gemini sanitizes hook env and will refuse
 *    to execute hooks that require vars it does not set ("required env
 *    var(s) not set: ${PPID}"). Security MUSTS must not depend on that.
 *  - Portable pure regex via `secret-scanner` (no FS / SQLite).
 *  - Fail-soft decide for read-like calls: a throw ⇒ allow (never brick the
 *    session on a bug). Write-like calls fail CLOSED: a scanner crash on a
 *    Write/Edit/Bash is a deny naming the failure, because a crashed scan is
 *    not a clean scan and those are the calls a credential leaves through.
 *  - Only PreToolUse with explicit `decide` may deny (harness contract).
 */

import { evaluateToolInputSecrets } from '../services/trust-boundary'
import { type HookIo, runHook } from './_runner'

export interface SecretHookInput {
  tool_name?: string
  tool_input?: unknown
  toolInput?: unknown
  command?: string
  content?: string
  [key: string]: unknown
}

export function decideSecrets(input: SecretHookInput): { deny: string } | null {
  const verdict = evaluateToolInputSecrets(input)
  if (verdict.allow) return null
  return { deny: verdict.denyMessage }
}

/** Tools that persist or transmit bytes — the calls a credential could leave through. */
const WRITE_LIKE_TOOL =
  /write|edit|patch|replace|create|bash|shell|command|exec|fetch|http|curl|upload|send|post/i

/**
 * A scanner crash is not evidence the input is clean. For a write-like call
 * the MUST stays a MUST: deny with the failure named, so the author sees a
 * scanner bug instead of a silent allow. Read-like calls cannot leak, so
 * they keep the fail-soft contract (never brick a session on a bug).
 */
export function decideOnScannerFailure(
  input: SecretHookInput,
  error: unknown
): { deny: string } | null {
  const tool = String(input.tool_name ?? '')
  if (!WRITE_LIKE_TOOL.test(tool)) return null
  const reason = error instanceof Error ? error.message : String(error)
  return {
    deny: [
      `prjct credential guard: the secret scanner failed on this ${tool} call (${reason}).`,
      'A scanner failure is not a clean scan, so the write is blocked instead of allowed blind.',
      'Retry with a smaller payload, or report the failure: `prjct capture "pre-secrets scanner failed"`.',
    ].join(' '),
  }
}

export function runPreSecretsHook(projectPath: string = process.cwd(), io?: HookIo): Promise<void> {
  return runHook<SecretHookInput>(
    {
      event: 'PreToolUse',
      projectPath,
      // decide only — no additionalContext noise when clean
      decide: async (input) => {
        try {
          return decideSecrets(input)
        } catch (error) {
          return decideOnScannerFailure(input, error)
        }
      },
    },
    io
  )
}

/** Pure export for unit tests. */
export const _internal = { decideSecrets, decideOnScannerFailure }
