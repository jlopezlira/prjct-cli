/**
 * Shared HTTP helpers for LLM wires — timeout, error text, AbortSignal.
 */

import { LLM_DEFAULT_TIMEOUT_MS } from './types'

export class LlmHttpError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly bodySnippet?: string
  ) {
    super(message)
    this.name = 'LlmHttpError'
  }
}

export async function fetchJson(
  url: string,
  init: RequestInit & { timeoutMs?: number },
  fetchImpl: typeof fetch = fetch
): Promise<{ status: number; json: unknown; text: string }> {
  const timeoutMs = init.timeoutMs ?? LLM_DEFAULT_TIMEOUT_MS
  const { timeoutMs: _t, ...rest } = init

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  // Compose with caller signal if present
  const onCallerAbort = () => controller.abort()
  if (rest.signal) {
    if (rest.signal.aborted) controller.abort()
    else rest.signal.addEventListener('abort', onCallerAbort, { once: true })
  }

  try {
    const res = await fetchImpl(url, {
      ...rest,
      signal: controller.signal,
    })
    const text = await res.text()
    if (!res.ok) {
      throw new LlmHttpError(
        `LLM HTTP ${res.status} from ${url}: ${text.slice(0, 400)}`,
        res.status,
        text.slice(0, 400)
      )
    }
    const json = (() => {
      try {
        return text ? JSON.parse(text) : {}
      } catch {
        throw new LlmHttpError(
          `LLM returned non-JSON from ${url}: ${text.slice(0, 200)}`,
          res.status,
          text.slice(0, 200)
        )
      }
    })()
    return { status: res.status, json, text }
  } catch (err) {
    if (err instanceof LlmHttpError) throw err
    const msg = err instanceof Error ? err.message : String(err)
    if (/abort/i.test(msg)) {
      throw new LlmHttpError(`LLM request timed out after ${timeoutMs}ms (${url})`)
    }
    throw new LlmHttpError(`LLM request failed (${url}): ${msg}`)
  } finally {
    clearTimeout(timer)
    if (rest.signal) rest.signal.removeEventListener('abort', onCallerAbort)
  }
}

/** Normalize OpenAI-style message content: string | content-part array | null. */
export function normalizeMessageContent(content: unknown): string | null {
  if (content == null) return null
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    const parts: string[] = []
    for (const p of content) {
      if (typeof p === 'string') parts.push(p)
      else if (p && typeof p === 'object') {
        const o = p as Record<string, unknown>
        if (typeof o.text === 'string') parts.push(o.text)
      }
    }
    return parts.length ? parts.join('\n') : null
  }
  return String(content)
}
