/**
 * Discovery side of `prjct uninstall` — figure out WHAT exists on disk
 * before touching anything. Pure read-only operations.
 */

import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { getProviderPaths } from '../../infrastructure/command-installer'
import pathManager from '../../infrastructure/path-manager'
import { fileExists } from '../../utils/file-helper'

export const PRJCT_START_MARKER = '<!-- prjct:start - DO NOT REMOVE THIS MARKER -->'
export const PRJCT_END_MARKER = '<!-- prjct:end - DO NOT REMOVE THIS MARKER -->'

export interface UninstallItem {
  path: string
  type: 'directory' | 'file' | 'section'
  description: string
  size?: number
  count?: number
  exists: boolean
}

export interface InstallationInfo {
  homebrew: boolean
  npm: boolean
  homebrewFormula?: string
}

export async function getDirectorySize(dirPath: string): Promise<number> {
  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true })
    const sizes = await Promise.all(
      entries.map(async (entry) => {
        const entryPath = path.join(dirPath, entry.name)
        if (entry.isDirectory()) return getDirectorySize(entryPath)
        try {
          const stats = await fs.stat(entryPath)
          return stats.size
        } catch {
          return 0
        }
      })
    )
    return sizes.reduce((total, size) => total + size, 0)
  } catch {
    return 0
  }
}

export function formatSize(bytes: number): string {
  if (bytes === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(1024))
  return `${(bytes / 1024 ** i).toFixed(1)} ${units[i]}`
}

async function countDirectoryItems(dirPath: string): Promise<number> {
  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true })
    return entries.filter((e) => e.isDirectory()).length
  } catch {
    return 0
  }
}

export function detectInstallation(): InstallationInfo {
  const info: InstallationInfo = { homebrew: false, npm: false }

  try {
    const result = execFileSync('brew', ['list', 'prjct-cli'], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'ignore'],
    })
    if (result) {
      info.homebrew = true
      info.homebrewFormula = 'prjct-cli'
    }
  } catch {
    // Not installed via Homebrew
  }

  try {
    const result = execFileSync('npm', ['list', '-g', 'prjct-cli', '--depth=0'], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'ignore'],
    })
    if (result.includes('prjct-cli')) info.npm = true
  } catch {
    // Not installed via npm
  }

  return info
}

export async function gatherUninstallItems(): Promise<UninstallItem[]> {
  const items: UninstallItem[] = []
  const providerPaths = getProviderPaths()

  // 1. ~/.prjct-cli/ (main data directory)
  const prjctCliPath = pathManager.getGlobalBasePath()
  const prjctCliExists = await fileExists(prjctCliPath)
  const projectCount = prjctCliExists
    ? await countDirectoryItems(path.join(prjctCliPath, 'projects'))
    : 0
  const prjctCliSize = prjctCliExists ? await getDirectorySize(prjctCliPath) : 0

  items.push({
    path: prjctCliPath,
    type: 'directory',
    description: `All project data${projectCount > 0 ? `, ${projectCount} project${projectCount > 1 ? 's' : ''}` : ''}`,
    size: prjctCliSize,
    count: projectCount,
    exists: prjctCliExists,
  })

  // 2. ~/.claude/CLAUDE.md (prjct section only)
  const claudeMdPath = path.join(providerPaths.claude.config, 'CLAUDE.md')
  items.push({
    path: claudeMdPath,
    type: 'section',
    description: 'prjct section in CLAUDE.md',
    exists: await hasMarkerSection(claudeMdPath),
  })

  // 3. ~/.claude/commands/p.md (router)
  items.push({
    path: providerPaths.claude.router,
    type: 'file',
    description: 'Claude router',
    exists: await fileExists(providerPaths.claude.router),
  })

  // 5. ~/.claude/prjct-statusline.sh (status line script)
  const statusLinePath = path.join(providerPaths.claude.config, 'prjct-statusline.sh')
  items.push({
    path: statusLinePath,
    type: 'file',
    description: 'Status line script',
    exists: await fileExists(statusLinePath),
  })

  // 6. ~/.gemini/commands/p.toml (Gemini router, if exists)
  items.push({
    path: providerPaths.gemini.router,
    type: 'file',
    description: 'Gemini router',
    exists: await fileExists(providerPaths.gemini.router),
  })

  // 7. ~/.gemini/GEMINI.md (prjct section only, if exists)
  const geminiMdPath = path.join(providerPaths.gemini.config, 'GEMINI.md')
  if (await hasMarkerSection(geminiMdPath)) {
    items.push({
      path: geminiMdPath,
      type: 'section',
      description: 'prjct section in GEMINI.md',
      exists: true,
    })
  }

  return items
}

async function hasMarkerSection(filePath: string): Promise<boolean> {
  if (!(await fileExists(filePath))) return false
  try {
    const content = await fs.readFile(filePath, 'utf-8')
    return content.includes(PRJCT_START_MARKER) && content.includes(PRJCT_END_MARKER)
  } catch {
    return false
  }
}
