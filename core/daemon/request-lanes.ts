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
      return run
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
