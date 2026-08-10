import { describe, expect, test } from 'bun:test'
import { RequestJournal } from '../../daemon/request-journal'
import type { DaemonRequest, DaemonResponse } from '../../types/daemon'

function request(overrides: Partial<DaemonRequest> = {}): DaemonRequest {
  return {
    id: 'req-1',
    command: 'capture',
    args: ['note'],
    options: { md: true },
    cwd: '/tmp/project',
    ...overrides,
  }
}

describe('RequestJournal', () => {
  test('shares one in-flight runner for duplicate request ids', async () => {
    const journal = new RequestJournal()
    const fixture: {
      calls: number
      release: () => void
    } = {
      calls: 0,
      release: undefined as unknown as () => void,
    }

    const wait = new Promise<void>((resolve) => {
      fixture.release = resolve
    })

    const runner = async (): Promise<DaemonResponse> => {
      fixture.calls++
      await wait
      return { id: 'req-1', success: true, exitCode: 0, stdout: 'ok' }
    }

    const first = journal.run(request(), runner)
    const second = journal.run(request(), runner)
    fixture.release()

    expect(await first).toEqual({ id: 'req-1', success: true, exitCode: 0, stdout: 'ok' })
    expect(await second).toEqual({ id: 'req-1', success: true, exitCode: 0, stdout: 'ok' })
    expect(fixture.calls).toBe(1)
  })

  test('replays a completed response without rerunning side effects', async () => {
    const journal = new RequestJournal()
    const calls: true[] = []
    const runner = async (): Promise<DaemonResponse> => {
      calls.push(true)
      return { id: 'req-1', success: true, exitCode: 0, result: { done: true } }
    }

    expect(await journal.run(request(), runner)).toEqual({
      id: 'req-1',
      success: true,
      exitCode: 0,
      result: { done: true },
    })
    expect(await journal.run(request(), runner)).toEqual({
      id: 'req-1',
      success: true,
      exitCode: 0,
      result: { done: true },
    })
    expect(calls).toHaveLength(1)
  })

  test('rejects the same request id with a different payload', async () => {
    const journal = new RequestJournal()
    const runner = async (): Promise<DaemonResponse> => ({
      id: 'req-1',
      success: true,
      exitCode: 0,
    })

    await journal.run(request(), runner)
    const conflict = await journal.run(request({ command: 'done' }), runner)

    expect(conflict.success).toBe(false)
    expect(conflict.stderr).toContain('Duplicate daemon request id')
  })

  test('expires old entries by ttl', async () => {
    const fixture: {
      now: number
      calls: number
    } = {
      now: 0,
      calls: 0,
    }
    const journal = new RequestJournal({ ttlMs: 10, now: () => fixture.now })

    const runner = async (): Promise<DaemonResponse> => {
      fixture.calls++
      return { id: 'req-1', success: true, exitCode: 0 }
    }

    await journal.run(request(), runner)
    fixture.now = 11
    await journal.run(request(), runner)

    expect(fixture.calls).toBe(2)
  })
})
