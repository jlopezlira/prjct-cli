/**
 * Date Helper - Centralized date operations and formatting
 *
 * Eliminates duplicated date logic across:
 * - session-manager.ts (_getDateKey, _getTodayKey)
 * - path-manager.ts (getSessionPath date formatting)
 * - commands.ts (38+ inline date operations)
 */

import type { DateComponents } from '../types/utils'

/**
 * Format a date to YYYY-MM-DD format
 */
export function formatDate(date: Date): string {
  const year = date.getFullYear()
  const month = (date.getMonth() + 1).toString().padStart(2, '0')
  const day = date.getDate().toString().padStart(2, '0')
  return `${year}-${month}-${day}`
}

/**
 * Format a date to YYYY-MM format
 */
export function formatMonth(date: Date): string {
  const year = date.getFullYear()
  const month = (date.getMonth() + 1).toString().padStart(2, '0')
  return `${year}-${month}`
}

/**
 * Get date key for today (YYYY-MM-DD)
 */
export function getTodayKey(): string {
  return formatDate(new Date())
}

/**
 * Get date key for any date (YYYY-MM-DD)
 * Alias for formatDate for consistency with session-manager
 */
export function getDateKey(date: Date): string {
  return formatDate(date)
}

/**
 * Get year, month, day components from a date
 * Useful for path construction
 */
export function getYearMonthDay(date: Date): DateComponents {
  return {
    year: date.getFullYear().toString(),
    month: (date.getMonth() + 1).toString().padStart(2, '0'),
    day: date.getDate().toString().padStart(2, '0'),
  }
}

/**
 * Parse a date string to Date object
 * Supports: YYYY-MM-DD, YYYY-MM, ISO strings
 */
export function parseDate(dateString: string): Date {
  return new Date(dateString)
}

/**
 * Get current timestamp in ISO format
 */
export function getTimestamp(): string {
  return new Date().toISOString()
}

/**
 * Get date N days ago from today
 */
export function getDaysAgo(days: number): Date {
  const date = new Date()
  date.setDate(date.getDate() - days)
  return date
}

/** ISO-string form of {@link getDaysAgo} — the shape most SQL window queries want. */
export function sinceIso(days: number): string {
  return getDaysAgo(days).toISOString()
}

/** `null` unless `value` is a finite, positive number — collapses the common
 *  "0/undefined/NaN all mean absent" check into one call. */
export function nullableNumber(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null
}

/** Whole minutes between two ISO timestamps, or `null` if either is missing/invalid/inverted. */
export function durationMinutes(
  start: string | null | undefined,
  end: string | null | undefined
): number | null {
  if (!start || !end) return null
  const started = Date.parse(start)
  const ended = Date.parse(end)
  if (!Number.isFinite(started) || !Number.isFinite(ended) || ended < started) return null
  return Math.round((ended - started) / 60_000)
}

/**
 * Get date N days from today
 */
export function getDaysFromNow(days: number): Date {
  const date = new Date()
  date.setDate(date.getDate() + days)
  return date
}

/**
 * Get date range between two dates
 */
export function getDateRange(fromDate: Date, toDate: Date): Date[] {
  const dayCount = Math.max(0, Math.floor((toDate.getTime() - fromDate.getTime()) / 86_400_000) + 1)
  return Array.from({ length: dayCount }, (_, offset) => {
    const date = new Date(fromDate)
    date.setDate(date.getDate() + offset)
    return date
  }).filter((date) => date <= toDate)
}

/**
 * Check if a date is today
 */
export function isToday(date: Date): boolean {
  return formatDate(date) === getTodayKey()
}

/**
 * Check if a date is within the last N days
 */
export function isWithinLastDays(date: Date, days: number): boolean {
  const threshold = getDaysAgo(days)
  return date >= threshold
}

/**
 * Format duration in human-readable format
 */
export function formatDuration(milliseconds: number): string {
  const seconds = Math.floor(milliseconds / 1000)
  const minutes = Math.floor(seconds / 60)
  const hours = Math.floor(minutes / 60)
  const days = Math.floor(hours / 24)

  if (days > 0) {
    return `${days}d ${hours % 24}h`
  }
  if (hours > 0) {
    return `${hours}h ${minutes % 60}m`
  }
  if (minutes > 0) {
    return `${minutes}m`
  }
  return `${seconds}s`
}

