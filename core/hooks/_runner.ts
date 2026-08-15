/**
 * Hook lifecycle runner. Replaces the boilerplate quartet
 * `safeRun + readStdinSafe + buildHookOutput + emit` that every hook
 * entry-point used to repeat verbatim.
 *
 * A hook now declares only what makes IT distinctive:
 *   - the Claude Code event name (so the output schema is correct)
 *   - an optional `build` that produces the additionalContext / null
 *   - an optional `afterEmit` for side-effects that must not block the
 *     host (DB writes, vault regen, self-heal, etc.)
 *
 * The runner guarantees:
 *   1. Never throws past the harness — `safeRun` swallows all errors.
 *   2. stdin is read with the standard 200ms timeout.
 *   3. Output is JSON-validated against the event's schema by
 *      `buildHookOutput` (e.g. SessionStart accepts hookSpecificOutput,
 *      Stop only accepts systemMessage).
 *   4. After-effects run AFTER `emit` (never before the host-visible line).
 *
 * Two execution modes share ALL of the above:
 *   - Process mode (`io` omitted): tests + direct callers — reads
 *     `process.stdin`, writes `process.stdout`, awaits `afterEmit` so work is
 *     not lost when the process is about to exit. Production cold path uses
 *     HookIo via `cold-entry` (detached afterEmit worker) instead.
 *   - Daemon / HookIo mode (`io` supplied): warm path or cold-entry bridge —
 *     input pre-parsed, output to a sink, and `afterEmit` is DETACHED via
 *     `detachAfterEmit` so it never blocks the host response. Same build +
 *     same fail-soft contract.
 */

import {
  adaptHookOutputForHost,
  buildDenyOutput,
  buildHookOutput,
  emit,
  readStdinSafe,
  safeRun,
} from './_shared'

export interface RunHookOptions<I> {
  /** Claude Code event name (SessionStart, UserPromptSubmit, etc.). */
  event: string
  /** Project path; defaults to process.cwd(). */
  projectPath?: string
  /** Optional HARD decision, evaluated BEFORE `build`. Return `{deny}` to emit
   *  a PreToolUse deny decision (blocks the tool call on hosts that honor it)
   *  and skip the context build; return null to fall through to `build`. Used
   *  by the loop guard. Fail-soft like everything else (a throw ⇒ `{}`). */
  decide?: (input: I, projectPath: string) => Promise<{ deny: string } | null>
  /** Build the additionalContext / systemMessage body. Return null to
   *  inject nothing (the runner emits `{}` instead). Omit for hooks
   *  that are purely side-effect driven. */
  build?: (input: I, projectPath: string) => Promise<string | null>
  /** Optional side-effects that run AFTER emit. The runner already
   *  swallows errors thrown here via safeRun; explicit try/catch is
   *  only needed when you want to keep going after a sub-step fails. */
  afterEmit?: (input: I, projectPath: string) => Promise<void>
}

/**
 * Daemon-mode I/O bridge. When present, the hook runs warm inside the
 * daemon instead of cold in a freshly-spawned process.
 */
export interface HookIo {
  /** Detached cold worker: run only side-effects; parent already built/emitted. */
  afterEmitOnly?: boolean
  /** The hook event payload, already parsed from the wire request. */
  input: unknown
  /** Receives the exact bytes the process path would write to stdout
   *  (a JSON line terminated by `\n`). The daemon returns this verbatim
   *  to the client, which writes it raw — byte-identical to the cold path. */
  sink: (chunk: string) => void
  /** Schedule `afterEmit` to run WITHOUT blocking the response or the
   *  daemon's request chain (typically `setImmediate` + error swallow). */
  detachAfterEmit: (fn: () => Promise<void>) => void
}

export async function runHook<I = Record<string, unknown>>(
  opts: RunHookOptions<I>,
  io?: HookIo
): Promise<void> {
  const projectPath = opts.projectPath ?? process.cwd()
  if (io) {
    // Daemon (warm) path. Mirror the process path's fail-soft contract:
    // any throw becomes the empty no-op `{}` so a broken hook can never
    // disturb the host session.
    try {
      const input = io.input as I
      if (io.afterEmitOnly) {
        if (opts.afterEmit) io.detachAfterEmit(() => opts.afterEmit!(input, projectPath))
        return
      }
      const decision = opts.decide ? await opts.decide(input, projectPath) : null
      if (decision) {
        const payload = adaptHookOutputForHost(buildDenyOutput(opts.event, decision.deny))
        io.sink(`${JSON.stringify(payload)}\n`)
        return
      }
      const context = opts.build ? await opts.build(input, projectPath) : null
      const payload = adaptHookOutputForHost(buildHookOutput(opts.event, context))
      io.sink(`${JSON.stringify(payload)}\n`)
      if (opts.afterEmit) io.detachAfterEmit(() => opts.afterEmit!(input, projectPath))
    } catch {
      io.sink('{}\n')
    }
    return
  }

  // Process (cold) path — unchanged.
  await safeRun(async () => {
    const input = readStdinSafe<I>()
    const decision = opts.decide ? await opts.decide(input, projectPath) : null
    if (decision) {
      emit(buildDenyOutput(opts.event, decision.deny))
      return
    }
    const context = opts.build ? await opts.build(input, projectPath) : null
    emit(buildHookOutput(opts.event, context))
    if (opts.afterEmit) await opts.afterEmit(input, projectPath)
  })
}
