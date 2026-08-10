/**
 * Velocity Engine (PRJ-296)
 *
 * Sprint-based velocity calculation with:
 * - Sprint aggregation from outcomes data
 * - Trend detection (improving/stable/declining)
 * - Estimation accuracy tracking
 * - Over/under estimation pattern detection
 * - Completion projections
 */

import { DAY_INDEX } from '../constants/algorithms'
import {
  type CompletionProjection,
  DEFAULT_VELOCITY_CONFIG,
  type EstimationPattern,
  type SprintVelocity,
  type VelocityConfig,
  type VelocityMetrics,
  type VelocityTrend,
} from '../schemas/velocity'
import type { Outcome } from '../types/outcomes'
import { parseDurationMinutes } from '../utils/date-helper'

// Sprint Boundary Calculation

/**
 * Get the sprint start date for a given date based on config.
 * Sprints align to calendar boundaries (e.g., every Monday for 7-day sprints).
 */
export function getSprintStart(date: Date, config: VelocityConfig): Date {
  const resolved = resolveConfig(config)
  const startDayIdx = DAY_INDEX[resolved.startDay]
  const d = new Date(date)
  d.setHours(0, 0, 0, 0)

  // Roll back to the most recent start day
  const currentDay = d.getDay()
  const diff = (currentDay - startDayIdx + 7) % 7
  d.setDate(d.getDate() - diff)

  return d
}

/**
 * Get sprint end date from sprint start.
 */
export function getSprintEnd(sprintStart: Date, config: VelocityConfig): Date {
  const resolved = resolveConfig(config)
  const end = new Date(sprintStart)
  end.setDate(end.getDate() + resolved.sprintLengthDays - 1)
  end.setHours(23, 59, 59, 999)
  return end
}

/**
 * Assign a sprint number to a date.
 * Sprint 1 is the earliest sprint in the data set.
 */
function getSprintNumber(date: Date, earliestDate: Date, config: VelocityConfig): number {
  const resolved = resolveConfig(config)
  const sprintStart = getSprintStart(date, config)
  const firstSprintStart = getSprintStart(earliestDate, config)

  const diffMs = sprintStart.getTime() - firstSprintStart.getTime()
  const diffDays = Math.round(diffMs / (1000 * 60 * 60 * 24))

  return Math.floor(diffDays / resolved.sprintLengthDays) + 1
}

// Core Engine

/**
 * Calculate velocity metrics from outcome data.
 */
export function calculateVelocity(
  outcomes: Outcome[],
  config: VelocityConfig = DEFAULT_VELOCITY_CONFIG
): VelocityMetrics {
  const resolved = resolveConfig(config)

  if (outcomes.length === 0) {
    return {
      sprints: [],
      averageVelocity: 0,
      velocityTrend: 'stable',
      estimationAccuracy: 0,
      overEstimated: [],
      underEstimated: [],
      lastUpdated: new Date().toISOString(),
    }
  }

  // Parse outcomes into sprint buckets
  const sprintBuckets = bucketBySprint(outcomes, config)
  const sprints = buildSprintVelocities(sprintBuckets, resolved.accuracyTolerance)

  // Use last N sprints for rolling metrics
  const windowSprints = sprints.slice(-resolved.windowSize)

  const averageVelocity = calculateAverageVelocity(windowSprints)
  const velocityTrend = detectTrend(windowSprints)
  const estimationAccuracy = calculateOverallAccuracy(outcomes, resolved.accuracyTolerance)

  // Detect estimation patterns
  const { overEstimated, underEstimated } = detectEstimationPatterns(outcomes)

  return {
    sprints,
    averageVelocity,
    velocityTrend,
    estimationAccuracy,
    overEstimated,
    underEstimated,
    lastUpdated: new Date().toISOString(),
  }
}

/**
 * Project completion date given remaining points and current velocity.
 */
export function projectCompletion(
  totalPoints: number,
  averageVelocity: number,
  config: VelocityConfig = DEFAULT_VELOCITY_CONFIG
): CompletionProjection {
  const resolved = resolveConfig(config)

  if (averageVelocity <= 0) {
    return {
      totalPoints,
      sprints: 0,
      estimatedDate: '',
    }
  }

  const sprints = Math.ceil(totalPoints / averageVelocity)
  const daysRemaining = sprints * resolved.sprintLengthDays
  const estimatedDate = new Date()
  estimatedDate.setDate(estimatedDate.getDate() + daysRemaining)

  return {
    totalPoints,
    sprints,
    estimatedDate: estimatedDate.toISOString(),
  }
}

