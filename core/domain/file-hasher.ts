/**
 * File Hasher — Fast Content Hashing with SQLite Registry
 *
 * Computes content hashes for all project files and stores them in SQLite.
 * On subsequent syncs, compares current hashes against stored hashes
 * to identify added, modified, and deleted files.
 *
 * Uses Bun.hash (xxHash) for speed — <100ms for 500 files.
 *
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import prjctDb from '../storage/database'
import type { FileDiff, FileHash } from '../types/domain.js'
import { batchProcess, walkDir } from '../utils/file-helper'

// Hashing

/**
 * Compute a fast hash of file content using Bun.hash (xxHash64).
 * Falls back to a simple checksum if Bun.hash is unavailable.
 */
function hashContent(content: string): string {
  // Bun.hash returns a bigint (xxHash64) — extremely fast
  if (typeof Bun !== 'undefined' && Bun.hash) {
    return `xxh64:${Bun.hash(content).toString(36)}`
  }
  // Fallback: simple FNV-1a 32-bit hash (still fast, no crypto overhead)
  const h = [...content].reduce(
    (hash, character) => Math.imul(hash ^ character.charCodeAt(0), 0x01000193),
    0x811c9dc5
  )
  return `fnv1a:${(h >>> 0).toString(36)}`
}

/**
 * Compute hashes for all project files.
 * Processes files in parallel batches for speed.
 *
 * Performance target: <100ms for 500 files.
 */
interface ComputeHashesOptions {
  /** Previous registry from SQLite. Unchanged files reuse the old checksum. */
  storedHashes?: Map<string, FileHash>
  /** Optional exact file set that the caller already knows changed. */
  changedFilesHint?: string[]
}

export async function computeHashes(
  projectPath: string,
  options: ComputeHashesOptions = {}
): Promise<Map<string, FileHash>> {
  const filePaths = await walkDir(projectPath, {
    skipDotfiles: true,
    dotfileAllowlist: ['.env.example'],
  })
  const hashes = new Map<string, FileHash>()
  const hinted = options.changedFilesHint?.length ? new Set(options.changedFilesHint) : null

  const results = await batchProcess(filePaths, 100, async (filePath) => {
    try {
      const fullPath = path.join(projectPath, filePath)
      const stat = await fs.stat(fullPath)
      const mtime = stat.mtime.toISOString()
      const previous = options.storedHashes?.get(filePath)
      const hintSaysChanged = hinted?.has(filePath) ?? false

      if (
        previous &&
        !hintSaysChanged &&
        previous.size === stat.size &&
        previous.mtime === mtime &&
        previous.hash
      ) {
        return {
          path: filePath,
          hash: previous.hash,
          size: stat.size,
          mtime,
        } satisfies FileHash
      }

      const content = await fs.readFile(fullPath, 'utf-8')
      return {
        path: filePath,
        hash: hashContent(content),
        size: stat.size,
        mtime,
      } satisfies FileHash
    } catch {
      return null
    }
  })

  for (const result of results) {
    hashes.set(result.path, result)
  }

  return hashes
}

// Diff Detection

/**
 * Compare current file hashes against stored registry.
 * Returns lists of added, modified, deleted, and unchanged files.
 */
export function diffHashes(
  current: Map<string, FileHash>,
  stored: Map<string, FileHash>
): FileDiff {
  const added: string[] = []
  const modified: string[] = []
  const unchanged: string[] = []

  for (const [filePath, currentHash] of current) {
    const storedHash = stored.get(filePath)
    if (!storedHash) {
      added.push(filePath)
    } else if (storedHash.hash !== currentHash.hash) {
      modified.push(filePath)
    } else {
      unchanged.push(filePath)
    }
  }

  const deleted: string[] = []
  for (const filePath of stored.keys()) {
    if (!current.has(filePath)) {
      deleted.push(filePath)
    }
  }

  return { added, modified, deleted, unchanged }
}

// SQLite Persistence (uses index_checksums table)

/**
 * Save file hashes to SQLite index_checksums table.
 */
export function saveHashes(projectId: string, hashes: Map<string, FileHash>): void {
  const db = prjctDb.getDb(projectId)

  db.transaction(() => {
    // Clear existing checksums
    db.prepare('DELETE FROM index_checksums').run()

    // Insert all hashes
    const insert = db.prepare(
      'INSERT INTO index_checksums (path, checksum, size, mtime) VALUES (?, ?, ?, ?)'
    )

    for (const [, hash] of hashes) {
      insert.run(hash.path, hash.hash, hash.size, hash.mtime)
    }
  })()

  // Also store metadata about when hashes were computed
  prjctDb.setDoc(projectId, 'file-hashes-meta', {
    fileCount: hashes.size,
    builtAt: new Date().toISOString(),
  })
}

/**
 * Load file hashes from SQLite. Internal — invoked from `detectChanges`.
 */
function loadHashes(projectId: string): Map<string, FileHash> {
  const hashes = new Map<string, FileHash>()
  try {
    const rows = prjctDb.query<{ path: string; checksum: string; size: number; mtime: string }>(
      projectId,
      'SELECT path, checksum, size, mtime FROM index_checksums'
    )
    for (const row of rows) {
      hashes.set(row.path, {
        path: row.path,
        hash: row.checksum,
        size: row.size || 0,
        mtime: row.mtime || '',
      })
    }
  } catch {
    // Table might not exist yet or be empty
  }
  return hashes
}

// High-level API

/**
 * Compute file hashes and diff against stored registry.
 * Returns the diff and the current hashes (for saving after sync completes).
 *
 * If no stored hashes exist (first sync), all files are "added".
 */
export async function detectChanges(
  projectPath: string,
  projectId: string,
  changedFilesHint?: string[]
): Promise<{ diff: FileDiff; currentHashes: Map<string, FileHash> }> {
  const storedHashes = loadHashes(projectId)
  const currentHashes = await computeHashes(projectPath, { storedHashes, changedFilesHint })

  const diff = diffHashes(currentHashes, storedHashes)

  return { diff, currentHashes }
}

/**
 * Check if a hash registry exists for this project.
 */
export function hasHashRegistry(projectId: string): boolean {
  return prjctDb.hasDoc(projectId, 'file-hashes-meta')
}
