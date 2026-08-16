import { getErrorMessage } from '../../errors'
import log from '../../utils/logger'

export const DEFAULT_SYNC_PHASE_TIMEOUT_MS = 60_000

export class SyncPhaseTimeoutError extends Error {
  readonly phase: string
  readonly timeoutMs: number

  constructor(phase: string, timeoutMs: number) {
    super(
      `sync phase '${phase}' timed out after ${timeoutMs}ms. ` +
        'Set PRJCT_SYNC_PHASE_TIMEOUT_MS to tune this guard, or run `prjct sync --full --md` if incremental state looks stale.'
    )
    this.name = 'SyncPhaseTimeoutError'
    this.phase = phase
    this.timeoutMs = timeoutMs
  }
}

export function syncPhaseTimeoutMs(): number {
  return Number(process.env.PRJCT_SYNC_PHASE_TIMEOUT_MS) || DEFAULT_SYNC_PHASE_TIMEOUT_MS
}

/**
 * Timeout wrapper for observational phases only.
 *
 * Promise.race cannot cancel the original promise, so callers must not wrap
 * phases that mutate SQLite/filesystem state unless that work is abort-aware.
 */
export function withPhaseTimeout<T>(promise: Promise<T>, phase: string): Promise<T> {
  const timeoutMs = syncPhaseTimeoutMs()
  const timeout = (() => {
    const deferred = Promise.withResolvers<T>()
    const timer = setTimeout(
      () => deferred.reject(new SyncPhaseTimeoutError(phase, timeoutMs)),
      timeoutMs
    )
    return { promise: deferred.promise, cancel: () => clearTimeout(timer) }
  })()
  return Promise.race([promise, timeout.promise]).finally(timeout.cancel)
}

export interface SyncPhaseTiming {
  phase: string
  ms: number
}

export async function runSyncPhase<T>(
  name: string,
  fn: () => Promise<T>,
  timings?: SyncPhaseTiming[]
): Promise<T> {
  const start = Date.now()
  log.debug('sync phase start', { phase: name })
  try {
    const result = await fn()
    const ms = Date.now() - start
    log.debug('sync phase done', { phase: name, ms })
    timings?.push({ phase: name, ms })
    return result
  } catch (error) {
    const ms = Date.now() - start
    log.debug('sync phase failed', { phase: name, ms, error: getErrorMessage(error) })
    timings?.push({ phase: name, ms })
    throw error
  }
}
