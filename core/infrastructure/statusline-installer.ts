/**
 * Claude Code status-line installer.
 *
 * Extracted from infrastructure/setup.ts (god-file split). Installs the
 * statusline script + modules under ~/.prjct-cli/statusline, symlinks it
 * into ~/.claude, and wires settings.json (merge-safe).
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import { getErrorMessage, isNotFoundError } from '../types/fs'
import { fileExists, readJson, writeJson } from '../utils/file-helper'
import log from '../utils/logger'
import { PACKAGE_ROOT, VERSION } from '../utils/version'
import pathManager from './path-manager'
import { resolveUserPath } from './user-home'

/**
 * Ensure settings.json has statusLine configured
 */
async function ensureStatusLineSettings(
  settingsPath: string,
  statusLinePath: string
): Promise<void> {
  const settings: Record<string, unknown> = (await fileExists(settingsPath))
    ? ((await readJson<Record<string, unknown>>(settingsPath).catch((error) => {
        if (!(error instanceof SyntaxError)) throw error
        return null
      })) ?? {})
    : {}
  settings.statusLine = { type: 'command', command: statusLinePath }
  await writeJson(settingsPath, settings)
}

/**
 * Install the modular statusline assets into ~/.prjct-cli/statusline/
 * (statusline.sh, lib/, components/, themes/, config.json) with a version
 * check. Provider-neutral — no ~/.claude side effects — so any rig wiring
 * (Claude symlink, Kimi tui.toml command) can guarantee its target exists.
 * Returns the installed script path, or null when installation failed.
 */
export async function installStatusLineAssets(): Promise<string | null> {
  try {
    // Target location for the actual script
    const prjctStatusLineDir = pathManager.getStatusLinePath()
    const prjctStatusLinePath = path.join(prjctStatusLineDir, 'statusline.sh')
    const prjctThemesDir = path.join(prjctStatusLineDir, 'themes')
    const prjctLibDir = path.join(prjctStatusLineDir, 'lib')
    const prjctComponentsDir = path.join(prjctStatusLineDir, 'components')
    const prjctConfigPath = path.join(prjctStatusLineDir, 'config.json')

    // Source assets (from the package)
    const assetsDir = path.join(PACKAGE_ROOT, 'assets', 'statusline')
    const sourceScript = path.join(assetsDir, 'statusline.sh')
    const sourceThemeDir = path.join(assetsDir, 'themes')
    const sourceLibDir = path.join(assetsDir, 'lib')
    const sourceComponentsDir = path.join(assetsDir, 'components')
    const sourceConfigPath = path.join(assetsDir, 'default-config.json')

    if (!(await fileExists(prjctStatusLineDir))) {
      await fs.mkdir(prjctStatusLineDir, { recursive: true })
    }
    if (!(await fileExists(prjctThemesDir))) {
      await fs.mkdir(prjctThemesDir, { recursive: true })
    }
    if (!(await fileExists(prjctLibDir))) {
      await fs.mkdir(prjctLibDir, { recursive: true })
    }
    if (!(await fileExists(prjctComponentsDir))) {
      await fs.mkdir(prjctComponentsDir, { recursive: true })
    }

    if (await fileExists(prjctStatusLinePath)) {
      const existingContent = await fs.readFile(prjctStatusLinePath, 'utf8')

      if (existingContent.includes('CLI_VERSION=')) {
        // Has CLI_VERSION - update if needed
        const versionMatch = existingContent.match(/CLI_VERSION="([^"]*)"/)

        if (versionMatch && versionMatch[1] !== VERSION) {
          // Update CLI_VERSION in-place
          const updatedContent = existingContent.replace(
            /CLI_VERSION="[^"]*"/,
            `CLI_VERSION="${VERSION}"`
          )
          await fs.writeFile(prjctStatusLinePath, updatedContent, { mode: 0o755 })
        }

        // Ensure modular structure is installed (upgrade path)
        await installStatusLineModules(sourceLibDir, prjctLibDir)
        await installStatusLineModules(sourceComponentsDir, prjctComponentsDir)

        return prjctStatusLinePath
      }
      // else: Script exists WITHOUT CLI_VERSION - fall through to replace with new version
    }

    // Install fresh from assets if source exists
    if (await fileExists(sourceScript)) {
      // Copy script and update version
      const scriptContent = (await fs.readFile(sourceScript, 'utf8')).replace(
        /CLI_VERSION="[^"]*"/,
        `CLI_VERSION="${VERSION}"`
      )
      await fs.writeFile(prjctStatusLinePath, scriptContent, { mode: 0o755 })

      // Copy lib/ modules
      await installStatusLineModules(sourceLibDir, prjctLibDir)

      // Copy components/
      await installStatusLineModules(sourceComponentsDir, prjctComponentsDir)

      // Copy themes
      if (await fileExists(sourceThemeDir)) {
        const themes = await fs.readdir(sourceThemeDir)
        for (const theme of themes) {
          const src = path.join(sourceThemeDir, theme)
          const dest = path.join(prjctThemesDir, theme)
          // Always update themes to get new icons/colors
          await fs.copyFile(src, dest)
        }
      }

      // Copy default config (only if not exists - preserve user customizations)
      if (!(await fileExists(prjctConfigPath)) && (await fileExists(sourceConfigPath))) {
        await fs.copyFile(sourceConfigPath, prjctConfigPath)
      }
      return prjctStatusLinePath
    }

    // Fallback: create simple script inline
    const scriptContent = `#!/bin/bash
# prjct Status Line for Claude Code
CLI_VERSION="${VERSION}"
input=$(cat)
CWD=$(echo "$input" | jq -r '.workspace.current_dir // "~"' 2>/dev/null)
CONFIG="$CWD/.prjct/prjct.config.json"
if [ -f "$CONFIG" ]; then
  PROJECT_ID=$(jq -r '.projectId // ""' "$CONFIG" 2>/dev/null)
  if [ -n "$PROJECT_ID" ]; then
    # Upgrade notice — the daemon checks npm and writes this GLOBAL flag.
    # The statusline only READS it; it does no version comparison itself.
    UPDATE_STATUS="$HOME/.prjct-cli/state/update-status.json"
    if [ -f "$UPDATE_STATUS" ] && [ "$(jq -r '.updateAvailable // false' "$UPDATE_STATUS" 2>/dev/null)" = "true" ]; then
      LATEST=$(jq -r '.latest // ""' "$UPDATE_STATUS" 2>/dev/null)
      echo "prjct v$LATEST - run p. upgrade"
      exit 0
    fi
  fi
fi
echo "prjct"
`
    await fs.writeFile(prjctStatusLinePath, scriptContent, { mode: 0o755 })
    return prjctStatusLinePath
  } catch (error) {
    // Silently fail if directories don't exist
    if (!isNotFoundError(error)) {
      // Log unexpected errors but don't crash - status line is optional
      log.warn(`Status line warning: ${getErrorMessage(error)}`)
    }
    return null
  }
}

