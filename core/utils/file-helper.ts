import fs from 'node:fs/promises'
import path from 'node:path'
import { SKIP_DIRS } from '../constants/file-patterns'
import { safeRead } from '../storage/safe-reader'
import {
  describeFsWriteError,
  isNotFoundError,
  isPermissionError,
  isReadonlyError,
} from '../types/fs'
import type { ValidationSchema } from '../types/storage/extended'

/**
 * Run a write and, if it fails because the target is read-only / permission
 * denied (the sandboxed-agent case), rethrow with an actionable message.
 * Transient or other errors (ENOSPC, EBUSY, …) pass through untouched so
 * callers that inspect `error.code` keep working.
 */
async function withWriteErrorContext<T>(
  targetPath: string,
  subject: string,
  fn: () => Promise<T>
): Promise<T> {
  try {
    return await fn()
  } catch (error) {
    if (isReadonlyError(error) || isPermissionError(error)) {
      throw new Error(describeFsWriteError(error, targetPath, subject))
    }
    throw error
  }
}

/**
 * File Helper - Centralized file operations with error handling
 *
 * Eliminates duplicated fs operations across:
 * - 101 fs.readFile/writeFile calls in 18 files
 * - Consistent error handling
 * - JSON read/write patterns
 */

// Walk & Batch Utilities

interface WalkOptions {
  /** Skip files/dirs starting with '.' (default: false) */
  skipDotfiles?: boolean
  /** Allow specific dotfiles even when skipDotfiles is true */
  dotfileAllowlist?: string[]
  /** Stop collecting after N files */
  maxFiles?: number
}

/**
 * Recursively walk a directory and return relative file paths.
 *
 * Skips common non-source directories (node_modules, .git, dist, etc).
 * Returns paths relative to rootPath.
 */
export async function walkDir(rootPath: string, options: WalkOptions = {}): Promise<string[]> {
  const files: string[] = []
  const maxFiles = options.maxFiles ?? Infinity
  const allowSet = options.dotfileAllowlist ? new Set(options.dotfileAllowlist) : null

  async function walk(dir: string): Promise<void> {
    if (files.length >= maxFiles) return

    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => [])

    for (const entry of entries) {
      if (files.length >= maxFiles) break

      const name = String(entry.name)
      if (SKIP_DIRS.has(name)) continue

      // Dotfile handling
      if (options.skipDotfiles && name.startsWith('.')) {
        if (!allowSet || !allowSet.has(name)) continue
      }

      const fullPath = path.join(dir, name)
      if (entry.isDirectory()) {
        await walk(fullPath)
      } else if (entry.isFile()) {
        files.push(path.relative(rootPath, fullPath))
      }
    }
  }

  await walk(rootPath)
  return files
}

/**
 * Process items in parallel batches, collecting non-null results.
 */
export async function batchProcess<T, R>(
  items: T[],
  batchSize: number,
  fn: (item: T) => Promise<R | null>
): Promise<R[]> {
  const results: R[] = []
  const offsets = Array.from(
    { length: Math.ceil(items.length / batchSize) },
    (_, index) => index * batchSize
  )
  for (const i of offsets) {
    const batchResults = await Promise.all(items.slice(i, i + batchSize).map(fn))
    for (const r of batchResults) if (r !== null) results.push(r)
  }
  return results
}

// File Operations

interface ListFilesOptions {
  filesOnly?: boolean
  dirsOnly?: boolean
  extension?: string
}

/**
 * Read JSON file and parse.
 * When a Zod schema is provided, validates the data and creates a .backup on corruption.
 */
export async function readJson<T = unknown>(
  filePath: string,
  defaultValue: T | null = null,
  schema?: ValidationSchema
): Promise<T | null> {
  if (schema) {
    const data = await safeRead<T>(filePath, schema)
    return data ?? defaultValue
  }

  try {
    const content = await fs.readFile(filePath, 'utf-8')
    return JSON.parse(content) as T
  } catch (error) {
    if (isNotFoundError(error)) {
      return defaultValue
    }
    throw error
  }
}

/**
 * Write object to JSON file (pretty-printed)
 */
export async function writeJson(filePath: string, data: unknown, indent = 2): Promise<void> {
  await withWriteErrorContext(filePath, 'config', async () => {
    const dir = path.dirname(filePath)
    await fs.mkdir(dir, { recursive: true })
    const content = `${JSON.stringify(data, null, indent)}\n`
    await fs.writeFile(filePath, content, 'utf-8')
  })
}

/**
 * Read text file
 */
export async function readFile(filePath: string, defaultValue = ''): Promise<string> {
  try {
    return await fs.readFile(filePath, 'utf-8')
  } catch (error) {
    if (isNotFoundError(error)) {
      return defaultValue
    }
    throw error
  }
}

/**
 * Write text file
 */
export async function writeFile(filePath: string, content: string): Promise<void> {
  await withWriteErrorContext(filePath, 'file', async () => {
    const dir = path.dirname(filePath)
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(filePath, content, 'utf-8')
  })
}

/**
 * Atomic write: write to `<filePath>.tmp`, then rename onto `filePath`.
 * `fs.promises.rename` is atomic-overwrite on POSIX and Windows (Node 18+).
 *
 * Used when an external reader (e.g. the pre-commit hook reading
 * `.prjct/team.json`) must never observe a half-written file. The DB
 * row is the source of truth; this is the mirror writer.
 */
export async function writeFileAtomic(filePath: string, content: string): Promise<void> {
  await withWriteErrorContext(filePath, 'file', async () => {
    const dir = path.dirname(filePath)
    await fs.mkdir(dir, { recursive: true })
    const tmpPath = `${filePath}.tmp`
    await fs.writeFile(tmpPath, content, 'utf-8')
    await fs.rename(tmpPath, filePath)
  })
}

/**
 * Check if file exists
 */
export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath)
    return true
  } catch (error) {
    if (isNotFoundError(error)) {
      return false
    }
    throw error
  }
}

/**
 * Check if directory exists
 */
export async function dirExists(dirPath: string): Promise<boolean> {
  try {
    const stats = await fs.stat(dirPath)
    return stats.isDirectory()
  } catch (error) {
    if (isNotFoundError(error)) {
      return false
    }
    throw error
  }
}

/**
 * Ensure directory exists (create if not)
 */
export async function ensureDir(dirPath: string): Promise<void> {
  await fs.mkdir(dirPath, { recursive: true })
}

/**
 * List files in directory
 */
export async function listFiles(
  dirPath: string,
  options: ListFilesOptions = {}
): Promise<string[]> {
  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true })
    const files = entries
      .filter((entry) => !options.filesOnly || entry.isFile())
      .filter((entry) => !options.dirsOnly || entry.isDirectory())
      .filter((entry) => !options.extension || entry.name.endsWith(options.extension))

    return files.map((entry) => entry.name)
  } catch (error) {
    if (isNotFoundError(error)) {
      return []
    }
    throw error
  }
}
