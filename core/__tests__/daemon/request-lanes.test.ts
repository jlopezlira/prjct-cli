import { afterEach, describe, expect, test } from 'bun:test'
import { HookStateLaneTimeoutError, RequestLanes } from '../../daemon/request-lanes'

const originalTimeout = process.env.PRJCT_HOOK_STATE_TIMEOUT_MS
afterEach(() => {
  if (originalTimeout === undefined) delete process.env.PRJCT_HOOK_STATE_TIMEOUT_MS
  else process.env.PRJCT_HOOK_STATE_TIMEOUT_MS = originalTimeout
})

describe('RequestLanes', () => {
  test('serializes work within the same lane', async () => {
    const lanes = new RequestLanes()
    const order: string[] = []
    const gate = Promise.withResolvers<void>()

    const first = lanes.run('command', async () => {
      order.push('first-start')
      await gate.promise
      order.push('first-end')
      return 1
    })
    const second = lanes.run('command', async () => {
      order.push('second')
      return 2
    })

    // Give the microtask queue a turn so first has started and second is queued.
    await Promise.resolve()
    expect(order).toEqual(['first-start'])

    gate.resolve()
    expect(await first).toBe(1)
    expect(await second).toBe(2)
    expect(order).toEqual(['first-start', 'first-end', 'second'])
  })

  test('hook lane does not wait for a long command', async () => {
    const lanes = new RequestLanes()
    const order: string[] = []
    const cmdGate = Promise.withResolvers<void>()

    const cmd = lanes.run('command', async () => {
      order.push('cmd-start')
      await cmdGate.promise
      order.push('cmd-end')
    })

    // Hook scheduled while command is mid-flight — must still run.
    const hook = lanes.run('hook', async () => {
      order.push('hook')
      return 'ok'
    })

    await Promise.resolve()
    // Hook may complete before we release the command.
    expect(await hook).toBe('ok')
    expect(order).toContain('hook')
    expect(order).toContain('cmd-start')
    expect(order).not.toContain('cmd-end')

    cmdGate.resolve()
    await cmd
    expect(order).toEqual(['cmd-start', 'hook', 'cmd-end'])
  })

  test('read-mostly hooks run concurrently up to the bounded limit', async () => {
    const lanes = new RequestLanes()
    const gate = Promise.withResolvers<void>()
    const started: number[] = []
    const jobs = Array.from({ length: 5 }, (_, index) =>
      lanes.run('hook', async () => {
        started.push(index)
        await gate.promise
      })
    )

    await Promise.resolve()
    await Promise.resolve()
    expect(started).toEqual([0, 1, 2, 3])

    gate.resolve()
    await Promise.all(jobs)
    expect(started).toEqual([0, 1, 2, 3, 4])
  })

  test('prompt/stop state hooks stay ordered without blocking read-mostly hooks', async () => {
    const lanes = new RequestLanes()
    const gate = Promise.withResolvers<void>()
    const order: string[] = []
    const first = lanes.run('hook-state', async () => {
      order.push('state-1-start')
      await gate.promise
      order.push('state-1-end')
    })
    const second = lanes.run('hook-state', async () => {
      order.push('state-2')
    })
    const readMostly = lanes.run('hook', async () => {
      order.push('read-mostly')
    })

    await readMostly
    expect(order).toEqual(['state-1-start', 'read-mostly'])
    gate.resolve()
    await Promise.all([first, second])
    expect(order).toEqual(['state-1-start', 'read-mostly', 'state-1-end', 'state-2'])
  })

  test('hook-state ordering is per key — different keys never block each other', async () => {
    const lanes = new RequestLanes()
    const gateA = Promise.withResolvers<void>()
    const order: string[] = []

    // Project A's first hook-state call blocks on gateA.
    const aFirst = lanes.run(
      'hook-state',
      async () => {
        order.push('a-1-start')
        await gateA.promise
        order.push('a-1-end')
      },
      '/projects/a'
    )
    // Project A's second call must queue behind the first (same key).
    const aSecond = lanes.run(
      'hook-state',
      async () => {
        order.push('a-2')
      },
      '/projects/a'
    )
    // Project B shares the daemon but is a different key — must run
    // immediately, not wait on project A's in-flight/queued work.
    const b = lanes.run(
      'hook-state',
      async () => {
        order.push('b')
      },
      '/projects/b'
    )

    await b
    expect(order).toEqual(['a-1-start', 'b'])

    gateA.resolve()
    await Promise.all([aFirst, aSecond])
    expect(order).toEqual(['a-1-start', 'b', 'a-1-end', 'a-2'])
  })

  test('hook-state calls with no key share one lane (backward-compat default)', async () => {
    const lanes = new RequestLanes()
    const gate = Promise.withResolvers<void>()
    const order: string[] = []

    const first = lanes.run('hook-state', async () => {
      order.push('first-start')
      await gate.promise
      order.push('first-end')
    })
    const second = lanes.run('hook-state', async () => {
      order.push('second')
    })

    await Promise.resolve()
    expect(order).toEqual(['first-start'])
    gate.resolve()
    await Promise.all([first, second])
    expect(order).toEqual(['first-start', 'first-end', 'second'])
  })

  test('a rejected lane job does not kill the chain', async () => {
    const lanes = new RequestLanes()
    await expect(
      lanes.run('command', async () => {
        throw new Error('boom')
      })
    ).rejects.toThrow('boom')

    const next = await lanes.run('command', async () => 'recovered')
    expect(next).toBe('recovered')
  })

  /** Flush the microtask queue via a macrotask boundary — unlike awaiting an
   *  already-settled sibling promise, a timer callback only fires after
   *  every pending microtask (including a multi-hop `.then` chain) drains. */
  function flush(ms = 10): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }

  test('hook-state bounds the CALLER wait, and a queued job whose caller gave up is skipped — it never stacks its duration onto the next live caller', async () => {
    process.env.PRJCT_HOOK_STATE_TIMEOUT_MS = '20'
    const lanes = new RequestLanes()
    const gate = Promise.withResolvers<void>()
    const order: string[] = []

    // Simulates the measured tail scenario: a slow buildProjectState ahead
    // in this cwd's chain. Its OWN caller times out too (its work legitimately
    // exceeds the bound); since it already STARTED it runs to completion so
    // its state writes stay whole.
    const slow = lanes.run('hook-state', async () => {
      order.push('slow-start')
      await gate.promise
      order.push('slow-end')
      return 'slow-result'
    })

    // Queued behind `slow` — must not wait the full duration of `slow`, and
    // once its caller has fallen back to the cold path it must NOT run here
    // (that would execute the same prompt hook twice).
    const queuedBehind = lanes.run('hook-state', async () => {
      order.push('queued-behind')
      return 'queued-result'
    })
    slow.catch(() => undefined)
    queuedBehind.catch(() => undefined)

    await expect(slow).rejects.toBeInstanceOf(HookStateLaneTimeoutError)
    await expect(queuedBehind).rejects.toBeInstanceOf(HookStateLaneTimeoutError)
    expect(order).toEqual(['slow-start'])

    gate.resolve()
    await flush()
    expect(order).toEqual(['slow-start', 'slow-end'])
  })

  test('hook-state ordering survives a caller timeout — a live caller queued later still waits for the running job, abandoned jobs in between are dropped', async () => {
    process.env.PRJCT_HOOK_STATE_TIMEOUT_MS = '20'
    const lanes = new RequestLanes()
    const gate = Promise.withResolvers<void>()
    const order: string[] = []

    const first = lanes.run('hook-state', async () => {
      order.push('first-start')
      await gate.promise
      order.push('first-end')
    })
    const second = lanes.run('hook-state', async () => {
      order.push('second') // Would prove a race if this ran before first-end.
    })
    first.catch(() => undefined)
    second.catch(() => undefined)

    await expect(first).rejects.toBeInstanceOf(HookStateLaneTimeoutError)
    await expect(second).rejects.toBeInstanceOf(HookStateLaneTimeoutError)
    expect(order).toEqual(['first-start'])

    // A NEW live caller arrives after the earlier ones bailed. It must still
    // wait for `first` (mutual exclusion on this cwd's state), but must not
    // pay for `second`, which nobody is listening to any more.
    process.env.PRJCT_HOOK_STATE_TIMEOUT_MS = '5000'
    const third = lanes.run('hook-state', async () => {
      order.push('third')
      return 'third-result'
    })
    gate.resolve()
    await expect(third).resolves.toBe('third-result')
    expect(order).toEqual(['first-start', 'first-end', 'third'])
  })

  test('a fast hook-state call resolves normally, well under the timeout', async () => {
    process.env.PRJCT_HOOK_STATE_TIMEOUT_MS = '5000'
    const lanes = new RequestLanes()
    const result = await lanes.run('hook-state', async () => 'ok')
    expect(result).toBe('ok')
  })
})
