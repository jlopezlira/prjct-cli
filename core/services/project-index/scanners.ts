/**
 * File / config / directory scanners for ProjectIndexer.
 *
 * Pure functions parameterized by `projectPath` so they don't need to
 * be class methods.
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import { CONFIG_FILES, SKIP_DIRS as IGNORE_DIRS } from '../../constants/file-patterns'
import { indexStorage } from '../../storage/index-storage'
import type { FileStats, IndexOptions } from '../../types/services.js'
import type { ConfigFileEntry, DirectoryEntry } from '../../types/storage/extended'
import { execAsync } from '../../utils/exec'
import { batchProcess, fileExists, walkDir } from '../../utils/file-helper'
import { classifyDirectory } from './analyzers'

export async function getFileStats(
  projectPath: string,
  relativePath: string
): Promise<FileStats | null> {
  const fullPath = path.join(projectPath, relativePath)
  try {
    const stat = await fs.stat(fullPath)
    const content = await fs.readFile(fullPath, 'utf-8')
    return {
      path: relativePath,
      size: stat.size,
      mtime: stat.mtime,
      lines: content.split('\n').length,
    }
  } catch {
    return null
  }
}

export async function scanAllFiles(
  projectPath: string,
  options: IndexOptions = {}
): Promise<Map<string, FileStats>> {
  const files = new Map<string, FileStats>()
  const maxFiles = options.maxFiles || 10000

  try {
    const excludeDirs = Array.from(IGNORE_DIRS)
      .map((d) => `-not -path "*/${d}/*"`)
      .join(' ')

    const { stdout } = await execAsync(`find . -type f ${excludeDirs} | head -n ${maxFiles}`, {
      cwd: projectPath,
      maxBuffer: 10 * 1024 * 1024,
    })

    const paths = stdout.trim().split('\n').filter(Boolean)
    const results = await batchProcess(paths, 100, (p) =>
      getFileStats(projectPath, p.replace(/^\.\//, ''))
    )
    for (const stats of results) {
      if (stats) files.set(stats.path, stats)
    }
  } catch {
    const paths = await walkDir(projectPath, { maxFiles })
    const results = await batchProcess(paths, 100, (p) => getFileStats(projectPath, p))
    for (const stats2 of results) {
      if (stats2) files.set(stats2.path, stats2)
    }
  }

  return files
}

export async function scanFiles(
  projectPath: string,
  paths: string[]
): Promise<Map<string, FileStats>> {
  const files = new Map<string, FileStats>()
  const results = await Promise.all(paths.map((p) => getFileStats(projectPath, p)))
  for (const stats of results) {
    if (stats) files.set(stats.path, stats)
  }
  return files
}

export async function findConfigFiles(
  projectPath: string,
  projectId: string
): Promise<ConfigFileEntry[]> {
  const configs: ConfigFileEntry[] = []

  for (const configName of CONFIG_FILES) {
    const configPath = path.join(projectPath, configName)
    if (!(await fileExists(configPath))) continue

    const checksum = await indexStorage.calculateChecksum(configPath)
    const entry: ConfigFileEntry = {
      path: configName,
      type: configName,
      checksum,
    }

    if (configName.endsWith('.json')) {
      try {
        const content = await fs.readFile(configPath, 'utf-8')
        entry.parsed = JSON.parse(content)
      } catch {
        // Invalid JSON
      }
    }

    configs.push(entry)
  }

  void projectId
  return configs
}

export async function analyzeDirectories(projectPath: string): Promise<DirectoryEntry[]> {
  const directories: DirectoryEntry[] = []

  try {
    const entries = await fs.readdir(projectPath, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      if (IGNORE_DIRS.has(entry.name)) continue
      if (entry.name.startsWith('.') && entry.name !== '.github') continue

      const dirPath = entry.name
      const fileCount = await countFilesInDir(projectPath, dirPath)

      directories.push({
        path: dirPath,
        type: classifyDirectory(dirPath),
        fileCount,
      })
    }
  } catch {
    // Project path may not be accessible
  }

  return directories
}

async function countFilesInDir(projectPath: string, relativePath: string): Promise<number> {
  const fullPath = path.join(projectPath, relativePath)
  try {
    const { stdout } = await execAsync(`find . -type f | wc -l`, { cwd: fullPath })
    return parseInt(stdout.trim(), 10) || 0
  } catch {
    return 0
  }
}
