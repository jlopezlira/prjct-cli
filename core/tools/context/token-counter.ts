/**
 * Token Counter - REAL token measurement for context tools
 *
 * Provides accurate token estimation for measuring compression rates.
 * Uses industry-standard approximation: ~4 characters per token.
 *
 * This is critical for the Value Dashboard to show REAL savings,
 * not estimated ones.
 *
 */

import { CHARS_PER_TOKEN } from '../../constants/token'
import type { TokenMetrics } from '../../types/context-tools'

/**
 * Model pricing per 1000 tokens, plus each model's context window.
 *
 * Keys are the REAL model ids the API accepts (`claude-opus-4-8`), not the
 * dotted marketing names this table used to carry (`claude-opus-4.5`) — those
 * never matched a model id reported by any rig, so every lookup silently fell
 * through to the default and the cost report was wrong for each of them.
 *
 * `contextWindow` is what lets a cycle budget be derived instead of
 * configured — see `contextWindowFor`.
 *
 * Sources:
 * - Anthropic: https://docs.anthropic.com/en/docs/about-claude/models
 * - OpenAI: https://openai.com/pricing
 * - Google: https://ai.google.dev/pricing
 */
const MODEL_PRICING = {
  // Anthropic Claude 5 family
  'claude-fable-5': { input: 0.01, output: 0.05, contextWindow: 1_000_000 }, // $10/$50 per M
  'claude-opus-5': { input: 0.005, output: 0.025, contextWindow: 1_000_000 }, // $5/$25 per M
  'claude-sonnet-5': { input: 0.003, output: 0.015, contextWindow: 1_000_000 }, // $3/$15 per M
  'claude-haiku-4-5': { input: 0.001, output: 0.005, contextWindow: 200_000 }, // $1/$5 per M
  // Previous Anthropic generations
  'claude-opus-4-8': { input: 0.005, output: 0.025, contextWindow: 1_000_000 }, // $5/$25 per M
  'claude-opus-4-7': { input: 0.005, output: 0.025, contextWindow: 1_000_000 }, // $5/$25 per M
  'claude-opus-4-6': { input: 0.005, output: 0.025, contextWindow: 1_000_000 }, // $5/$25 per M
  'claude-sonnet-4-6': { input: 0.003, output: 0.015, contextWindow: 1_000_000 }, // $3/$15 per M
  // OpenAI
  'gpt-4o': { input: 0.0025, output: 0.01, contextWindow: 128_000 }, // $2.50/$10 per M
  'gpt-4-turbo': { input: 0.01, output: 0.03, contextWindow: 128_000 }, // $10/$30 per M
  'gpt-4o-mini': { input: 0.00015, output: 0.0006, contextWindow: 128_000 }, // $0.15/$0.60 per M
  // Google
  'gemini-1.5-pro': { input: 0.00125, output: 0.005, contextWindow: 2_000_000 }, // $1.25/$5 per M
  'gemini-1.5-flash': { input: 0.000075, output: 0.0003, contextWindow: 1_000_000 }, // $0.075/$0.30 per M
} as const

type ModelName = keyof typeof MODEL_PRICING

/**
 * Context window for a model id, or null when unknown.
 *
 * Rigs report ids inconsistently — dated snapshots (`claude-opus-5-20260114`),
 * platform prefixes (`anthropic.claude-opus-5`), Vertex `@`-versions. An exact
 * hit wins; otherwise the longest known id contained in the string wins, so a
 * decorated id still resolves while an unrelated model stays null. Returning
 * null is meaningful: callers must treat "unknown model" as "no budget", never
 * as zero.
 */
export function contextWindowFor(model: string | null | undefined): number | null {
  const id = (model ?? '').trim().toLowerCase()
  if (!id) return null
  const exact = (MODEL_PRICING as Record<string, { contextWindow?: number }>)[id]
  if (exact?.contextWindow) return exact.contextWindow
  const match = Object.keys(MODEL_PRICING)
    .filter((known) => id.includes(known))
    .sort((a, b) => b.length - a.length)[0]
  if (!match) return null
  return (MODEL_PRICING as Record<string, { contextWindow?: number }>)[match]?.contextWindow ?? null
}

// Default model for cost calculations
const DEFAULT_MODEL: ModelName = 'claude-opus-5'

// Core Functions

/**
 * Count tokens in a text string
 *
 * Uses character-based estimation that's accurate enough for
 * measuring compression rates without requiring actual tokenizer.
 *
 * @param text - The text to count tokens for
 * @returns Estimated token count
 */
export function countTokens(text: string): number {
  if (!text || text.length === 0) return 0
  return Math.ceil(text.length / CHARS_PER_TOKEN)
}

/**
 * Models to show in cost breakdown (most popular)
 */
const BREAKDOWN_MODELS: ModelName[] = [
  'claude-opus-5',
  'claude-sonnet-5',
  'claude-haiku-4-5',
  'gpt-4o',
  'gemini-1.5-pro',
]

/**
 * Calculate cost breakdown for a model
 * Output potential = estimated savings if response is proportionally shorter
 */
