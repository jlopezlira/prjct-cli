/**
 * Floating sync phases — the composition SyncService.sync() uses for
 * metrics / install-global / install-agent-surfaces / verify: each phase
 * launches via startPostIndexWork BEFORE the sequential retention chain,
 * records its own wall-clock timing through runSyncPhase, and settles at
 * the end with failures absorbed (never an unhandled rejection in the
 * long-lived daemon).
 */

import { describe, expect, test } from 'bun:test'
import { runSyncPhase, type SyncPhaseTiming } from '../../services/sync/phase-runner'
import { startPostIndexWork } from '../../services/sync/post-index'

describe('sync floating phases', () => {
  test('floating phases overlap the sequential chain and settle with results', async () => {
    const timings: SyncPhaseTiming[] = []
    const events: string[] = []
    const results: { verify?: string } = {}

    const floating = startPostIndexWork(
      async () => {
        const value = await runSyncPhase(
          'verify',
          async () => {
            events.push('verify:start')
            await new Promise((resolve) => setTimeout(resolve, 30))
            events.push('verify:end')
            return 'report'
          },
          timings
        )
        results.verify = value
      },
      { onComplete: () => {} }
    )

    // Sequential chain runs while the floating phase is in flight.
    await runSyncPhase(
      'retention',
      async () => {
        events.push('retention')
      },
      timings
    )

    await floating.settle()

    expect(events).toEqual(['verify:start', 'retention', 'verify:end'])
    expect(results.verify).toBe('report')
    expect(timings.map((t) => t.phase).sort()).toEqual(['retention', 'verify'])
  })

  test('a throwing floating phase is absorbed at settle and still timed', async () => {
    const timings: SyncPhaseTiming[] = []
    const telemetry: { error?: unknown } = {}

    const floating = startPostIndexWork(
      () =>
        runSyncPhase(
          'install-global',
          async () => {
            throw new Error('config write failed')
          },
          timings
        ),
      {
        onComplete: ({ error }) => {
          telemetry.error = error
        },
      }
    )

    await expect(floating.settle()).resolves.toBeUndefined()
    expect((telemetry.error as Error).message).toBe('config write failed')
    expect(timings[0].phase).toBe('install-global')
  })
})
