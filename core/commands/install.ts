/**
 * prjct install / uninstall — wire (and unwire) Claude Code hooks.
 *
 * Writes `~/.claude/settings.json` so every session in this user account
 * gets prjct's passive context injection. User keys and hooks from other
 * tools stay untouched — only entries tagged `_prjctManaged: true` are
 * touched.
 */

import { detectAgentRuntimes } from '../infrastructure/agent-runtime-registry'
import configManager from '../infrastructure/config-manager'
import { installGrokSkill } from '../infrastructure/grok-skill'
import { installPiSkill } from '../infrastructure/pi-skill'
import { probeHarnessCoverage, renderHarnessCoverageMd } from '../services/harness-coverage'
import { writeProjectAgentSurfaces } from '../services/project-agent-surfaces'
import {
  status as hookStatus,
  install as installHooks,
  PRJCT_HOOKS,
  uninstall as uninstallHooks,
} from '../services/settings-installer'
import type { MdOption } from '../types/cli'
import type { CommandResult } from '../types/commands'
import { getErrorMessage } from '../types/fs'
import { installCodexHooks, uninstallCodexHooks } from '../utils/codex-hooks'
import { ensureCodexMcpServer } from '../utils/codex-mcp'
import { installCursorHooks, uninstallCursorHooks } from '../utils/cursor-hooks'
import { installGeminiSettings, uninstallGeminiSettings } from '../utils/gemini-settings'
import { ensureGrokMcpServer } from '../utils/grok-mcp'
import { installGrokPlugin } from '../utils/grok-plugin'
import { ensureKimiMcpServer } from '../utils/kimi-mcp'
import { failFromError, failHard } from '../utils/md-aware'
import { ensureOpenCodeMcpServer } from '../utils/opencode-mcp'
import out from '../utils/output'
import { PrjctCommandsBase } from './base'