function calculateModelCost(
  tokensSaved: number,
  model: ModelName
): {
  inputSaved: number
  outputPotential: number
  total: number
} {
  const pricing = MODEL_PRICING[model]
  const inputSaved = (tokensSaved / 1000) * pricing.input
  // Conservative estimate: output savings ~30% of compression benefit
  // (less context = more focused response, but not 1:1)
  const outputPotential = (tokensSaved / 1000) * pricing.output * 0.3
  return {
    inputSaved,
    outputPotential,
    total: inputSaved + outputPotential,
  }
}

/**
 * Format cost as currency string
 */
function formatCostSaved(cost: number): string {
  if (cost < 0.001) {
    return '<$0.01'
  }
  if (cost < 0.01) {
    return `$${cost.toFixed(3)}`
  }
  return `$${cost.toFixed(2)}`
}

/**
 * Measure compression between original and filtered content
 *
 * @param original - Original content before filtering
 * @param filtered - Filtered content after compression
 * @returns Token metrics with compression rate and multi-model cost savings
 */
export function measureCompression(original: string, filtered: string): TokenMetrics {
  const originalTokens = countTokens(original)
  const filteredTokens = countTokens(filtered)
  const tokensSaved = Math.max(0, originalTokens - filteredTokens)

  const compression = originalTokens > 0 ? (originalTokens - filteredTokens) / originalTokens : 0

  // Calculate cost for default model
  const defaultCost = calculateModelCost(tokensSaved, DEFAULT_MODEL)

  // Calculate breakdown for popular models
  const byModel = BREAKDOWN_MODELS.map((model) => ({
    model,
    ...calculateModelCost(tokensSaved, model),
  }))

  return {
    tokens: {
      original: originalTokens,
      filtered: filteredTokens,
      saved: tokensSaved,
    },
    compression: Math.max(0, Math.min(1, compression)),
    cost: {
      saved: defaultCost.total,
      formatted: formatCostSaved(defaultCost.total),
      byModel,
    },
  }
}

/**
 * Create metrics for a fallback (no compression) case
 *
 * @param content - The full content that couldn't be compressed
 * @returns Token metrics with 0% compression
 */
export function noCompression(content: string): TokenMetrics {
  const tokens = countTokens(content)

  return {
    tokens: { original: tokens, filtered: tokens, saved: 0 },
    compression: 0,
    cost: {
      saved: 0,
      formatted: '$0.00',
      byModel: BREAKDOWN_MODELS.map((model) => ({
        model,
        inputSaved: 0,
        outputPotential: 0,
        total: 0,
      })),
    },
  }
}

/**
 * Combine multiple token metrics into one
 *
 * Useful when processing multiple files and aggregating results.
 *
 * @param metrics - Array of token metrics to combine
 * @returns Combined metrics
 */
export function combineMetrics(metrics: TokenMetrics[]): TokenMetrics {
  if (metrics.length === 0) {
    return noCompression('')
  }

  // Sum tokens
  const totalOriginal = metrics.reduce((sum, m) => sum + m.tokens.original, 0)
  const totalFiltered = metrics.reduce((sum, m) => sum + m.tokens.filtered, 0)
  const totalSaved = metrics.reduce((sum, m) => sum + m.tokens.saved, 0)

  // Calculate overall compression
  const compression = totalOriginal > 0 ? (totalOriginal - totalFiltered) / totalOriginal : 0

  // Sum costs by model
  const byModel = BREAKDOWN_MODELS.map((model) => {
    const modelMetrics = metrics.map(
      (m) =>
        m.cost.byModel.find((b) => b.model === model) || {
          inputSaved: 0,
          outputPotential: 0,
          total: 0,
        }
    )
    return {
      model,
      inputSaved: modelMetrics.reduce((sum, m) => sum + m.inputSaved, 0),
      outputPotential: modelMetrics.reduce((sum, m) => sum + m.outputPotential, 0),
      total: modelMetrics.reduce((sum, m) => sum + m.total, 0),
    }
  })

  const totalCost = metrics.reduce((sum, m) => sum + m.cost.saved, 0)

  return {
    tokens: {
      original: totalOriginal,
      filtered: totalFiltered,
      saved: totalSaved,
    },
    compression,
    cost: {
      saved: totalCost,
      formatted: formatCostSaved(totalCost),
      byModel,
    },
  }
}

/**
 * Format token count for display
 *
 * @param tokens - Number of tokens
 * @returns Human-readable string (e.g., "1.5K", "2.3M")
 */
export function formatTokenCount(tokens: number): string {
  if (tokens >= 1_000_000) {
    return `${(tokens / 1_000_000).toFixed(1)}M`
  }
  if (tokens >= 1_000) {
    return `${(tokens / 1_000).toFixed(1)}K`
  }
  return tokens.toLocaleString()
}

/**
 * Format compression rate for display
 *
 * @param rate - Compression rate (0-1)
 * @returns Human-readable string (e.g., "89%")
 */
export function formatCompressionRate(rate: number): string {
  return `${Math.round(rate * 100)}%`
}

// Exports

export { formatCostSaved }
