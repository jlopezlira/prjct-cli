import { describe, expect, test } from 'bun:test'
import { RequestLanes } from '../../daemon/request-lanes'

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
})
