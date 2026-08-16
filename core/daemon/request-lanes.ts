/**
 * Serialized request lanes for the daemon.
 *
 * Commands patch the GLOBAL console.log/error to capture output, so they
 * must never run concurrently with each other. Hooks use HookIo (not console
 * capture) and are the latency-critical path for Claude Code — a long
 * `prjct sync` must not head-of-line-block Prompt/Stop.
 *
 * Three lanes:
 *   - command: exclusive, one-at-a-time, across the WHOLE daemon (console
 *     patching is a process-global resource — this one must stay unpartitioned)
 *   - hook-state: exclusive prompt/stop ordering, PER cwd (see below)
 *   - hook: latency-critical read-mostly hooks, bounded to 4 concurrent jobs
 *
 * hook-state is partitioned by the request's cwd, not shared globally. Its
 * ordering requirement ("ensure this project's own turn-state writes land in
 * order") only holds within one project/worktree — state.json is per-project
 * and per-workspace (see deriveWorkspace/MAIN_WORKSPACE_ID). A single global
 * chain meant a slow buildProjectState (git fork, FTS query) in one project
 * head-of-line-blocked Stop/Prompt for an unrelated project sharing this
 * daemon, even though they touch zero common state. cwd is used directly
 * (not a resolved projectId) so partitioning costs no extra I/O — hooks from
 * the same cwd are always the same project/worktree in practice.
 */

export type LaneName = 'command' | 'hook-state' | 'hook'

const MAX_CONCURRENT_HOOKS = 4

// A slow buildProjectState (git fork + FTS query) ahead of you in this cwd's
// hook-state chain otherwise stacks its FULL duration onto your observed
// latency — the root cause of a real 4.4s hook:prompt tail-latency outlier
// (p50 15ms) measured in this project's own production telemetry, worst
// under exactly the kind of concurrent-agent burst this session generates.
// Comfortably under the client's 800ms HOOK_REQUEST_TIMEOUT_MS budget
// (core/daemon/protocol.ts) so the daemon can proactively hand back the
// existing `retry: true` signal — which the client already falls back on
// for a stale-daemon response — before the client's own raw socket timeout
// fires and the caller learns nothing more useful than "timed out".
const DEFAULT_HOOK_STATE_TIMEOUT_MS = 500

function hookStateTimeoutMs(): number {
  const raw = process.env.PRJCT_HOOK_STATE_TIMEOUT_MS
  const parsed = raw ? Number(raw) : Number.NaN
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_HOOK_STATE_TIMEOUT_MS
}

export class HookStateLaneTimeoutError extends Error {
  readonly timeoutMs: number
  constructor(timeoutMs: number) {
    super(
      `hook-state lane exceeded ${timeoutMs}ms waiting on this cwd's chain ` +
        '(a prior prompt/stop hook for the same project is still running). ' +
        'Set PRJCT_HOOK_STATE_TIMEOUT_MS to tune this bound.'
    )
    this.name = 'HookStateLaneTimeoutError'
    this.timeoutMs = timeoutMs
  }
}

/**
 * Bounds only what THIS caller waits for — never the underlying promise.
 * `run` keeps executing (and, for hook-state, keeps chaining) exactly as if
 * this wrapper weren't here; a caller that stops waiting cannot cancel or
 * reorder it. That's the invariant hook-state's per-cwd exclusivity depends
 * on: the NEXT queued call for this cwd must still wait for the REAL work to
 * settle, not for whichever caller gave up first.
 */
function raceWithTimeout<T>(run: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new HookStateLaneTimeoutError(timeoutMs)), timeoutMs)
    run.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      }
    )
  })
}

/** Safety bound, mirrors prompt.ts's gitSnapshotCache — a runaway number of
 *  distinct cwds must not grow this map forever. Entries are resolved-promise
 *  refs used only to sequence the NEXT call for that key, so clearing loses
 *  no in-flight work (in-flight `run` promises don't live in the map). */
const MAX_HOOK_STATE_CHAINS = 64

export class RequestLanes {
  private commandChain: Promise<unknown> = Promise.resolve()
  private readonly hookStateChains = new Map<string, Promise<unknown>>()
  private activeHooks = 0
  private readonly hookWaiters: Array<() => void> = []

  private async acquireHookSlot(): Promise<void> {
    if (this.activeHooks < MAX_CONCURRENT_HOOKS) {
      this.activeHooks++
      return
    }
    await new Promise<void>((resolve) => this.hookWaiters.push(resolve))
    this.activeHooks++
  }

  private releaseHookSlot(): void {
    this.activeHooks--
    this.hookWaiters.shift()?.()
  }

  /** `key` partitions the `hook-state` lane (pass the request's cwd); ignored
   *  for `command`/`hook`. */
  run<T>(lane: LaneName, work: () => Promise<T>, key?: string): Promise<T> {
    if (lane === 'hook') {
      return (async () => {
        await this.acquireHookSlot()
        try {
          return await work()
        } finally {
          this.releaseHookSlot()
        }
      })()
    }

    if (lane === 'hook-state') {
      const chainKey = key ?? ''
      const chain = this.hookStateChains.get(chainKey) ?? Promise.resolve()
      const run = chain.then(work, work)
      const settled = run.then(
        () => undefined,
        () => undefined
      )
      if (this.hookStateChains.size > MAX_HOOK_STATE_CHAINS) this.hookStateChains.clear()
      this.hookStateChains.set(chainKey, settled)
      // `settled` above is already wired to the real `run` regardless of
      // what the caller does next — bounding the caller's wait here cannot
      // let a request queued behind this one start early.
      return raceWithTimeout(run, hookStateTimeoutMs())
    }

    const run = this.commandChain.then(work, work)
    const settled = run.then(
      () => undefined,
      () => undefined
    )
    this.commandChain = settled
    return run
  }
}

export const daemonRequestLanes = new RequestLanes()
