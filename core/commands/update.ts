/**
 * Update Command: prjct update
 *
 * Full system updater — 3 phases:
 * 1. Package update (auto-detects npm / pnpm / bun / yarn, plus homebrew migration)
 * 2. Global cleanup (all projects: migrate + sweep + reinstall commands)
 * 3. Daemon restart
 */

import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { CommandInstaller } from '../infrastructure/command-installer'
import editorsConfig from '../infrastructure/editors-config'
import UpdateChecker from '../infrastructure/update-checker'
import type { CommandResult } from '../types/commands'
import { getErrorMessage } from '../types/fs'
import { failFromError } from '../utils/md-aware'
import out from '../utils/output'
import { PrjctCommandsBase } from './base'
import { type CleanupMode, consolidateInstalls } from './update/cleanup-installs'
import { formatMdOutput, formatTerminalOutput, type PhaseResult } from './update/output'
import {
  getAllInstalledLocations,
  isHomebrewInstall,
  isOnPath,
  type PkgManager,
  redirectToInstalledPackage,
  registryInstallArgs,
  registryInstallCwd,
  selectPackageManager,
} from './update/package-managers'

interface UpdateOptions {
  'dry-run'?: boolean
  md?: boolean
  /** --cleanup forces consolidation; --no-cleanup disables it (parsed as false) */
  cleanup?: boolean
  /** --yes / -y: skip the consolidation confirmation prompt */
  yes?: boolean
  y?: boolean
}

export class UpdateCommands extends PrjctCommandsBase {
  /**
   * prjct update [--dry-run] [--md]
   *
   * 3-phase system updater:
   * 1. Package update (npm update or homebrew→npm migration)
   * 2. Global cleanup (all projects: migrations + command reinstall)
   * 3. Daemon restart
   */
  async update(
    options: UpdateOptions = {},
    _projectPath: string = process.cwd()
  ): Promise<CommandResult> {
    const dryRun = options['dry-run'] === true
    const md = options.md === true
    // --no-cleanup → cleanup===false → 'off'; --cleanup → 'force'; default 'auto'
    const cleanupMode: CleanupMode =
      options.cleanup === false ? 'off' : options.cleanup === true ? 'force' : 'auto'
    const assumeYes = options.yes === true || options.y === true

    const results = {
      phase1: { success: true, details: [], errors: [], warnings: [] } as PhaseResult,
      phase2: { success: true, details: [], errors: [], warnings: [] } as PhaseResult,
      phase3: { success: true, details: [], errors: [], warnings: [] } as PhaseResult,
    }

    try {
      // ── Phase 0: stop any running daemon FIRST ──
      // A daemon from a previous (now-stale) version keeps serving old code
      // for its whole lifetime — it never learned new verbs/aliases (e.g.
      // `upgrade`) and would mis-handle them (silently inbox-capturing the
      // command). Tear it down before doing anything; phase 3 spawns a
      // fresh one from the just-installed code.
      if (!dryRun) {
        try {
          const { isDaemonRunning, stopDaemon, forceKillDaemon } = await import('../daemon/client')
          if (await isDaemonRunning()) {
            const ok = await stopDaemon()
            if (!ok) forceKillDaemon()
          }
        } catch {
          // best-effort — never block the update on daemon teardown
        }
      }

      // ── Phase 1: Package Update ──
      if (!md) out.step(1, 3, 'Updating package...')
      results.phase1 = await this.phasePackageUpdate(dryRun)
      if (!md) out.stop()

      // After Phase 1, redirect to the INSTALLED package.
      // The running process may have started from source (npm link / bun link)
      // or from the old install. All Phase 2+3 operations must use the
      // newly installed files, not the source/old paths.
      if (!dryRun && results.phase1.success) {
        redirectToInstalledPackage()
      }

      // ── Phase 2: Global Cleanup ──
      if (!md) out.step(2, 3, 'Cleaning up all projects...')
      results.phase2 = await this.phaseGlobalCleanup(dryRun, cleanupMode, assumeYes)
      if (!md) out.stop()

      // ── Phase 3: Daemon Restart ──
      if (!md) out.step(3, 3, 'Restarting daemon...')
      results.phase3 = await this.phaseDaemonRestart(dryRun)
      if (!md) out.stop()

      // ── Post-update: stamp INSTALLED (npm) version + clear cache ──
      // Never stamp the running process VERSION — that can be monorepo source.
      if (!dryRun) {
        try {
          const installed = getAllInstalledLocations()[0]?.version
          if (installed) await editorsConfig.updateVersion(installed)
        } catch {
          // Non-blocking
        }
        try {
          const checker = new UpdateChecker()
          await checker.writeCache({ lastCheck: 0, latestVersion: '' })
        } catch {
          // Non-blocking
        }
      }

      return md ? formatMdOutput(results, dryRun) : formatTerminalOutput(results, dryRun)
    } catch (error) {
      if (!md) out.stop()
      out.fail(getErrorMessage(error))
      return failFromError(error)
    }
  }

