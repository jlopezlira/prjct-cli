/**
 * Metrics Schema
 *
 * Defines the structure for metrics.json - value dashboard metrics.
 * Tracks token savings, sync performance, and usage trends.
 *
 * Uses Zod for runtime validation and TypeScript type inference.
 */

import { z } from 'zod'

// Zod Schemas - Source of Truth

/**
 * Daily stats for trend analysis
 */
export const DailyStatsSchema = z.object({
  date: z.string(), // YYYY-MM-DD
  tokensSaved: z.number(), // Tokens saved that day
  syncs: z.number(), // Number of syncs
  avgCompressionRate: z.number(), // Average compression rate (0-1)
  totalDuration: z.number(), // Total sync time in ms
})

/**
 * Agent usage tracking
 */
export const AgentUsageSchema = z.object({
  agentName: z.string(), // e.g., "backend", "frontend"
  usageCount: z.number(), // Times invoked
  tokensSaved: z.number(), // Tokens saved by this agent
})

/**
 * Main metrics JSON structure
 */
// Inferred Types

export type DailyStats = z.infer<typeof DailyStatsSchema>
export type AgentUsage = z.infer<typeof AgentUsageSchema>

// Cost Calculation Constants (January 2026 Pricing)

/**
 * Token costs per 1000 tokens (INPUT pricing)
 * Source: https://docs.anthropic.com/en/docs/about-claude/models
 *
 * Used for estimating cost savings from context compression
 */
// Keys are the REAL model ids the API accepts, not dotted marketing names —
// `claude-opus-4.5` never matched anything a rig reports, so those lookups
// silently fell through to `default` and mispriced the cost report.
const TOKEN_COSTS = {
  // Claude 5 family
  'claude-fable-5': 0.01, // $10/M input - most capable
  'claude-opus-5': 0.005, // $5/M input - flagship
  'claude-sonnet-5': 0.003, // $3/M input - balanced
  'claude-haiku-4-5': 0.001, // $1/M input - fastest
  // Previous generations
  'claude-opus-4-8': 0.005, // $5/M input
  'claude-opus-4-7': 0.005, // $5/M input
  'claude-opus-4-6': 0.005, // $5/M input
  'claude-sonnet-4-6': 0.003, // $3/M input
  // Other providers
  'gpt-4o': 0.0025, // $2.50/M input
  'gemini-pro': 0.00125, // $1.25/M input
  // Default: Claude Opus 5 (what Claude Code runs unless told otherwise)
  default: 0.005, // $5/M input
} as const

type ModelName = keyof typeof TOKEN_COSTS

/**
 * Calculate estimated cost saved based on tokens
 */
export function estimateCostSaved(tokens: number, model: ModelName = 'default'): number {
  const costPer1k = TOKEN_COSTS[model] || TOKEN_COSTS.default
  return (tokens / 1000) * costPer1k
}

/**
 * Format cost as currency string
 */
export function formatCost(cost: number): string {
  if (cost < 0.01) {
    return `$${(cost * 100).toFixed(2)}¢`
  }
  return `$${cost.toFixed(2)}`
}
