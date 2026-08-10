/**
 * Fibonacci Estimation Module Tests
 */

import { describe, expect, it } from 'bun:test'
import { FIBONACCI_POINTS } from '../../constants/algorithms'
import {
  findClosestPoint,
  formatMinutes,
  isValidPoint,
  pointsToMinutes,
  pointsToTimeRange,
} from '../../domain/fibonacci'

describe('Fibonacci Estimation', () => {
  describe('FIBONACCI_POINTS', () => {
    it('should contain the standard Fibonacci sequence', () => {
      expect(FIBONACCI_POINTS).toEqual([1, 2, 3, 5, 8, 13, 21])
    })
  })

  describe('isValidPoint', () => {
    it('should accept valid Fibonacci points', () => {
      for (const p of FIBONACCI_POINTS) {
        expect(isValidPoint(p)).toBe(true)
      }
    })

    it('should reject non-Fibonacci numbers', () => {
      expect(isValidPoint(0)).toBe(false)
      expect(isValidPoint(4)).toBe(false)
      expect(isValidPoint(6)).toBe(false)
      expect(isValidPoint(10)).toBe(false)
      expect(isValidPoint(22)).toBe(false)
    })
  })

  describe('pointsToMinutes', () => {
    it('should return min/max/typical for each point', () => {
      const result = pointsToMinutes(1)
      expect(result).toEqual({ min: 5, max: 15, typical: 10 })
    })

    it('should scale up with larger points', () => {
      const small = pointsToMinutes(1)
      const large = pointsToMinutes(21)
      expect(large.typical).toBeGreaterThan(small.typical)
    })

    it('should have increasing typical times across the scale', () => {
      for (const [index, point] of FIBONACCI_POINTS.entries()) {
        const previous = index === 0 ? 0 : pointsToMinutes(FIBONACCI_POINTS[index - 1]!).typical
        expect(pointsToMinutes(point).typical).toBeGreaterThan(previous)
      }
    })
  })

  describe('formatMinutes', () => {
    it('should format sub-hour durations', () => {
      expect(formatMinutes(30)).toBe('30m')
      expect(formatMinutes(5)).toBe('5m')
    })

    it('should format exact hours', () => {
      expect(formatMinutes(60)).toBe('1h')
      expect(formatMinutes(120)).toBe('2h')
    })

    it('should format hours and minutes', () => {
      expect(formatMinutes(90)).toBe('1h 30m')
      expect(formatMinutes(150)).toBe('2h 30m')
    })
  })

  describe('pointsToTimeRange', () => {
    it('should return formatted range string', () => {
      expect(pointsToTimeRange(1)).toBe('5m–15m')
      expect(pointsToTimeRange(5)).toBe('1h–2h')
    })
  })

  describe('findClosestPoint', () => {
    it('should find exact matches for typical times', () => {
      expect(findClosestPoint(10)).toBe(1)
      expect(findClosestPoint(20)).toBe(2)
      expect(findClosestPoint(45)).toBe(3)
      expect(findClosestPoint(90)).toBe(5)
      expect(findClosestPoint(180)).toBe(8)
      expect(findClosestPoint(360)).toBe(13)
      expect(findClosestPoint(720)).toBe(21)
    })

    it('should find closest point for in-between values', () => {
      // 15 minutes is equidistant between 1 (10m) and 2 (20m) — picks first match
      expect(findClosestPoint(15)).toBe(1)
      // 16 minutes is closer to 2 (20m) than 1 (10m)
      expect(findClosestPoint(16)).toBe(2)
      // 35 minutes is closer to 3 (45m) than 2 (20m)
      expect(findClosestPoint(35)).toBe(3)
    })

    it('should return 1 for very small durations', () => {
      expect(findClosestPoint(1)).toBe(1)
      expect(findClosestPoint(0)).toBe(1)
    })

    it('should return 21 for very large durations', () => {
      expect(findClosestPoint(1000)).toBe(21)
    })
  })
})