/**
 * Install the statusline for Claude Code: shared assets, a symlink at
 * ~/.claude/prjct-statusline.sh, and the settings.json statusLine entry.
 */
export async function installStatusLine(): Promise<void> {
  try {
    const claudeDir = resolveUserPath('.claude')
    const settingsPath = path.join(claudeDir, 'settings.json')
    const claudeStatusLinePath = path.join(claudeDir, 'prjct-statusline.sh')

    if (!(await fileExists(claudeDir))) {
      await fs.mkdir(claudeDir, { recursive: true })
    }

    const scriptPath = await installStatusLineAssets()
    if (scriptPath === null) return

    await ensureStatusLineSymlink(claudeStatusLinePath, scriptPath)
    await ensureStatusLineSettings(settingsPath, claudeStatusLinePath)
  } catch (error) {
    // Silently fail if directories don't exist
    if (!isNotFoundError(error)) {
      // Log unexpected errors but don't crash - status line is optional
      log.warn(`Status line warning: ${getErrorMessage(error)}`)
    }
  }
}

/**
 * Install statusline modules (lib/ or components/)
 * Copies .sh files from source to destination, always overwriting for updates
 */
async function installStatusLineModules(sourceDir: string, destDir: string): Promise<void> {
  if (!(await fileExists(sourceDir))) {
    return
  }

  const files = await fs.readdir(sourceDir)
  for (const file of files) {
    if (file.endsWith('.sh')) {
      const src = path.join(sourceDir, file)
      const dest = path.join(destDir, file)
      await fs.copyFile(src, dest)
      await fs.chmod(dest, 0o755)
    }
  }
}

/**
 * Ensure symlink from Claude config to prjct statusline
 */
async function ensureStatusLineSymlink(linkPath: string, targetPath: string): Promise<void> {
  try {
    if (await fileExists(linkPath)) {
      const stats = await fs.lstat(linkPath)
      if (stats.isSymbolicLink()) {
        const existingTarget = await fs.readlink(linkPath)
        if (existingTarget === targetPath) {
          return // Already correct
        }
      }
      // Remove existing file/symlink
      await fs.unlink(linkPath)
    }
    // Create symlink
    await fs.symlink(targetPath, linkPath)
  } catch (_error) {
    // If symlink fails (e.g., Windows, permission issues), try copy instead
    try {
      if (await fileExists(targetPath)) {
        await fs.copyFile(targetPath, linkPath)
        await fs.chmod(linkPath, 0o755)
      }
    } catch (copyError) {
      // Both symlink and copy failed - log if unexpected error
      if (!isNotFoundError(copyError)) {
        log.warn(`Symlink fallback warning: ${(copyError as Error).message}`)
      }
    }
  }
}
