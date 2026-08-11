/**
 * Serialized request lanes for the daemon.
 *
 * Commands patch the GLOBAL console.log/error to capture output, so they
 * must never run concurrently with each other. Hooks use HookIo (not console
 * capture) and are the latency-critical path for Claude Code — a long
 * `prjct sync` must not head-of-line-block Prompt/Stop.
 *
 * Three lanes:
 *   - command: exclusive, one-at-a-time
 *   - hook-state: exclusive prompt/stop ordering, independent of commands
 *   - hook: latency-critical read-mostly hooks, bounded to 4 concurrent jobs
 *
 * SQLite remains single-writer at the C boundary (better-sqlite3 is sync);
 * interleaving at await points already happens across MCP processes (see
 * concurrent-MCP gotcha). Hook afterEmit is detached, so the hook lane stays
 * short.
 */

export type LaneName = 'command' | 'hook-state' | 'hook'

const MAX_CONCURRENT_HOOKS = 4

export class RequestLanes {
  private commandChain: Promise<unknown> = Promise.resolve()
  private hookStateChain: Promise<unknown> = Promise.resolve()
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

  run<T>(lane: LaneName, work: () => Promise<T>): Promise<T> {
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

    const chain = lane === 'hook-state' ? this.hookStateChain : this.commandChain
    const run = chain.then(work, work)
    const settled = run.then(
      () => undefined,
      () => undefined
    )
    if (lane === 'hook-state') this.hookStateChain = settled
    else this.commandChain = settled
    return run
  }
}

export const daemonRequestLanes = new RequestLanes()
