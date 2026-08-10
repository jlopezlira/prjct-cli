/**
 * Fibonacci Estimation Module
 *
 * Provides Fibonacci-based story point estimation with
 * points-to-time conversion and historical suggestion.
 */

import { FIBONACCI_MINUTES_MAP, FIBONACCI_POINTS } from '../constants/algorithms'
import type { FibonacciPoint } from '../types/domain.js'

// Validation

/** Check if a number is a valid Fibonacci point */
export const isValidPoint = (n: number): n is FibonacciPoint =>
  FIBONACCI_POINTS.includes(n as FibonacciPoint)

// Points-to-Time Conversion

/** Get the time range for a given point value */
export const pointsToMinutes = (
  points: FibonacciPoint
): { min: number; max: number; typical: number } => {
  return FIBONACCI_MINUTES_MAP[points]
}

/** Format a minute count as a human-readable duration */
export const formatMinutes = (minutes: number): string => {
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  const mins = minutes % 60
  return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`
}

/** Get a human-readable time range for a point value */
export const pointsToTimeRange = (points: FibonacciPoint): string => {
  const range = pointsToMinutes(points)
  return `${formatMinutes(range.min)}–${formatMinutes(range.max)}`
}

/**
 * Historical suggestion was backed by `outcomeRecorder`, which had zero
 * write callsites anywhere in the codebase — the data source was always
 * empty. Stubbed to always return null so the CLI path stays alive but
 * doesn't pretend to have history. If we revive an outcome feed later
 * (e.g. driven by the Stop hook), this is where the query goes.
 */
export const suggestFromHistory = async (
  _projectId: string,
  _taskType: string
): Promise<{ points: FibonacciPoint; basedOn: number } | null> => null

// Helpers

/** Find the Fibonacci point whose typical time is closest to the given minutes */
export const findClosestPoint = (minutes: number): FibonacciPoint => {
  return FIBONACCI_POINTS.reduce((closest, point) =>
    Math.abs(FIBONACCI_MINUTES_MAP[point].typical - minutes) <
    Math.abs(FIBONACCI_MINUTES_MAP[closest].typical - minutes)
      ? point
      : closest
  )
}