export class InstallCommands extends PrjctCommandsBase {
  /**
   * p. install — install the prjct hook pack into `~/.claude/settings.json`.
   */
  async install(
    _arg: string | null = null,
    projectPath: string = process.cwd(),
    options: MdOption = {}
  ): Promise<CommandResult> {
    try {
      const result = await installHooks()
      const config = await configManager.readConfig(projectPath).catch(() => null)
      const runtimes = await detectAgentRuntimes(projectPath)
      const detected = runtimes.filter((runtime) => runtime.detected)
      // `prjct install` wires Claude Code hooks by definition — 'claude' is
      // always relevant here even before detection would otherwise notice
      // (installHooks() above is what CREATES ~/.claude/, so a detection
      // call made before it would miss a first-time install).
      const detectedAgentIds = [...new Set(['claude', ...detected.map((r) => r.runtime.id)])]
      const projectSurfaces = config?.projectId
        ? await writeProjectAgentSurfaces(projectPath, {
            explicit: true,
            agents: detectedAgentIds,
          })
        : null
      const codexDetected = detected.some((runtime) => runtime.runtime.id === 'codex')
      const codexConfig = codexDetected ? await ensureCodexMcpServer() : null
      // Always install Codex hooks when Codex is present; also install when
      // ~/.codex exists so MCP-only users get hooks without re-detect races.
      const codexHooks = codexDetected ? await installCodexHooks() : null
      const geminiDetected = detected.some((runtime) => runtime.runtime.id === 'gemini')
      const geminiConfig = geminiDetected ? await installGeminiSettings() : null
      const cursorDetected = detected.some((runtime) => runtime.runtime.id === 'cursor')
      const cursorHooks = cursorDetected ? await installCursorHooks() : null
      const kimiDetected = detected.some((runtime) => runtime.runtime.id === 'kimi-cli')
      const kimiConfig = kimiDetected ? await ensureKimiMcpServer() : null
      const grokDetected = detected.some((runtime) => runtime.runtime.id === 'grok')
      const grokConfig = grokDetected ? await ensureGrokMcpServer() : null
      const grokSkill = grokDetected ? await installGrokSkill() : null
      const grokPlugin = grokDetected ? await installGrokPlugin() : null
      const opencodeDetected = detected.some((runtime) => runtime.runtime.id === 'opencode')
      const opencodeConfig = opencodeDetected ? await ensureOpenCodeMcpServer() : null
      const piDetected = detected.some((runtime) => runtime.runtime.id === 'pi')
      const piSkill = piDetected ? await installPiSkill() : null
      const coverage = await probeHarnessCoverage(projectPath)
      const total = PRJCT_HOOKS.length
      const prunedNote = result.hooksPruned > 0 ? `, ${result.hooksPruned} retired removed` : ''
      const msg = `installed Claude hooks adapter: ${result.hooksWritten} new, ${result.alreadyPresent} already present${prunedNote} (total ${total} hooks)`
      // Dynasty D6: one-breath ritual + harness Δ proof (no second install path).
      const runtimesWired = [
        codexHooks || codexConfig ? 'codex' : null,
        geminiConfig ? 'gemini' : null,
        cursorHooks ? 'cursor' : null,
        kimiConfig ? 'kimi' : null,
        grokConfig || grokSkill?.success || grokPlugin?.success ? 'grok' : null,
        opencodeConfig ? 'opencode' : null,
        piSkill?.success ? 'pi' : null,
        'claude',
      ].filter((x): x is string => Boolean(x))
      const deltaLine = await import('../services/weak-frontier-demo')
        .then(({ computeHarnessDelta }) => computeHarnessDelta().line)
        .catch(() => null)
      const { buildOneBreathReport } = await import('../services/one-breath-install')
      const ritual = buildOneBreathReport({
        claudeHooksNew: result.hooksWritten,
        claudeHooksPresent: result.alreadyPresent,
        projectSurface: Boolean(projectSurfaces),
        runtimesWired: [...new Set(runtimesWired)],
        liveCount: coverage.liveCount,
        detectedCount: coverage.detectedCount,
        organicPct: coverage.organicPct,
        deltaLine,
      })
      if (options.md) {
        console.log(
          [
            ritual.md,
            `## Universal project surface`,
            projectSurfaces
              ? `- PRJCT.md: ${projectSurfaces.prjctMd.action}`
              : `- skipped: not inside an initialized prjct project`,
            ...(projectSurfaces ? [`- AGENTS.md: ${projectSurfaces.agentsMd.action}`] : []),
            ...(projectSurfaces?.claudeMd && projectSurfaces.claudeMd.action !== 'unchanged'
              ? [`- CLAUDE.md adapter: ${projectSurfaces.claudeMd.action}`]
              : []),
            ...(projectSurfaces?.ideRules.length
              ? projectSurfaces.ideRules.map((rule) => `- project rule adapter: \`${rule}\``)
              : []),
            ...(codexConfig
              ? [
                  `- Codex MCP: ${
                    codexConfig.skipped === 'user-managed'
                      ? 'user-managed preserved'
                      : codexConfig.changed
                        ? 'updated'
                        : 'already ready'
                  }`,
                  `- Codex status line: ${
                    codexConfig.statusLineChanged ? 'installed' : 'already configured'
                  }`,
                ]
              : []),
            ...(codexHooks
              ? [
                  `- Codex hooks: ${codexHooks.hooksWritten} new, ${codexHooks.alreadyPresent} present, ${codexHooks.hooksPruned} pruned → \`${codexHooks.hooksPath}\``,
                  `- Codex features.hooks: ${codexHooks.featuresChanged ? 'enabled' : 'already on'}`,
                ]
              : []),
            ...(geminiConfig
              ? [
                  `- Gemini MCP: ${geminiConfig.mcpChanged ? 'updated' : 'already ready'}`,
                  `- Gemini hooks: ${geminiConfig.hooksWritten} new, ${geminiConfig.alreadyPresent} present, ${geminiConfig.hooksPruned} pruned → \`${geminiConfig.settingsPath}\``,
                ]
              : []),
            ...(cursorHooks
              ? [
                  `- Cursor hooks: ${cursorHooks.hooksWritten} new, ${cursorHooks.alreadyPresent} present, ${cursorHooks.hooksPruned} pruned → \`${cursorHooks.hooksPath}\``,
                ]
              : []),
            ...(kimiConfig
              ? [`- Kimi config: ${kimiConfig.changed ? 'updated' : 'already ready'}`]
              : []),
            ...(grokConfig
              ? [
                  `- Grok MCP: ${
                    grokConfig.skipped === 'user-managed'
                      ? 'user-managed preserved'
                      : grokConfig.changed
                        ? 'updated'
                        : 'already ready'
                  } → \`${grokConfig.path}\``,
                ]
              : []),
            ...(grokSkill?.success
              ? [
                  `- Grok skill: ${grokSkill.action ?? 'ready'}${grokSkill.path ? ` → \`${grokSkill.path}\`` : ''}`,
                ]
              : []),
            ...(grokPlugin?.success
              ? [
                  `- Grok plugin: ${grokPlugin.changed ? `updated (${grokPlugin.files.join(', ') || 'files'})` : 'already ready'} → \`${grokPlugin.path}\``,
                ]
              : []),
            ...(opencodeConfig
              ? [
                  `- OpenCode MCP: ${opencodeConfig.changed ? 'updated' : 'already ready'} → \`${opencodeConfig.path}\``,
                ]
              : []),
            ...(piSkill?.success
              ? [
                  `- Pi skill: ${piSkill.action ?? 'ready'}${piSkill.path ? ` → \`${piSkill.path}\`` : ''}`,
                ]
              : []),
            ``,
            `## Claude hooks adapter`,
            `Wrote to \`${result.settingsPath}\`.`,
            ``,
            `- new: ${result.hooksWritten}`,
            `- already present: ${result.alreadyPresent}`,
            `- retired removed: ${result.hooksPruned}`,
            `- total expected: ${total}`,
            ``,
            `## Runtime detection`,
            ...detected.map(
              (runtime) => `- ${runtime.runtime.displayName}: ${runtime.supportLevel}`
            ),
            ``,
            renderHarnessCoverageMd(coverage),
            `> One install · one SQLite brain · every agent surface. That is the moat — not more skills.`,
            `> OpenCode: native MCP. Pi: native skill (no MCP). Grok: MCP+skill; hooks via Claude compat. Codex/Gemini/Cursor: native adapters.`,
            `> Gaps? \`prjct doctor --fix\`. Only managed entries were touched.`,
          ].join('\n')
        )
      } else {
        out.done(ritual.line)
        out.info(msg)
        out.info(`settings: ${result.settingsPath}`)
        if (projectSurfaces) {
          out.info(`AGENTS.md: ${projectSurfaces.agentsMd.action}`)
          for (const rule of projectSurfaces.ideRules) out.info(`adapter: ${rule}`)
        } else {
          out.info('project surface: skipped (not inside an initialized prjct project)')
        }
        if (codexConfig) {
          const action =
            codexConfig.skipped === 'user-managed'
              ? 'user-managed MCP preserved'
              : codexConfig.changed
                ? 'updated'
                : 'already ready'
          out.info(`Codex MCP: ${action}`)
          out.info(
            `Codex status line: ${codexConfig.statusLineChanged ? 'installed' : 'already configured'}`
          )
        }
        if (codexHooks) {
          out.info(
            `Codex hooks: ${codexHooks.hooksWritten} new, ${codexHooks.alreadyPresent} present → ${codexHooks.hooksPath}`
          )
          out.info(`Codex features.hooks: ${codexHooks.featuresChanged ? 'enabled' : 'already on'}`)
        }
        if (geminiConfig) {
          out.info(`Gemini MCP: ${geminiConfig.mcpChanged ? 'updated' : 'already ready'}`)
          out.info(
            `Gemini hooks: ${geminiConfig.hooksWritten} new, ${geminiConfig.alreadyPresent} present → ${geminiConfig.settingsPath}`
          )
        }
        if (cursorHooks) {
          out.info(
            `Cursor hooks: ${cursorHooks.hooksWritten} new, ${cursorHooks.alreadyPresent} present → ${cursorHooks.hooksPath}`
          )
        }
        if (kimiConfig) {
          out.info(`Kimi config: ${kimiConfig.changed ? 'updated' : 'already ready'}`)
        }
        if (grokConfig) {
          const action =
            grokConfig.skipped === 'user-managed'
              ? 'user-managed MCP preserved'
              : grokConfig.changed
                ? 'updated'
                : 'already ready'
          out.info(`Grok MCP: ${action} → ${grokConfig.path}`)
        }
        if (grokSkill?.success) {
          out.info(
            `Grok skill: ${grokSkill.action ?? 'ready'}${grokSkill.path ? ` → ${grokSkill.path}` : ''}`
          )
        }
        if (grokPlugin?.success) {
          out.info(
            `Grok plugin: ${grokPlugin.changed ? 'updated' : 'already ready'} → ${grokPlugin.path}`
          )
        }
        if (opencodeConfig) {
          out.info(
            `OpenCode MCP: ${opencodeConfig.changed ? 'updated' : 'already ready'} → ${opencodeConfig.path}`
          )
        }
        if (piSkill?.success) {
          out.info(
            `Pi skill: ${piSkill.action ?? 'ready'}${piSkill.path ? ` → ${piSkill.path}` : ''}`
          )
        }
        out.info(
          `Organic board: ${coverage.liveCount}/${coverage.detectedCount} live (${coverage.organicPct}%)`
        )
        if (deltaLine) out.info(deltaLine)
        if (!ritual.organicOk) out.info('Organic gaps remain — run `prjct doctor --fix`')
        // Multi-install footgun (mem_8768): surface PATH winner vs shadows.
        try {
          const { planCleanup } = await import('./update/cleanup-installs')
          const plan = planCleanup()
          if (plan.removable.length > 0) {
            const list = plan.removable.map((r) => `${r.pm}@${r.version}`).join(', ')
            out.info(
              `Parallel installs detected (winner=${plan.winner ?? '?'}): ${list} — run \`prjct update\` to consolidate`
            )
          }
        } catch {
          /* best-effort */
        }
      }
      return {
        success: true,
        hooksWritten: result.hooksWritten,
        projectSurface: projectSurfaces?.agentsMd.action ?? 'skipped',
        detectedRuntimes: detected.length,
        organicPct: coverage.organicPct,
        liveRuntimes: coverage.liveCount,
        oneBreath: ritual.line,
        organicOk: ritual.organicOk,
        codexConfig: codexConfig
          ? {
              path: codexConfig.path,
              changed: codexConfig.changed,
              skipped: codexConfig.skipped,
              statusLineChanged: codexConfig.statusLineChanged ?? false,
            }
          : null,
        codexHooks: codexHooks
          ? {
              path: codexHooks.hooksPath,
              hooksWritten: codexHooks.hooksWritten,
              alreadyPresent: codexHooks.alreadyPresent,
              featuresChanged: codexHooks.featuresChanged,
            }
          : null,
        geminiConfig: geminiConfig
          ? {
              path: geminiConfig.settingsPath,
              mcpChanged: geminiConfig.mcpChanged,
              hooksWritten: geminiConfig.hooksWritten,
              alreadyPresent: geminiConfig.alreadyPresent,
            }
          : null,
        cursorHooks: cursorHooks
          ? {
              path: cursorHooks.hooksPath,
              hooksWritten: cursorHooks.hooksWritten,
              alreadyPresent: cursorHooks.alreadyPresent,
            }
          : null,
        kimiConfig: kimiConfig
          ? {
              path: kimiConfig.path,
              changed: kimiConfig.changed,
            }
          : null,
        grokConfig: grokConfig
          ? {
              path: grokConfig.path,
              changed: grokConfig.changed,
              skipped: grokConfig.skipped,
            }
          : null,
        grokSkill: grokSkill?.success
          ? {
              action: grokSkill.action,
              path: grokSkill.path,
            }
          : null,
        grokPlugin: grokPlugin?.success
          ? {
              path: grokPlugin.path,
              changed: grokPlugin.changed,
              files: grokPlugin.files,
            }
          : null,
      }
    } catch (error) {
      const msg = getErrorMessage(error)
      return failHard(msg)
    }
  }

