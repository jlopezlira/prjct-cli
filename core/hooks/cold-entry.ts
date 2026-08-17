#!/usr/bin/env node
/**
 * Dedicated COLD hook entry — the in-process path a freshly-spawned `prjct
 * hook <event>` takes when the daemon is unreachable or disabled
 * (PRJCT_NO_DAEMON=1).
 *
 * WHY THIS FILE EXISTS (perf):
 *   The daemon shim (scripts/build.js `generateDaemonShim`) used to fall back
 *   to `import("./prjct-core.mjs")` for cold hooks — the FULL ~936KB CLI
 *   bundle (every command, the MCP server, sync, wiki, analysis…), just to run
 *   one hook whose real dependency closure is ~136KB. Parsing the extra ~800KB
 *   on every cold hook is the dominant cost the hot-path benchmark measures
 *   (scripts/bench-hooks.mjs; see mem_360 — spawn + module-load dominated, not
 *   hook logic). esbuild bundles THIS entry on its own into
 *   `dist/bin/prjct-hooks.mjs`, so the cold path parses only the hook closure.
 *
 * CONTRACT:
 *   - emit the hook's JSON line to stdout immediately (host-visible response)
 *   - afterEmit side-effects (transcript ingest, vault regen, patterns) run in
 *     a DETACHED child (`PRJCT_HOOK_AFTER_EMIT=1`) so Stop/SessionStart no longer
 *     block the host on cold path for 1–2s. The child re-runs the same hook with
 *     a noop sink and awaits afterEmit — work is preserved, response is fast.
 *   - fail-soft: any throw degrades to `{}` + exit 0; a hook must never disturb
 *     the host session.
 *
 * The warm daemon path (core/daemon/daemon.ts handleHookRequest) and the
 * dev/source path (`bun bin/prjct.ts hook`) are unchanged.
 */

import { spawn } from 'node:child_process'
import { readStdinRaw } from './_shared'
import { getHookRunner } from './registry'
import { consumeHookStdinSpill } from './stdin-spill'

/** Env flag: this process only exists to finish afterEmit (parent already responded). */
const AFTER_EMIT_ENV = 'PRJCT_HOOK_AFTER_EMIT'

/**
 * Sync-read stdin (the hook event JSON) within `timeoutMs`. Thin raw-string
 * wrapper around `_shared.ts`'s `readStdinRaw` — see that function for the
 * fd/EAGAIN/Atomics.wait rationale. Mirrors bin/prjct.ts `readStdinSync`.
 *
 * When a previous chain stage (native hook-fast or the daemon shim) already
 * consumed stdin and punted, the payload waits in the run-dir spill file —
 * take it from there instead of the drained pipe (see stdin-spill.ts).
 */
function readStdinSync(timeoutMs: number, subcommand?: string): string {
  const spilled = subcommand ? consumeHookStdinSpill(process.cwd(), subcommand) : null
  if (spilled !== null) return spilled
  return readStdinRaw(timeoutMs).toString('utf-8')
}

/**
 * Re-invoke this entry as a detached worker that only runs afterEmit.
 * Parent exits as soon as the host-visible JSON is written.
 * @returns true when a worker was spawned successfully.
 */
function trySpawnAfterEmitWorker(subcommand: string | undefined, stdinPayload: string): boolean {
  const entry = process.argv[1]
  if (!entry || !subcommand) return false
  try {
    const child = spawn(process.execPath, [entry, 'hook', subcommand], {
      detached: true,
      stdio: ['pipe', 'ignore', 'ignore'],
      cwd: process.cwd(),
      env: {
        ...process.env,
        [AFTER_EMIT_ENV]: '1',
        // Worker must not try the daemon — it only finishes local afterEmit.
        PRJCT_NO_DAEMON: '1',
      },
      shell: false,
    })
    child.stdin?.write(stdinPayload)
    child.stdin?.end()
    child.unref()
    return true
  } catch {
    return false
  }
}

async function main(): Promise<void> {
  // argv after the runtime + script: ["hook", "<subcommand>", ...].
  const args = process.argv.slice(2)
  const subcommand = args[1]
  const isAfterEmitWorker = process.env[AFTER_EMIT_ENV] === '1'
  try {
    const runner = getHookRunner(subcommand)
    if (!runner) {
      if (!isAfterEmitWorker) process.stdout.write('{}\n')
      process.exit(0)
    }
    const stdinPayload = readStdinSync(1000, subcommand)
    const input = (() => {
      try {
        return stdinPayload ? (JSON.parse(stdinPayload) as unknown) : {}
      } catch {
        return {}
      }
    })()
    const pending: Array<() => Promise<void>> = []
    await runner(process.cwd(), {
      afterEmitOnly: isAfterEmitWorker,
      input,
      sink: (chunk: string) => {
        // Worker: parent already answered the host — never write again.
        if (!isAfterEmitWorker) process.stdout.write(chunk)
      },
      detachAfterEmit: (fn: () => Promise<void>) => {
        pending.push(fn)
      },
    })

    if (isAfterEmitWorker) {
      // This process exists solely to finish afterEmit.
      for (const fn of pending) await fn().catch(() => undefined)
      process.exit(0)
    }

    // Parent: response already on stdout. Detach afterEmit so Stop (~1–2s of
    // transcript/pattern work) does not block host process exit. If the
    // spawn fails, fall back to in-process await so work is not lost.
    if (pending.length > 0) {
      if (process.env.PRJCT_HOOK_BENCH === '1') process.exit(0)
      const detached = trySpawnAfterEmitWorker(subcommand, stdinPayload)
      if (!detached) {
        for (const fn2 of pending) await fn2().catch(() => undefined)
      }
    }
    process.exit(0)
  } catch {
    if (!isAfterEmitWorker) process.stdout.write('{}\n')
    process.exit(0)
  }
}

void main()
