export interface PostIndexTelemetry {
  totalMs: number
  error?: unknown
}

export interface PostIndexWork {
  settle(): Promise<void>
}

/** Start best-effort post-index work now and expose an explicit settlement point. */
export function startPostIndexWork(
  run: () => Promise<unknown>,
  options: {
    now?: () => number
    onComplete?: (telemetry: PostIndexTelemetry) => void
  } = {}
): PostIndexWork {
  const now = options.now ?? Date.now
  const startedAt = now()

  let pending: Promise<{ error?: unknown }>
  try {
    pending = run().then(
      () => ({}),
      (error: unknown) => ({ error })
    )
  } catch (error) {
    pending = Promise.resolve({ error })
  }

  const completed = pending.then((outcome) => {
    try {
      options.onComplete?.({ totalMs: now() - startedAt, ...outcome })
    } catch {
      // Telemetry is observational. A broken sink must never turn best-effort
      // post-index work into a failed sync at the settlement point.
    }
  })

  return {
    async settle(): Promise<void> {
      await completed
    },
  }
}
