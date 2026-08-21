/**
 * Infer wire / base URL / default model from key prefix or base URL.
 * Zero-config: paste `--key` (and optional `--name`) and go.
 */

import type { LlmWireKind } from './types'

export interface DetectedBrain {
  wire: LlmWireKind
  baseUrl: string
  providerLabel: string
  /** Suggested default model when user omitted --model */
  defaultModel: string
  /** Local / small-model hint for weak-mode heuristics */
  weakHint?: boolean
}

/**
 * Detect provider from API key prefix.
 * Anthropic keys map to native Anthropic wire (not OpenAI-compat).
 * Order matters: sk-or- / sk-ant- before generic sk-.
 */
export function detectBrainFromKey(key: string): DetectedBrain | undefined {
  const k = key.trim()
  if (!k) return undefined
  if (/^sk-or-/i.test(k)) {
    return {
      wire: 'openai-compatible',
      baseUrl: 'https://openrouter.ai/api/v1',
      providerLabel: 'OpenRouter',
      defaultModel: 'openai/gpt-4o-mini',
    }
  }
  if (/^sk-ant-/i.test(k)) {
    return {
      wire: 'anthropic',
      baseUrl: 'https://api.anthropic.com',
      providerLabel: 'Anthropic',
      defaultModel: 'claude-opus-5',
    }
  }
  if (/^xai-/i.test(k)) {
    return {
      wire: 'openai-compatible',
      baseUrl: 'https://api.x.ai/v1',
      providerLabel: 'xAI',
      defaultModel: 'grok-3-mini',
    }
  }
  if (/^sk-/i.test(k)) {
    return {
      wire: 'openai-compatible',
      baseUrl: 'https://api.openai.com/v1',
      providerLabel: 'OpenAI',
      defaultModel: 'gpt-4o-mini',
    }
  }
  return undefined
}

/**
 * Detect local / known bases when user passes --base-url (Ollama often has no real key).
 */
export function detectBrainFromBaseUrl(baseUrl: string): DetectedBrain | undefined {
  const u = baseUrl.trim().replace(/\/+$/, '')
  if (!u) return undefined

  if (/localhost:11434|127\.0\.0\.1:11434/i.test(u)) {
    return {
      wire: 'openai-compatible',
      baseUrl: ensureV1(u),
      providerLabel: 'Ollama',
      defaultModel: 'qwen3.5:4b',
      weakHint: true,
    }
  }
  if (/localhost:1234|127\.0\.0\.1:1234/i.test(u)) {
    return {
      wire: 'openai-compatible',
      baseUrl: ensureV1(u),
      providerLabel: 'LM Studio',
      defaultModel: 'local-model',
      weakHint: true,
    }
  }
  if (/api\.anthropic\.com/i.test(u)) {
    return {
      wire: 'anthropic',
      baseUrl: 'https://api.anthropic.com',
      providerLabel: 'Anthropic',
      defaultModel: 'claude-opus-5',
    }
  }
  if (/openrouter\.ai/i.test(u)) {
    return {
      wire: 'openai-compatible',
      baseUrl: u.includes('/api')
        ? ensureV1(u.replace(/\/chat\/completions$/i, ''))
        : 'https://openrouter.ai/api/v1',
      providerLabel: 'OpenRouter',
      defaultModel: 'openai/gpt-4o-mini',
    }
  }
  if (/api\.x\.ai/i.test(u)) {
    return {
      wire: 'openai-compatible',
      baseUrl: ensureV1(u),
      providerLabel: 'xAI',
      defaultModel: 'grok-3-mini',
    }
  }
  if (/api\.openai\.com/i.test(u)) {
    return {
      wire: 'openai-compatible',
      baseUrl: ensureV1(u),
      providerLabel: 'OpenAI',
      defaultModel: 'gpt-4o-mini',
    }
  }
  return undefined
}

function ensureV1(u: string): string {
  const root = u.replace(/\/+$/, '')
  if (/\/v1$/i.test(root)) return root
  if (/\/v1\//i.test(root)) return root.replace(/\/v1\/.*$/i, '/v1')
  return `${root}/v1`
}

/** OpenRouter bare model ids → vendor/model. */
export function normalizeChatModelForBaseUrl(model: string, baseUrl: string): string {
  if (/openrouter\.ai/i.test(baseUrl) && model && !model.includes('/')) {
    return `openai/${model}`
  }
  return model
}

export function slugifyProfileName(raw: string): string {
  return (
    raw
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'default'
  )
}

/** True when base URL points at a loopback local runtime. */
export function isLocalBaseUrl(baseUrl: string): boolean {
  return /localhost|127\.0\.0\.1/i.test(baseUrl)
}