/**
 * Calculate duration between two dates
 */
export function calculateDuration(startDate: Date, endDate: Date = new Date()): string {
  const milliseconds = endDate.getTime() - startDate.getTime()
  return formatDuration(milliseconds)
}

/**
 * Get start of day (00:00:00.000)
 */
export function getStartOfDay(date: Date): Date {
  const result = new Date(date)
  result.setHours(0, 0, 0, 0)
  return result
}

/**
 * Get end of day (23:59:59.999)
 */
export function getEndOfDay(date: Date): Date {
  const result = new Date(date)
  result.setHours(23, 59, 59, 999)
  return result
}

/**
 * Largest-to-smallest unit thresholds (in seconds) for relative formatting.
 * Months are 30 days, years 365 days — same approximation date-fns'
 * `formatDistanceToNowStrict` used, so output matches ("2 months ago" etc.).
 */
const RELATIVE_UNITS: ReadonlyArray<readonly [Intl.RelativeTimeFormatUnit, number]> = [
  ['year', 31_536_000],
  ['month', 2_592_000],
  ['day', 86_400],
  ['hour', 3_600],
  ['minute', 60],
  ['second', 1],
]
const RELATIVE_FMT = new Intl.RelativeTimeFormat('en', { numeric: 'always' })

/**
 * Convert a date/timestamp to a relative string (e.g. "5 minutes ago").
 * Single-unit, strict rounding (rounds the absolute magnitude, then signs it)
 * via the built-in `Intl.RelativeTimeFormat` — no dependency, works on Bun and
 * Node alike. Replaces date-fns' `formatDistanceToNowStrict` (one call site,
 * one fewer dependency); output is identical for whole-unit deltas.
 */
export function toRelative(date: string | Date): string {
  const d = typeof date === 'string' ? new Date(date) : date
  const deltaSec = Math.round((d.getTime() - Date.now()) / 1000)
  const past = deltaSec <= 0
  const abs = Math.abs(deltaSec)
  for (const [unit, secs] of RELATIVE_UNITS) {
    if (abs >= secs || unit === 'second') {
      const value = Math.round(abs / secs)
      return RELATIVE_FMT.format(past ? -value : value, unit)
    }
  }
  return RELATIVE_FMT.format(0, 'second')
}

/**
 * Parse a `retro`/`skill-adherence`-style window spec: `<n><h|d>` (e.g.
 * `24h`, `7d`), defaulting to `7d` when `arg` is null. Rejects malformed
 * input and out-of-range magnitudes (`n <= 0` or `n > 365`) with `null`.
 *
 * Just the parsing core — callers build their own richer return shape
 * (e.g. a resolved `sinceIso`/label) from `{ n, unit }`.
 */
export function parseWindowSpec(arg: string | null): { n: number; unit: 'h' | 'd' } | null {
  const raw = (arg ?? '7d').trim().toLowerCase()
  const m = raw.match(/^(\d+)\s*([hd])$/)
  if (!m) return null
  const n = Number.parseInt(m[1], 10)
  if (!Number.isFinite(n) || n <= 0 || n > 365) return null
  return { n, unit: m[2] as 'h' | 'd' }
}

/**
 * Parse a duration string like "2h 30m" or "45s" to minutes.
 * Supports: "2h", "30m", "1h 30m", "2h30m", "90m", "45s" (rounds up to 1m)
 */
export function parseDurationMinutes(duration: string): number {
  const hourMatch = duration.match(/(\d+)h/)
  const minMatch = duration.match(/(\d+)m/)
  const secMatch = duration.match(/(\d+)s/)
  const minutes =
    (hourMatch ? Number.parseInt(hourMatch[1], 10) * 60 : 0) +
    (minMatch ? Number.parseInt(minMatch[1], 10) : 0)
  return secMatch && minutes === 0 ? 1 : minutes
}