  // ── Phase 1: Package Update ──

  private async phasePackageUpdate(dryRun: boolean): Promise<PhaseResult> {
    const result: PhaseResult = { success: true, details: [], errors: [], warnings: [] }
    const installsBefore = getAllInstalledLocations()

    if (dryRun) {
      const homebrew = isHomebrewInstall()
      if (homebrew) {
        const pmName = (() => {
          try {
            return selectPackageManager().name
          } catch (err) {
            result.errors.push(getErrorMessage(err))
            return '<none-available>'
          }
        })()
        result.details.push('Would uninstall homebrew formula')
        result.details.push(`Would install via ${pmName}`)
      } else if (installsBefore.length === 0) {
        const pmName = (() => {
          try {
            return selectPackageManager().name
          } catch (err) {
            result.errors.push(getErrorMessage(err))
            return '<none-available>'
          }
        })()
        result.details.push(`Would install via ${pmName}`)
      } else {
        for (const { pm, version } of installsBefore) {
          result.details.push(`Would reinstall via ${pm.name} (currently v${version})`)
        }
      }
      return result
    }

    try {
      const homebrew = isHomebrewInstall()

      if (homebrew) {
        try {
          execFileSync('brew', ['uninstall', 'prjct-cli'], {
            stdio: ['pipe', 'pipe', 'ignore'],
          })
          result.details.push('Uninstalled homebrew formula')
        } catch {
          result.details.push('Homebrew uninstall skipped (not found)')
        }
      }

      // Determine which managers to install with:
      // - If installs already exist, update each of them (preserves user's
      //   chosen PMs; fixes PATH-shadowing when there are duplicates).
      // - Otherwise (homebrew migration or fresh install), use the detected PM.
      const targets: PkgManager[] =
        installsBefore.length > 0 ? installsBefore.map((i) => i.pm) : [selectPackageManager()]

      // Source of truth is ALWAYS registry.npmjs.org — never monorepo package.json,
      // never npm-link, never the running binary's baked VERSION (mem_9174).
      // Pin exact version so PM metadata caches cannot downgrade the install.
      const registryVersion = await new UpdateChecker()
        .getLatestVersion()
        .then((version) => version?.trim() ?? null)
        .catch((err) => {
          result.errors.push(
            `npm registry unreachable — refuse to install from local tree: ${getErrorMessage(err)}`
          )
          return null
        })
      const pinnedSpec =
        registryVersion && /^\d+\.\d+\.\d+/.test(registryVersion)
          ? `prjct-cli@${registryVersion}`
          : null

      if (!pinnedSpec || !registryVersion) {
        result.success = false
        result.errors.push('npm registry did not return a valid prjct-cli version')
        return result
      }

      result.details.push(`registry.npmjs.org latest = ${registryVersion}`)

      // Neutral cwd: running `npm install -g prjct-cli@…` from inside the monorepo
      // can resolve the local package instead of the published tarball.
      const installCwd = registryInstallCwd()

      for (const pm of targets) {
        if (!isOnPath(pm.name)) {
          result.errors.push(
            `${pm.name} is not on PATH but has a prjct-cli install. ` +
              `Either install ${pm.name} or remove that copy.`
          )
          continue
        }
        try {
          const args = registryInstallArgs(pm, pinnedSpec)
          execFileSync(pm.name, args, { stdio: 'pipe', cwd: installCwd })
          result.details.push(`${pm.name} install complete (${pinnedSpec} from npm registry)`)
        } catch (err) {
          result.errors.push(`${pm.name}: ${getErrorMessage(err)}`)
        }
      }

      // Per-install version transitions + verify each matches registry
      const installsAfter = getAllInstalledLocations()
      const beforeMap = new Map(installsBefore.map((i) => [i.pm.name, i.version]))
      const transitions: string[] = []

      for (const { pm, version } of installsAfter) {
        const before = beforeMap.get(pm.name)
        if (before && before !== version) {
          transitions.push(`${pm.name}: ${before} → ${version}`)
        } else if (!before) {
          transitions.push(`${pm.name}: installed v${version}`)
        } else {
          transitions.push(`${pm.name}: v${version} (matches registry)`)
        }
        if (version !== registryVersion) {
          result.errors.push(
            `${pm.name} install is v${version} but registry latest is ${registryVersion} — ` +
              `global install did not apply npm package (check PATH / npm root -g)`
          )
        }
      }

      for (const t of transitions) result.details.push(t)

      if (installsAfter.length === 0) {
        result.errors.push('No global prjct-cli install found after registry install')
      }
      if (result.errors.length > 0) result.success = false
    } catch (err) {
      result.success = false
      result.errors.push(getErrorMessage(err))
    }

    return result
  }