// Sprint Bucketing

interface SprintBucket {
  sprintNumber: number
  startDate: Date
  endDate: Date
  outcomes: Outcome[]
}

function bucketBySprint(outcomes: Outcome[], config: VelocityConfig): Map<number, SprintBucket> {
  const buckets = new Map<number, SprintBucket>()

  // Find earliest outcome date
  const dates = outcomes.map((o) => new Date(o.completedAt))
  const earliest = new Date(Math.min(...dates.map((d) => d.getTime())))

  for (const outcome of outcomes) {
    const completedDate = new Date(outcome.completedAt)
    const sprintNum = getSprintNumber(completedDate, earliest, config)

    if (!buckets.has(sprintNum)) {
      const start = getSprintStart(completedDate, config)
      const end = getSprintEnd(start, config)
      buckets.set(sprintNum, {
        sprintNumber: sprintNum,
        startDate: start,
        endDate: end,
        outcomes: [],
      })
    }

    buckets.get(sprintNum)!.outcomes.push(outcome)
  }

  return buckets
}

function buildSprintVelocities(
  buckets: Map<number, SprintBucket>,
  accuracyTolerance: number
): SprintVelocity[] {
  const sprints: SprintVelocity[] = []

  for (const [, bucket] of buckets) {
    const points = bucket.outcomes.reduce((sum, o) => {
      return sum + derivePoints(o)
    }, 0)

    const variances = bucket.outcomes.filter((o) => o.variance).map((o) => parseVariancePercent(o))

    const avgVariance =
      variances.length > 0 ? Math.round(variances.reduce((a, b) => a + b, 0) / variances.length) : 0

    const accurateCount = variances.filter((v) => Math.abs(v) <= accuracyTolerance).length
    const estimationAccuracy =
      variances.length > 0 ? Math.round((accurateCount / variances.length) * 100) : 0

    sprints.push({
      sprintNumber: bucket.sprintNumber,
      startDate: bucket.startDate.toISOString(),
      endDate: bucket.endDate.toISOString(),
      pointsCompleted: points,
      tasksCompleted: bucket.outcomes.length,
      avgVariance,
      estimationAccuracy,
    })
  }

  // Sort by sprint number
  return sprints.sort((a, b) => a.sprintNumber - b.sprintNumber)
}

// Trend Detection

/**
 * Detect velocity trend using simple linear regression on points per sprint.
 * Requires at least 3 sprints for meaningful trend detection.
 */
export function detectTrend(sprints: SprintVelocity[]): VelocityTrend {
  if (sprints.length < 3) return 'stable'

  const points = sprints.map((s) => s.pointsCompleted)
  const n = points.length

  // Simple linear regression slope
  const [sumX, sumY, sumXY, sumX2] = points.reduce<[number, number, number, number]>(
    (sums, point, index) => [
      sums[0] + index,
      sums[1] + point,
      sums[2] + index * point,
      sums[3] + index * index,
    ],
    [0, 0, 0, 0]
  )

  const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX)
  const avgVelocity = sumY / n

  // Normalize slope as percentage of average velocity
  if (avgVelocity === 0) return 'stable'

  const normalizedSlope = slope / avgVelocity

  // Thresholds: >10% per sprint = improving, <-10% = declining
  if (normalizedSlope > 0.1) return 'improving'
  if (normalizedSlope < -0.1) return 'declining'
  return 'stable'
}

// Estimation Accuracy

function calculateOverallAccuracy(outcomes: Outcome[], tolerance: number): number {
  const withEstimates = outcomes.filter((o) => o.variance)
  if (withEstimates.length === 0) return 0

  const accurate = withEstimates.filter((o) => {
    const variancePct = parseVariancePercent(o)
    return Math.abs(variancePct) <= tolerance
  })

  return Math.round((accurate.length / withEstimates.length) * 100)
}

function calculateAverageVelocity(sprints: SprintVelocity[]): number {
  if (sprints.length === 0) return 0
  const total = sprints.reduce((sum, s) => sum + s.pointsCompleted, 0)
  return Math.round((total / sprints.length) * 10) / 10
}

// Estimation Pattern Detection

