/**
 * Cache Utilities - Shared caching primitives for storage layers
 *
 * Provides two cache implementations:
 * - TTLCache: Time-based cache with LRU eviction (for StorageManager)
 * - LazyCache: Single-project lazy loading cache (for memory system)
 */

import type { CacheEntry, CacheOptions, CacheStats } from '../types/utils'

/**
 * Check if a timestamp has exceeded a TTL threshold.
 * Accepts both ISO string timestamps and numeric (epoch ms) timestamps.
 */
export function isExpired(timestamp: string | number, ttlMs: number): boolean {
  const ts = typeof timestamp === 'string' ? new Date(timestamp).getTime() : timestamp
  return Date.now() - ts > ttlMs
}

/**
 * TTL Cache with LRU eviction
 *
 * Used by StorageManager for project-keyed caching.
 * Automatically evicts expired entries and oldest entries when over capacity.
 */
export class TTLCache<T> {
  private cache = new Map<string, CacheEntry<T>>()
  private readonly ttl: number
  private readonly maxSize: number

  constructor(options: CacheOptions = {}) {
    this.ttl = options.ttl ?? 5000
    this.maxSize = options.maxSize ?? 50
  }

  /**
   * Check if entry exists and is not expired
   */
  isValid(key: string): boolean {
    const entry = this.cache.get(key)
    if (!entry) return false
    return Date.now() - entry.timestamp < this.ttl
  }

  /**
   * Get entry if valid, otherwise null
   */
  get(key: string): T | null {
    const entry = this.cache.get(key)

    if (!entry) return null

    if (!this.isValid(key)) {
      this.cache.delete(key)
      return null
    }

    return entry.data
  }

  /**
   * Set entry with current timestamp
   */
  set(key: string, data: T): void {
    this.cache.set(key, { data, timestamp: Date.now() })
    this.evictOldEntries()
  }

  /**
   * Delete entry
   */
  delete(key: string): void {
    this.cache.delete(key)
  }

  /**
   * Clear all entries
   */
  clear(): void {
    this.cache.clear()
  }

  /**
   * Check if key exists (may be expired)
   */
  has(key: string): boolean {
    return this.cache.has(key)
  }

  /**
   * Get number of entries (including expired)
   */
  get size(): number {
    return this.cache.size
  }

  /**
   * Evict oldest entries if over max size
   */
  private evictOldEntries(): void {
    if (this.cache.size <= this.maxSize) return

    const entries = Array.from(this.cache.entries()).sort((a, b) => a[1].timestamp - b[1].timestamp)

    const toRemove = entries.slice(0, this.cache.size - this.maxSize)
    for (const [key] of toRemove) {
      this.cache.delete(key)
    }
  }

  /**
   * Get cache statistics
   */
  stats(): CacheStats {
    return {
      size: this.cache.size,
      maxSize: this.maxSize,
      ttl: this.ttl,
    }
  }

  /**
   * Remove all expired entries
   */
  prune(): number {
    const expired = [...this.cache.keys()].filter((key) => !this.isValid(key))
    for (const key of expired) this.cache.delete(key)
    return expired.length
  }
}
