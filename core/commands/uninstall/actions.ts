/**
 * Mutating side of `prjct uninstall` — backup, prompt, and execute the
 * actual deletes. Anything that touches disk lives here.
 */

import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import readline from 'node:readline'
import { CommandInstaller } from '../../infrastructure/command-installer'
import pathManager from '../../infrastructure/path-manager'
import { resolveUserHome } from '../../infrastructure/user-home'
import type { UninstallOptions } from '../../types/commands'
import { getErrorMessage } from '../../types/fs'
import { fileExists } from '../../utils/file-helper'
import {
  type InstallationInfo,
  PRJCT_END_MARKER,
  PRJCT_START_MARKER,
  type UninstallItem,
} from './inventory'

async function copyDirectory(src: string, dest: string): Promise<void> {
  await fs.mkdir(dest, { recursive: true })
  const entries = await fs.readdir(src, { withFileTypes: true })

  for (const entry of entries) {
    const srcPath = path.join(src, entry.name)
    const destPath = path.join(dest, entry.name)
    if (entry.isDirectory()) await copyDirectory(srcPath, destPath)
    else await fs.copyFile(srcPath, destPath)
  }
}

export async function createBackup(): Promise<string | null> {
  const homeDir = resolveUserHome()
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19)
  const backupDir = path.join(homeDir, `.prjct-backup-${timestamp}`)

  try {
    await fs.mkdir(backupDir, { recursive: true })
    const prjctCliPath = pathManager.getGlobalBasePath()
    if (await fileExists(prjctCliPath)) {
      await copyDirectory(prjctCliPath, path.join(backupDir, '.prjct-cli'))
    }
    return backupDir
  } catch {
    return null
  }
}

async function removePrjctSection(filePath: string): Promise<boolean> {
  try {
    const content = await fs.readFile(filePath, 'utf-8')

    if (!content.includes(PRJCT_START_MARKER) || !content.includes(PRJCT_END_MARKER)) {
      return false
    }

    const startIndex = content.indexOf(PRJCT_START_MARKER)
    const endIndex = content.indexOf(PRJCT_END_MARKER) + PRJCT_END_MARKER.length

    const newContent = (content.substring(0, startIndex) + content.substring(endIndex))
      .replace(/\n{3,}/g, '\n\n')
      .trim()

    if (!newContent || newContent.trim().length === 0) {
      await fs.unlink(filePath)
    } else {
      await fs.writeFile(filePath, `${newContent}\n`, 'utf-8')
    }

    return true
  } catch {
    return false
  }
}

export async function performUninstall(
  items: UninstallItem[],
  installation: InstallationInfo,
  options: UninstallOptions
): Promise<{ deleted: string[]; errors: string[] }> {
  const deleted: string[] = []
  const errors: string[] = []

  for (const item of items) {
    if (!item.exists) continue

    try {
      if (item.type === 'section') {
        if (await removePrjctSection(item.path)) deleted.push(item.path)
      } else if (item.type === 'directory') {
        await fs.rm(item.path, { recursive: true, force: true })
        deleted.push(item.path)
      } else if (item.type === 'file') {
        await fs.unlink(item.path)
        deleted.push(item.path)
      }
    } catch (error) {
      errors.push(`${item.path}: ${getErrorMessage(error)}`)
    }
  }

  // Remove legacy p/ subdirectory (pre-v1.25 architecture)
  try {
    const installer = new CommandInstaller()
    await installer.cleanupLegacyCommands()
  } catch {
    // Non-fatal
  }

  // Uninstall package managers
  if (!options.keepPackage) {
    if (installation.homebrew && installation.homebrewFormula) {
      try {
        if (!options.dryRun) {
          execFileSync('brew', ['uninstall', installation.homebrewFormula], { stdio: 'pipe' })
        }
        deleted.push('Homebrew: prjct-cli')
      } catch (error) {
        errors.push(`Homebrew: ${getErrorMessage(error)}`)
      }
    }

    if (installation.npm) {
      try {
        if (!options.dryRun) {
          execFileSync('npm', ['uninstall', '-g', 'prjct-cli'], { stdio: 'pipe' })
        }
        deleted.push('npm: prjct-cli')
      } catch (error) {
        errors.push(`npm: ${getErrorMessage(error)}`)
      }
    }
  }

  return { deleted, errors }
}

export async function promptConfirmation(message: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })

  return new Promise((resolve) => {
    rl.question(message, (answer) => {
      rl.close()
      resolve(answer.toLowerCase() === 'uninstall')
    })
  })
}