  /**
   * p. uninstall — strip every prjct-managed hook out of settings.json.
   * Leaves non-prjct hooks under the same events intact.
   */
  async uninstall(
    _arg: string | null = null,
    _projectPath: string = process.cwd(),
    options: MdOption = {}
  ): Promise<CommandResult> {
    try {
      const result = await uninstallHooks()
      // Best-effort Codex cleanup — missing hooks.json is fine.
      const codex = await uninstallCodexHooks().catch(() => ({
        hooksPath: '',
        hooksRemoved: 0,
      }))
      const gemini = await uninstallGeminiSettings().catch(() => ({
        settingsPath: '',
        hooksRemoved: 0,
        mcpRemoved: false,
      }))
      const cursor = await uninstallCursorHooks().catch(() => ({
        hooksPath: '',
        hooksRemoved: 0,
      }))
      const msg = `removed ${result.hooksRemoved} Claude prjct hook(s)${
        codex.hooksRemoved > 0 ? `, ${codex.hooksRemoved} Codex hook(s)` : ''
      }${gemini.hooksRemoved > 0 || gemini.mcpRemoved ? `, Gemini cleaned` : ''}${
        cursor.hooksRemoved > 0 ? `, ${cursor.hooksRemoved} Cursor hook(s)` : ''
      }`
      if (options.md) {
        console.log(
          [
            `# prjct hooks removed`,
            ``,
            `- Claude: ${result.hooksRemoved} (\`${result.settingsPath}\`)`,
            ...(codex.hooksRemoved > 0
              ? [`- Codex: ${codex.hooksRemoved} (\`${codex.hooksPath}\`)`]
              : []),
            ...(gemini.hooksRemoved > 0 || gemini.mcpRemoved
              ? [
                  `- Gemini: ${gemini.hooksRemoved} hook(s)${gemini.mcpRemoved ? ', MCP removed' : ''} (\`${gemini.settingsPath}\`)`,
                ]
              : []),
            ...(cursor.hooksRemoved > 0
              ? [`- Cursor: ${cursor.hooksRemoved} (\`${cursor.hooksPath}\`)`]
              : []),
            ``,
          ].join('\n')
        )
      } else {
        out.done(msg)
      }
      return {
        success: true,
        hooksRemoved: result.hooksRemoved,
        codexHooksRemoved: codex.hooksRemoved,
        geminiHooksRemoved: gemini.hooksRemoved,
        geminiMcpRemoved: gemini.mcpRemoved,
        cursorHooksRemoved: cursor.hooksRemoved,
      }
    } catch (error) {
      const msg = getErrorMessage(error)
      return failHard(msg)
    }
  }

  /**
   * Introspection used by `prjct doctor`.
   */
  async status(
    _arg: string | null = null,
    _projectPath: string = process.cwd()
  ): Promise<CommandResult> {
    try {
      const s = await hookStatus()
      return { success: true, installed: s.installed, expected: s.expected }
    } catch (error) {
      return failFromError(error)
    }
  }
}
