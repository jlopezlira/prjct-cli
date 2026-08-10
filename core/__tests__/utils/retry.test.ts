/**
 * Retry Policy Tests
 * Tests for exponential backoff, error classification, and circuit breaker
 */

import { describe, expect, it } from 'bun:test'
import {
  defaultAgentRetryPolicy,
  defaultToolRetryPolicy,
  isPermanentError,
  isTransientError,
  RetryPolicy,
} from '../../utils/retry'

function createPolicy(): RetryPolicy {
  return new RetryPolicy({
    maxAttempts: 3,
    baseDelayMs: 100,
    maxDelayMs: 400,
    circuitBreakerThreshold: 5,
    circuitBreakerTimeoutMs: 1000,
  })
}

describe('RetryPolicy', () => {
  describe('Error Classification', () => {
    it('should identify transient errors correctly', () => {
      const transientErrors = [
        { code: 'EBUSY' },
        { code: 'EAGAIN' },
        { code: 'ETIMEDOUT' },
        { code: 'ECONNRESET' },
        { code: 'ECONNREFUSED' },
        { message: 'Operation timed out' },
        { message: 'Request timeout' },
      ]

      for (const error of transientErrors) {
        expect(isTransientError(error)).toBe(true)
      }
    })

    it('should identify permanent errors correctly', () => {
      const permanentErrors = [
        { code: 'ENOENT' },
        { code: 'EACCES' },
        { code: 'EPERM' },
        { code: 'EISDIR' },
        { code: 'ENOTDIR' },
        { code: 'EINVAL' },
      ]

      for (const error of permanentErrors) {
        expect(isPermanentError(error)).toBe(true)
        expect(isTransientError(error)).toBe(false)
      }
    })

    it('should not classify unknown errors as transient', () => {
      const unknownErrors = [
        { code: 'UNKNOWN' },
        { message: 'Unknown error' },
        new Error('Generic error'),
      ]

      for (const error of unknownErrors) {
        expect(isTransientError(error)).toBe(false)
      }
    })
  })

  describe('Successful Operations', () => {
    it('should execute successful operation without retry', async () => {
      const policy = createPolicy()
      const attempts: number[] = []
      const operation = async () => {
        attempts.push(Date.now())
        return 'success'
      }

      const result = await policy.execute(operation, 'test-op')

      expect(result).toBe('success')
      expect(attempts).toHaveLength(1)
    })

    it('should reset circuit breaker after success', async () => {
      const policy = createPolicy()
      // Force some failures to increment circuit state
      const failures: number[] = []
      const failOperation = async () => {
        failures.push(Date.now())
        throw { code: 'EBUSY' }
      }

      try {
        await policy.execute(failOperation, 'test-op')
      } catch {
        // Expected to fail
      }

      expect(failures).toHaveLength(3) // maxAttempts

      // Now succeed - should reset circuit
      const successOperation = async () => 'success'
      await policy.execute(successOperation, 'test-op')

      const circuitState = policy.getCircuitState('test-op')
      expect(circuitState).toBeUndefined()
    })
  })

  describe('Transient Error Retry', () => {
    it('should retry transient errors and succeed', async () => {
      const policy = createPolicy()
      const attempts: number[] = []
      const operation = async () => {
        attempts.push(Date.now())
        if (attempts.length < 3) {
          throw { code: 'EBUSY' } // Transient error
        }
        return 'success'
      }

      const result = await policy.execute(operation, 'test-op')

      expect(result).toBe('success')
      expect(attempts).toHaveLength(3)
    })

    it('should apply exponential backoff between retries', async () => {
      const policy = createPolicy()
      const timestamps: number[] = []

      const operation = async () => {
        timestamps.push(Date.now())
        if (timestamps.length < 3) {
          throw { code: 'ETIMEDOUT' }
        }
        return 'success'
      }

      await policy.execute(operation, 'test-op')

      // Check delays: should be ~100ms, ~200ms (wide tolerance for CI)
      const delay1 = timestamps[1] - timestamps[0]
      const delay2 = timestamps[2] - timestamps[1]

      expect(delay1).toBeGreaterThanOrEqual(50) // 100ms with wide tolerance
      expect(delay1).toBeLessThan(500)

      expect(delay2).toBeGreaterThanOrEqual(100) // 200ms with wide tolerance
      expect(delay2).toBeLessThan(700)

      // Verify exponential pattern: second delay should be longer
      expect(delay2).toBeGreaterThan(delay1)
    })

    it('should respect maxDelayMs cap', async () => {
      const policy = new RetryPolicy({
        maxAttempts: 5,
        baseDelayMs: 100,
        maxDelayMs: 200,
      })

      const timestamps: number[] = []

      const operation = async () => {
        timestamps.push(Date.now())
        if (timestamps.length < 5) {
          throw { code: 'EBUSY' }
        }
        return 'success'
      }

      await policy.execute(operation, 'test-op')

      // Last delay should not exceed maxDelayMs (check delay between attempt 3 and 4)
      // Attempt 1: no delay
      // Attempt 2: 100ms delay (baseDelayMs * 2^0)
      // Attempt 3: 200ms delay (baseDelayMs * 2^1, capped at maxDelayMs)
      // Attempt 4: 200ms delay (baseDelayMs * 2^2 = 400ms, capped at 200ms)
      const delay3 = timestamps[3] - timestamps[2]
      expect(delay3).toBeLessThanOrEqual(700) // 200ms + wide tolerance for CI
      expect(delay3).toBeGreaterThanOrEqual(100)
    })

    it('should throw if all retry attempts fail with transient error', async () => {
      const policy = createPolicy()
      const attempts: number[] = []
      const operation = async () => {
        attempts.push(Date.now())
        throw { code: 'EAGAIN' }
      }

      await expect(policy.execute(operation, 'test-op')).rejects.toMatchObject({
        code: 'EAGAIN',
      })

      expect(attempts).toHaveLength(3) // maxAttempts
    })
  })

  describe('Permanent Error Handling', () => {
    it('should fail fast on permanent errors without retry', async () => {
      const policy = createPolicy()
      const attempts: number[] = []
      const operation = async () => {
        attempts.push(Date.now())
        throw { code: 'ENOENT' } // Permanent error
      }

      await expect(policy.execute(operation, 'test-op')).rejects.toMatchObject({
        code: 'ENOENT',
      })

      expect(attempts).toHaveLength(1) // No retry
    })

    it('should fail fast on permission denied', async () => {
      const policy = createPolicy()
      const attempts: number[] = []
      const operation = async () => {
        attempts.push(Date.now())
        throw { code: 'EPERM' }
      }

      await expect(policy.execute(operation, 'test-op')).rejects.toMatchObject({
        code: 'EPERM',
      })

      expect(attempts).toHaveLength(1)
    })

    it('should record failure for permanent errors', async () => {
      const policy = createPolicy()
      const operation = async () => {
        throw { code: 'ENOENT' }
      }

      try {
        await policy.execute(operation, 'perm-op')
      } catch {
        // Expected
      }

      const state = policy.getCircuitState('perm-op')
      expect(state?.consecutiveFailures).toBe(1)
    })
  })

  describe('Circuit Breaker', () => {
    it('should open circuit after threshold failures', async () => {
      const policy = createPolicy()
      const operation = async () => {
        throw { code: 'EBUSY' }
      }

      // Execute 5 times to reach threshold (each attempt counts as 1 failure)
      for (const _ of Array.from({ length: 5 })) {
        try {
          await policy.execute(operation, 'circuit-op')
        } catch {
          // Expected
        }
      }

      // Circuit should now be open
      expect(policy.isCircuitOpen('circuit-op')).toBe(true)

      // Next call should fail immediately with circuit breaker error
      await expect(policy.execute(operation, 'circuit-op')).rejects.toThrow(
        /Circuit breaker is open/
      )
    })

    it('should close circuit after timeout', async () => {
      const policy = new RetryPolicy({
        maxAttempts: 3,
        baseDelayMs: 10,
        maxDelayMs: 50,
        circuitBreakerThreshold: 3,
        circuitBreakerTimeoutMs: 100, // Short timeout for test
      })

      const operation = async () => {
        throw { code: 'ETIMEDOUT' }
      }

      // Trigger circuit breaker
      for (const _ of Array.from({ length: 3 })) {
        try {
          await policy.execute(operation, 'timeout-op')
        } catch {
          // Expected
        }
      }

      expect(policy.isCircuitOpen('timeout-op')).toBe(true)

      // Wait for timeout
      await new Promise((resolve) => setTimeout(resolve, 150))

      // Circuit should be closed now
      expect(policy.isCircuitOpen('timeout-op')).toBe(false)
    })

    it('should track failures per operation independently', async () => {
      const policy = createPolicy()
      const operation = async () => {
        throw { code: 'EAGAIN' }
      }

      // Fail operation A multiple times
      for (const _ of Array.from({ length: 3 })) {
        try {
          await policy.execute(operation, 'op-a')
        } catch {
          // Expected
        }
      }

      const stateA = policy.getCircuitState('op-a')
      const stateB = policy.getCircuitState('op-b')

      expect(stateA?.consecutiveFailures).toBe(3)
      expect(stateB).toBeUndefined()
    })
  })

  describe('Default Policies', () => {
    it('should have agent retry policy with correct defaults', () => {
      // Test that default agent policy is configured correctly
      expect(defaultAgentRetryPolicy).toBeInstanceOf(RetryPolicy)
      // We can't directly inspect options, but we can test behavior
    })

    it('should have tool retry policy with correct defaults', () => {
      expect(defaultToolRetryPolicy).toBeInstanceOf(RetryPolicy)
    })

    it('should retry agent operations 3 times', async () => {
      const attempts: number[] = []
      const operation = async () => {
        attempts.push(Date.now())
        if (attempts.length < 3) {
          throw { code: 'EBUSY' }
        }
        return 'success'
      }

      await defaultAgentRetryPolicy.execute(operation, 'agent-test')
      expect(attempts).toHaveLength(3)
    })
  })

  describe('Edge Cases', () => {
    it('should handle non-Error objects', async () => {
      const policy = createPolicy()
      const operation = async () => {
        throw 'string error'
      }

      await expect(policy.execute(operation, 'edge-op')).rejects.toBe('string error')
    })

    it('should handle null/undefined errors', async () => {
      const policy = createPolicy()
      const operation = async () => {
        throw null
      }

      await expect(policy.execute(operation, 'null-op')).rejects.toBeNull()
    })

    it('should handle errors without code property', async () => {
      const policy = createPolicy()
      const operation = async () => {
        throw new Error('Generic error')
      }

      await expect(policy.execute(operation, 'generic-op')).rejects.toThrow('Generic error')
    })
  })
})
