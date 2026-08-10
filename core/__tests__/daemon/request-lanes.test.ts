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
