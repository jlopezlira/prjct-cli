import { describe, expect, test } from 'bun:test'
import { type PostIndexTelemetry, startPostIndexWork } from '../../services/sync/post-index'

describe('sync post-index overlap', () => {
  test('later work proceeds while settlement waits for delayed post-index work', async () => {
    const releaseCallbacks: Array<() => void> = []
    const delayed = new Promise<void>((resolve) => {
      releaseCallbacks.push(resolve)
    })
    const clock = [100, 500]
    const started: true[] = []
    const telemetry: PostIndexTelemetry[] = []

    const postIndex = startPostIndexWork(
      async () => {
        started.push(true)
        await delayed
      },
      {
        now: () => clock.shift() ?? 500,
        onComplete: (value) => {
          telemetry.push(value)
        },
      }
    )

    expect(started).toHaveLength(1)
    const laterWorkFinished = await Promise.resolve(true)
    expect(laterWorkFinished).toBe(true)

    const settlements: true[] = []
    const settlement = postIndex.settle().then(() => {
      settlements.push(true)
    })
    await Promise.resolve()
    expect(settlements).toHaveLength(0)

    releaseCallbacks[0]?.()
    await settlement

    expect(settlements).toHaveLength(1)
    expect(telemetry[0]).toEqual({ totalMs: 400 })
  })

  test('settlement absorbs both work and telemetry callback failures', async () => {
    const workError = new Error('upload failed')
    const telemetry: PostIndexTelemetry[] = []
    const postIndex = startPostIndexWork(
      async () => {
        throw workError
      },
      {
        now: () => 100,
        onComplete: (value) => {
          telemetry.push(value)
          throw new Error('telemetry sink failed')
        },
      }
    )

    await expect(postIndex.settle()).resolves.toBeUndefined()
    expect(telemetry[0]).toEqual({ totalMs: 0, error: workError })
  })
})
