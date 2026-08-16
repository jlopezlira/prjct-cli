import { createHash } from 'node:crypto'

export function sha256(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex')
}

export function sha256Short(input: string): string {
  return sha256(input).slice(0, 16)
}

export function md5(input: string | Buffer): string {
  return createHash('md5').update(input).digest('hex')
}

/**
 * Hash a payload deterministically. Object key order matters here — we sort
 * top-level keys before stringifying so two equivalent payloads produce the
 * same hash. Used for sync content-hash dedup (idempotency + last-write-wins).
 */
export function hashPayload(data: unknown): string {
  const canonical =
    data && typeof data === 'object' && !Array.isArray(data)
      ? JSON.stringify(sortKeys(data as Record<string, unknown>))
      : JSON.stringify(data)
  return sha256(canonical)
}

function sortKeys(obj: Record<string, unknown>): Record<string, unknown> {
  const sorted: Record<string, unknown> = {}
  for (const k of Object.keys(obj).sort()) sorted[k] = obj[k]
  return sorted
}
