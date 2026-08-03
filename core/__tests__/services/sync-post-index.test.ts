import { describe, expect, test } from 'bun:test'
import { type PostIndexTelemetry, startPostIndexWork } from '../../services/sync/post-index'

describe('sync post-index overlap', () => {
  test('later work proceeds while settlement waits for delayed post-index work', async () => {
    let release!: () => void
    const delayed = new Promise<void>((resolve) => {
      release = resolve
    })
    let now = 100
    let started = false
    let telemetry: PostIndexTelemetry | undefined

    const postIndex = startPostIndexWork(
      async () => {
        started = true
        await delayed
      },
      {
        now: () => now,
        onComplete: (value) => {
          telemetry = value
        },
      }
    )

    expect(started).toBe(true)
    let laterWorkFinished = false
    await Promise.resolve().then(() => {
      laterWorkFinished = true
    })
    expect(laterWorkFinished).toBe(true)

    let syncStyleSettlementFinished = false
    const settlement = postIndex.settle().then(() => {
      syncStyleSettlementFinished = true
    })
    await Promise.resolve()
    expect(syncStyleSettlementFinished).toBe(false)

    now = 500
    release()
    await settlement

    expect(syncStyleSettlementFinished).toBe(true)
    expect(telemetry).toEqual({ totalMs: 400 })
  })

  test('settlement absorbs both work and telemetry callback failures', async () => {
    const workError = new Error('upload failed')
    let telemetry: PostIndexTelemetry | undefined
    const postIndex = startPostIndexWork(
      async () => {
        throw workError
      },
      {
        now: () => 100,
        onComplete: (value) => {
          telemetry = value
          throw new Error('telemetry sink failed')
        },
      }
    )

    await expect(postIndex.settle()).resolves.toBeUndefined()
    expect(telemetry).toEqual({ totalMs: 0, error: workError })
  })
})
