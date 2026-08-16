/** Parse `raw` as JSON, returning `null` instead of throwing on malformed input. */
export function safeJsonParse<T = unknown>(raw: string): T | null {
  try {
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}