function detectEstimationPatterns(outcomes: Outcome[]): {
  overEstimated: EstimationPattern[]
  underEstimated: EstimationPattern[]
} {
  // Group by tags/categories
  const byCategory = new Map<string, { variances: number[]; count: number }>()

  for (const outcome of outcomes) {
    if (!outcome.variance) continue
    const variancePct = parseVariancePercent(outcome)

    // Use tags as categories, fall back to 'uncategorized'
    const categories = outcome.tags && outcome.tags.length > 0 ? outcome.tags : ['uncategorized']

    for (const category of categories) {
      if (!byCategory.has(category)) {
        byCategory.set(category, { variances: [], count: 0 })
      }
      const entry = byCategory.get(category)!
      entry.variances.push(variancePct)
      entry.count++
    }
  }

  const overEstimated: EstimationPattern[] = []
  const underEstimated: EstimationPattern[] = []

  for (const [category, data] of byCategory) {
    if (data.count < 2) continue // Need at least 2 data points

    const avg = Math.round(data.variances.reduce((a, b) => a + b, 0) / data.variances.length)

    if (avg > 10) {
      // Actual took longer than estimated → under-estimated
      underEstimated.push({ category, avgVariance: avg, taskCount: data.count })
    } else if (avg < -10) {
      // Actual was faster than estimated → over-estimated
      overEstimated.push({ category, avgVariance: Math.abs(avg), taskCount: data.count })
    }
  }

  // Sort by severity
  overEstimated.sort((a, b) => b.avgVariance - a.avgVariance)
  underEstimated.sort((a, b) => b.avgVariance - a.avgVariance)

  return { overEstimated, underEstimated }
}

// Helpers

/**
 * Parse variance from an outcome into a percentage.
 * Handles both string format ("+30m") and the presence of estimatedDuration.
 */
function parseVariancePercent(outcome: Outcome): number {
  if (!outcome.variance) return 0

  const estimated = parseDurationMinutes(outcome.estimatedDuration)
  const actual = parseDurationMinutes(outcome.actualDuration)

  if (estimated <= 0) return 0

  return Math.round(((actual - estimated) / estimated) * 100)
}

// Re-export for backward compatibility
export { parseDurationMinutes }

/**
 * Format velocity for LLM context injection.
 */
export function formatVelocityContext(metrics: VelocityMetrics): string {
  if (metrics.sprints.length === 0) {
    return 'No velocity data available yet.'
  }

  const lines: string[] = []
  lines.push(
    `Project velocity: ${metrics.averageVelocity} pts/sprint (trend: ${metrics.velocityTrend})`
  )
  lines.push(`Estimation accuracy: ${metrics.estimationAccuracy}%`)

  for (const pattern of metrics.underEstimated) {
    lines.push(
      `⚠ "${pattern.category}" tasks historically take ${pattern.avgVariance}% longer than estimated`
    )
  }

  for (const pattern2 of metrics.overEstimated) {
    lines.push(
      `"${pattern2.category}" tasks typically finish ${pattern2.avgVariance}% faster than estimated`
    )
  }

  return lines.join('\n')
}

/** Fibonacci points with typical minutes for points derivation */
const FIBONACCI_MINUTES: Array<{ points: number; typical: number }> = [
  { points: 1, typical: 10 },
  { points: 2, typical: 20 },
  { points: 3, typical: 45 },
  { points: 5, typical: 90 },
  { points: 8, typical: 180 },
  { points: 13, typical: 360 },
  { points: 21, typical: 720 },
]

/**
 * Derive story points from an outcome's estimated duration.
 * Maps to nearest Fibonacci point using the standard points-to-minutes table.
 */
function derivePoints(outcome: Outcome): number {
  if (!outcome.estimatedDuration) return 0

  const minutes = parseDurationMinutes(outcome.estimatedDuration)
  if (minutes <= 0) return 0

  const closest = FIBONACCI_MINUTES.reduce((best, entry) =>
    Math.abs(entry.typical - minutes) < Math.abs(best.typical - minutes) ? entry : best
  )

  return closest.points
}

function resolveConfig(config: VelocityConfig): Required<VelocityConfig> {
  return {
    sprintLengthDays: config.sprintLengthDays ?? 7,
    startDay: config.startDay ?? 'monday',
    windowSize: config.windowSize ?? 6,
    accuracyTolerance: config.accuracyTolerance ?? 20,
  }
}
