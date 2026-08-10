/**
 * Retry Policy Utility
 *
 * Provides exponential backoff retry logic with error classification and circuit breaker.
 * Used to make agent and tool operations resilient against transient failures.
 *
 */

import type { CircuitState, RetryOptions } from '../types/utils.js'

// Error Classification

/**
 * Node.js error codes that indicate transient failures worth retrying
 */
const TRANSIENT_ERROR_CODES = new Set([
  'EBUSY', // Resource busy
  'EAGAIN', // Resource temporarily unavailable
  'ETIMEDOUT', // Operation timed out
  'ECONNRESET', // Connection reset by peer
  'ECONNREFUSED', // Connection refused (may be temporary)
  'ENOTFOUND', // DNS lookup failed (may be temporary)
  'EAI_AGAIN', // DNS temporary failure
])

/**
 * Node.js error codes that indicate permanent failures (fail fast)
 */
const PERMANENT_ERROR_CODES = new Set([
  'ENOENT', // No such file or directory
  'EACCES', // Permission denied
  'EPERM', // Operation not permitted
  'EISDIR', // Is a directory
  'ENOTDIR', // Not a directory
  'EINVAL', // Invalid argument
])

/**
 * Check if an error is transient (worth retrying)
 */
export function isTransientError(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false
  }

  const err = error as { code?: string; errno?: number; message?: string }

  // Check error code
  if (err.code && TRANSIENT_ERROR_CODES.has(err.code)) {
    return true
  }

  // Permanent errors should never be retried
  if (err.code && PERMANENT_ERROR_CODES.has(err.code)) {
    return false
  }

  // Check message for timeout indicators
  if (err.message) {
    const msg = err.message.toLowerCase()
    if (msg.includes('timeout') || msg.includes('timed out')) {
      return true
    }
  }

  // Unknown errors are not retried by default (fail fast)
  return false
}

/**
 * Check if an error is permanent (should not retry)
 */
export function isPermanentError(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false
  }

  const err = error as { code?: string }
  return !!(err.code && PERMANENT_ERROR_CODES.has(err.code))
}

// Circuit Breaker

/**
 * Circuit breaker state registry (per operation ID)
 */
const circuitStates = new Map<string, CircuitState>()

/**
 * Check if circuit is open for a given operation
 */
function isCircuitOpen(operationId: string, threshold: number, timeoutMs: number): boolean {
  const state = circuitStates.get(operationId)
  if (!state) {
    return false
  }

  // Circuit is open if threshold exceeded
  if (state.consecutiveFailures >= threshold && state.openedAt) {
    const elapsed = Date.now() - state.openedAt
    // Circuit closes after timeout
    if (elapsed >= timeoutMs) {
      // Reset circuit
      circuitStates.delete(operationId)
      return false
    }
    return true
  }

  return false
}

/**
 * Record a failure for circuit breaker
 */
function recordFailure(operationId: string, threshold: number): void {
  const state = circuitStates.get(operationId) || {
    consecutiveFailures: 0,
    openedAt: null,
  }

  state.consecutiveFailures++

  // Open circuit if threshold reached
  if (state.consecutiveFailures >= threshold && !state.openedAt) {
    state.openedAt = Date.now()
  }

  circuitStates.set(operationId, state)
}

/**
 * Record a success (reset circuit breaker)
 */
function recordSuccess(operationId: string): void {
  circuitStates.delete(operationId)
}

/**
 * Clear ALL circuit-breaker state. Intended for test isolation: the
 * `circuitStates` map is a module-level singleton shared across every
 * RetryPolicy instance, so without a reset between tests one suite's
 * failures (e.g. `agent-initialization` failing because no agent is
 * installed on a CI runner) accumulate past the threshold and open the
 * breaker, cascading "circuit breaker is open" into every later test that
 * touches the same operation. A global test `beforeEach` calls this so each
 * test starts with a clean breaker — making the suite order-independent.
 */
export function resetCircuitBreakers(): void {
  circuitStates.clear()
}

// Retry Policy

export class RetryPolicy {
  private options: Required<RetryOptions>

  constructor(options: Partial<RetryOptions> = {}) {
    this.options = {
      maxAttempts: options.maxAttempts ?? 3,
      baseDelayMs: options.baseDelayMs ?? 1000,
      maxDelayMs: options.maxDelayMs ?? 8000,
      circuitBreakerThreshold: options.circuitBreakerThreshold ?? 5,
      circuitBreakerTimeoutMs: options.circuitBreakerTimeoutMs ?? 60000,
    }
  }

  /**
   * Execute an operation with retry logic
   *
   * @param operation - Async function to execute
   * @param operationId - Optional ID for circuit breaker tracking
   * @returns Result of the operation
   * @throws Error if all attempts fail or circuit is open
   */
  async execute<T>(operation: () => Promise<T>, operationId: string = 'default'): Promise<T> {
    // Check circuit breaker
    if (
      isCircuitOpen(
        operationId,
        this.options.circuitBreakerThreshold,
        this.options.circuitBreakerTimeoutMs
      )
    ) {
      throw new Error(
        `Circuit breaker is open for operation: ${operationId}. Too many consecutive failures.`
      )
    }

    const executeAttempt = async (attempt: number): Promise<T> => {
      try {
        const result = await operation()
        // Success - reset circuit breaker
        recordSuccess(operationId)
        return result
      } catch (error) {
        if (isPermanentError(error)) {
          recordFailure(operationId, this.options.circuitBreakerThreshold)
          throw error
        }

        const shouldRetry = isTransientError(error) && attempt < this.options.maxAttempts

        if (!shouldRetry) {
          // Not transient or out of attempts
          recordFailure(operationId, this.options.circuitBreakerThreshold)
          throw error
        }

        // Calculate delay with exponential backoff
        const delay = Math.min(
          this.options.baseDelayMs * 2 ** (attempt - 1),
          this.options.maxDelayMs
        )

        // Wait before retry
        await new Promise((resolve) => setTimeout(resolve, delay))
        return executeAttempt(attempt + 1)
      }
    }
    return executeAttempt(1)
  }

  /**
   * Check if an error is transient (exposed for testing)
   */
  isTransientError(error: unknown): boolean {
    return isTransientError(error)
  }

  /**
   * Check if circuit is open for an operation (exposed for testing)
   */
  isCircuitOpen(operationId: string): boolean {
    return isCircuitOpen(
      operationId,
      this.options.circuitBreakerThreshold,
      this.options.circuitBreakerTimeoutMs
    )
  }

  /**
   * Get current circuit state for an operation (exposed for testing)
   */
  getCircuitState(operationId: string): CircuitState | undefined {
    return circuitStates.get(operationId)
  }

  /**
   * Reset circuit breaker for an operation (exposed for testing)
   */
  resetCircuit(operationId: string): void {
    circuitStates.delete(operationId)
  }

  /**
   * Reset all circuit breakers (exposed for testing)
   */
  resetAllCircuits(): void {
    circuitStates.clear()
  }
}

// Exports

/**
 * Default retry policy for agent operations
 * - 3 attempts
 * - 1s base delay
 * - Up to 8s max delay
 */
export const defaultAgentRetryPolicy = new RetryPolicy({
  maxAttempts: 3,
  baseDelayMs: 1000,
  maxDelayMs: 8000,
})

/**
 * Retry policy for tool operations (less aggressive)
 * - 2 attempts
 * - 500ms base delay
 * - Up to 2s max delay
 */
export const defaultToolRetryPolicy = new RetryPolicy({
  maxAttempts: 2,
  baseDelayMs: 500,
  maxDelayMs: 2000,
})