  // ── Phase 2: Global Cleanup ──

  private async phaseGlobalCleanup(
    dryRun: boolean,
    cleanupMode: CleanupMode = 'auto',
    assumeYes = false
  ): Promise<PhaseResult> {
    const result: PhaseResult = { success: true, details: [], errors: [], warnings: [] }

    // (The pre-v1.24.1 JSON→SQLite project migration ran here; retired with
    // the `migrate-json` subsystem — every active install migrated long ago.)

    // 2b. Full legacy cleanup + reinstall
    if (dryRun) {
      result.details.push('Would clean all legacy artifacts')
      result.details.push('Would reinstall editor commands')
      result.details.push('Would reinstall global config (all providers)')
    } else {
      // Clean ALL legacy artifacts first (routers, subdirs, homebrew remnants)
      try {
        const installer = new CommandInstaller()
        const legacyResult = await installer.cleanupAllLegacy()
        if (legacyResult.cleaned.length > 0) {
          result.details.push(`Cleaned ${legacyResult.cleaned.length} legacy artifact(s)`)
        }
      } catch (err) {
        result.errors.push(`Legacy cleanup: ${getErrorMessage(err)}`)
      }

      // Reinstall editor commands
      try {
        const installer = new CommandInstaller()
        const installResult = await installer.installCommands()
        result.details.push(
          `Editor commands reinstalled (${installResult.installed?.length || 0} providers)`
        )
      } catch (err) {
        result.errors.push(`Commands: ${getErrorMessage(err)}`)
      }

      // Regenerate the skill pair (SKILL.md + workflows.md).
      //
      // Upgrade did not do this — `generateAndInstall` was reachable only from
      // `prjct sync` and `doctor --fix`. So a new version installed cleanly
      // while the previous release's skill text kept driving every session: the
      // model-capping policy removed in v4.5.0 was still on disk, instructing
      // agents, after upgrading to v4.5.0. Any shipped change to the skill body
      // must reach the user on upgrade.
      try {
        const { skillGenerator } = await import('../services/skill-generator')
        const generated = await skillGenerator.generateAndInstall()
        result.details.push(`Skills regenerated (${generated.generated.length})`)
      } catch (err) {
        result.errors.push(`Skills: ${getErrorMessage(err)}`)
      }

      // Reinstall global config (replaces old prjct section between markers)
      try {
        const installer = new CommandInstaller()
        await installer.installGlobalConfig()
        result.details.push('Global config updated (prjct section replaced)')
      } catch (err) {
        result.errors.push(`Global config: ${getErrorMessage(err)}`)
      }

      // Install global config for ALL detected providers (not just active)
      try {
        const { detectAllProviders } = await import('../infrastructure/ai-provider')
        const detection = await detectAllProviders()
        const home = path.join(require('node:os').homedir())

        if (detection.gemini.installed) {
          const geminiPath = path.join(home, '.gemini', 'GEMINI.md')
          try {
            const geminiContent = await fs.readFile(geminiPath, 'utf-8')
            const startMarker = '<!-- prjct:start - DO NOT REMOVE THIS MARKER -->'
            const endMarker = '<!-- prjct:end - DO NOT REMOVE THIS MARKER -->'

            if (geminiContent.includes(startMarker) && geminiContent.includes(endMarker)) {
              const { getTemplateContent } = await import('../agentic/template-loader')
              const template = getTemplateContent('global/GEMINI.md')

              if (template?.includes(startMarker) && template.includes(endMarker)) {
                const prjctSection = template.substring(
                  template.indexOf(startMarker),
                  template.indexOf(endMarker) + endMarker.length
                )

                const before = geminiContent.substring(0, geminiContent.indexOf(startMarker))
                const after = geminiContent.substring(
                  geminiContent.indexOf(endMarker) + endMarker.length
                )

                const projStart = '<!-- prjct-project:start - DO NOT REMOVE THIS MARKER -->'
                const projEnd = '<!-- prjct-project:end - DO NOT REMOVE THIS MARKER -->'
                const withPrjctSection = before + prjctSection + after
                const cleaned =
                  withPrjctSection.includes(projStart) && withPrjctSection.includes(projEnd)
                    ? `${(
                        withPrjctSection.substring(0, withPrjctSection.indexOf(projStart)) +
                        withPrjctSection.substring(
                          withPrjctSection.indexOf(projEnd) + projEnd.length
                        )
                      )
                        .replace(/\n{3,}/g, '\n\n')
                        .trim()}\n`
                    : withPrjctSection

                await fs.writeFile(geminiPath, cleaned, 'utf-8')
                result.details.push('Gemini global config updated')
              }
            }
          } catch {
            // Gemini not configured — skip
          }
        }
      } catch {
        // Provider detection failed — non-critical
      }
    }

    // 2c. Consolidate parallel/stale installs (after redirect, before daemon
    // restart). Folded into the Cleanup phase rather than a new top-level
    // phase — keeps the 3-phase shape, no renumber churn.
    try {
      const cz = await consolidateInstalls(cleanupMode, dryRun, assumeYes)
      result.details.push(...cz.details)
      result.errors.push(...cz.errors)
    } catch (e) {
      result.errors.push(`install consolidation skipped: ${getErrorMessage(e)}`)
    }

    if (result.errors.length > 0) result.success = false
    return result
  }

  // ── Phase 3: Daemon Restart ──

  private async phaseDaemonRestart(dryRun: boolean): Promise<PhaseResult> {
    const result: PhaseResult = { success: true, details: [], errors: [], warnings: [] }

    if (dryRun) {
      result.details.push('Would restart daemon')
      return result
    }

    try {
      const { isDaemonRunning, forceRestartDaemon } = await import('../daemon/client')

      // Stop (graceful → force) or, if none was running, clean stale files.
      const wasRunning = await isDaemonRunning()
      result.details.push(wasRunning ? 'Daemon stopped' : 'No running daemon (cleaned stale files)')

      // Respawn (non-fatal: daemon auto-starts on next command if this fails)
      const started = await forceRestartDaemon()
      result.details.push(
        started ? 'Daemon restarted' : 'Daemon will start automatically on next use'
      )
    } catch (err) {
      result.success = false
      result.errors.push(getErrorMessage(err))
    }

    return result
  }
}
