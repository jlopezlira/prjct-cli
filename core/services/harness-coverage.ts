/**
 * Live multi-runtime harness coverage — the organic dominance board.
 *
 * Competitors can ship AGENTS.md pointers. What they cannot cheaply copy is
 * a single install that leaves *working* hooks + MCP across Claude, Codex,
 * Gemini, Cursor, and Grok (native MCP/skill + Claude-compat hooks) while
 * SQLite judgment memory and code gates stay the same brain underneath.
 *
 * This module probes real config files (not capability claims) so install,
 * agents doctor, and harness score report the same truth.
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import { getGrokSkillInstallPath } from '../infrastructure/grok-skill'
import { getPiSkillInstallPath } from '../infrastructure/pi-skill'
import { resolveUserHome } from '../infrastructure/user-home'
import { getCodexHooksJsonPath } from '../utils/codex-hooks'
import { getCodexConfigTomlPath } from '../utils/codex-mcp'
import { getCursorHooksJsonPath } from '../utils/cursor-hooks'
import { getGeminiSettingsPath } from '../utils/gemini-settings'
import { getGrokConfigTomlPath } from '../utils/grok-mcp'
import { getGrokPluginRoot } from '../utils/grok-plugin'
import {
  getOpenCodeConfigPath,
  getOpenCodeJsoncConfigPath,
  hasOpenCodePrjctMcp,
} from '../utils/opencode-mcp'
import { commandOnPathAsync } from '../utils/which'

export type OrganicLevel = 'full' | 'partial' | 'inherited' | 'none' | 'absent'

export interface RuntimeCoverage {
  id: string
  displayName: string
  /** Runtime is present on this machine (dir or command). */
  detected: boolean
  hooksLive: boolean
  mcpLive: boolean
  /** How organic the wire is right now. */
  organic: OrganicLevel
  /** One short why — path or inherit note. */
  evidence: string
}

export interface HarnessCoverageReport {
  runtimes: RuntimeCoverage[]
  detectedCount: number
  /** Detected runtimes at full or inherited. */
  liveCount: number
  /** 0–100: live / detected (100 if nothing detected — N/A treated as ready). */
  organicPct: number
  /** 0–5 grade for harness score criterion. */
  grade: number
  summary: string
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}

async function readText(p: string): Promise<string | null> {
  try {
    return await fs.readFile(p, 'utf-8')
  } catch {
    return null
  }
}

function hasPrjctManagedJson(text: string | null): boolean {
  if (!text) return false
  return text.includes('_prjctManaged') || text.includes('PRJCT_HOOK_HOST=')
}

function hasPrjctHookCommand(text: string | null): boolean {
  if (!text) return false
  return /prjct\s+hook\s+/.test(text)
}

function hasPrjctMcpJson(text: string | null): boolean {
  if (!text) return false
  try {
    const j = JSON.parse(text) as { mcpServers?: Record<string, unknown> }
    return Boolean(j.mcpServers?.prjct)
  } catch {
    return text.includes('"prjct"') && text.includes('mcp-server')
  }
}

function hasPrjctMcpToml(text: string | null): boolean {
  if (!text) return false
  return /\[mcp_servers\.prjct\]/.test(text) || /# prjct:mcp:start/.test(text)
}

function hasPrjctManagedToml(text: string | null): boolean {
  if (!text) return false
  return text.includes('# prjct-managed') || text.includes('PRJCT_HOOK_HOST=')
}

function organicOf(
  detected: boolean,
  hooks: boolean,
  mcp: boolean,
  inherited = false
): OrganicLevel {
  if (!detected) return 'absent'
  if (inherited && (hooks || mcp)) return 'inherited'
  if (hooks && mcp) return 'full'
  if (hooks || mcp) return 'partial'
  return 'none'
}

function gradeFrom(pct: number, liveCount: number, detectedCount: number): number {
  if (detectedCount === 0) return 5 // nothing to wire — not a failure
  if (liveCount >= 4 && pct >= 90) return 5
  if (liveCount >= 3 && pct >= 75) return 4.5
  if (liveCount >= 2 && pct >= 50) return 4
  if (liveCount >= 1) return 3
  return 1.5
}

/**
 * Probe installed harness surfaces on this machine.
 * Async file/PATH checks only — never throws past the report.
 */
export async function probeHarnessCoverage(
  projectPath: string = process.cwd()
): Promise<HarnessCoverageReport> {
  const home = resolveUserHome()

  const claudeSettings = path.join(home, '.claude', 'settings.json')
  const claudeMcp = path.join(home, '.claude', 'mcp.json')
  const codexHooks = getCodexHooksJsonPath()
  const codexToml = getCodexConfigTomlPath()
  const geminiSettings = getGeminiSettingsPath()
  const cursorHooks = getCursorHooksJsonPath()
  const grokHome = path.join(home, '.grok')
  const grokToml = getGrokConfigTomlPath()
  const grokSkill = getGrokSkillInstallPath()
  const grokPluginJson = path.join(getGrokPluginRoot(), 'plugin.json')
  const projectCursor = path.join(projectPath, '.cursor')
  const opencodeJson = getOpenCodeConfigPath()
  const opencodeJsonc = getOpenCodeJsoncConfigPath()
  const opencodeHome = path.join(home, '.config', 'opencode')
  const projectOpencode = path.join(projectPath, '.opencode')
  const piHome = path.join(home, '.pi')
  const piAgent = path.join(home, '.pi', 'agent')
  const piSkill = getPiSkillInstallPath()
  const projectPi = path.join(projectPath, '.pi')
  const kimiHome = path.join(home, '.kimi-code')
  const kimiToml = path.join(kimiHome, 'config.toml')
  const kimiMcp = path.join(kimiHome, 'mcp.json')
  const kimiSkill = path.join(home, '.agents', 'skills', 'prjct', 'SKILL.md')

  const [
    claudeCmd,
    codexCmd,
    geminiCmd,
    grokCmd,
    opencodeCmd,
    piCmd,
    claudeSettingsText,
    claudeMcpText,
    codexHooksText,
    codexTomlText,
    geminiText,
    cursorHooksText,
    grokTomlText,
    grokSkillExists,
    grokPluginExists,
    grokDir,
    cursorDir,
    opencodeJsonText,
    opencodeJsoncText,
    opencodeDir,
    projectOpencodeDir,
    piDir,
    piAgentDir,
    piSkillExists,
    projectPiDir,
    kimiCmd,
    kimiTomlText,
    kimiMcpText,
    kimiSkillExists,
    kimiDir,
  ] = await Promise.all([
    commandOnPathAsync('claude'),
    commandOnPathAsync('codex'),
    commandOnPathAsync('gemini'),
    commandOnPathAsync('grok'),
    commandOnPathAsync('opencode'),
    commandOnPathAsync('pi'),
    readText(claudeSettings),
    readText(claudeMcp),
    readText(codexHooks),
    readText(codexToml),
    readText(geminiSettings),
    readText(cursorHooks),
    readText(grokToml),
    fileExists(grokSkill),
    fileExists(grokPluginJson),
    fileExists(grokHome),
    fileExists(projectCursor),
    readText(opencodeJson),
    readText(opencodeJsonc),
    fileExists(opencodeHome),
    fileExists(projectOpencode),
    fileExists(piHome),
    fileExists(piAgent),
    fileExists(piSkill),
    fileExists(projectPi),
    commandOnPathAsync('kimi'),
    readText(kimiToml),
    readText(kimiMcp),
    fileExists(kimiSkill),
    fileExists(kimiHome),
  ])

  const claudeDetected = claudeCmd || (await fileExists(path.join(home, '.claude')))
  const claudeHooks =
    hasPrjctManagedJson(claudeSettingsText) || hasPrjctHookCommand(claudeSettingsText)
  const claudeMcpLive = hasPrjctMcpJson(claudeMcpText)

  const codexDetected = codexCmd || (await fileExists(path.join(home, '.codex')))
  const codexHooksLive = hasPrjctManagedJson(codexHooksText) || hasPrjctHookCommand(codexHooksText)
  const codexMcpLive = hasPrjctMcpToml(codexTomlText)

  const geminiDetected = geminiCmd || (await fileExists(path.join(home, '.gemini')))
  const geminiHooksLive = hasPrjctManagedJson(geminiText) || hasPrjctHookCommand(geminiText)
  const geminiMcpLive = hasPrjctMcpJson(geminiText)

  const cursorDetected = cursorDir || (await fileExists(path.join(home, '.cursor')))
  const cursorHooksLive =
    hasPrjctManagedJson(cursorHooksText) || hasPrjctHookCommand(cursorHooksText)

  const grokDetected = grokCmd || grokDir
  const grokNativeMcp = hasPrjctMcpToml(grokTomlText)
  const grokNativeSkill = Boolean(grokSkillExists)
  const grokNativePlugin = Boolean(grokPluginExists)
  const grokHasNative = grokNativeMcp || grokNativeSkill || grokNativePlugin
  // Hooks still fire via Claude-compat settings; MCP can be native and/or Claude.
  const grokHooksLive = Boolean(claudeHooks)
  const grokMcpLive = grokNativeMcp || claudeMcpLive

  const opencodeDetected = Boolean(opencodeCmd || opencodeDir || projectOpencodeDir)
  const opencodeMcpLive =
    hasOpenCodePrjctMcp(opencodeJsonText) || hasOpenCodePrjctMcp(opencodeJsoncText)

  const piDetected = Boolean(piCmd || piDir || piAgentDir || projectPiDir)
  const piSkillLive = Boolean(piSkillExists)

  const kimiDetected = Boolean(kimiCmd || kimiDir)
  const kimiHooksLive = hasPrjctManagedToml(kimiTomlText) || hasPrjctHookCommand(kimiTomlText)
  const kimiMcpLive = hasPrjctMcpJson(kimiMcpText)
  const kimiSkillLive = Boolean(kimiSkillExists)

  const runtimes: RuntimeCoverage[] = [
    {
      id: 'claude',
      displayName: 'Claude Code',
      detected: Boolean(claudeDetected),
      hooksLive: claudeHooks,
      mcpLive: claudeMcpLive,
      organic: organicOf(Boolean(claudeDetected), claudeHooks, claudeMcpLive),
      evidence:
        claudeHooks && claudeMcpLive
          ? '~/.claude/settings.json + mcp.json'
          : claudeHooks
            ? 'hooks only'
            : claudeMcpLive
              ? 'mcp only'
              : claudeDetected
                ? 'detected, not wired'
                : 'not installed',
    },
    {
      id: 'codex',
      displayName: 'OpenAI Codex',
      detected: Boolean(codexDetected),
      hooksLive: codexHooksLive,
      mcpLive: codexMcpLive,
      organic: organicOf(Boolean(codexDetected), codexHooksLive, codexMcpLive),
      evidence:
        codexHooksLive && codexMcpLive
          ? '~/.codex/hooks.json + config.toml MCP'
          : codexDetected
            ? 'detected, incomplete wire'
            : 'not installed',
    },
    {
      id: 'gemini',
      displayName: 'Gemini CLI',
      detected: Boolean(geminiDetected),
      hooksLive: geminiHooksLive,
      mcpLive: geminiMcpLive,
      organic: organicOf(Boolean(geminiDetected), geminiHooksLive, geminiMcpLive),
      evidence:
        geminiHooksLive && geminiMcpLive
          ? '~/.gemini/settings.json (hooks+MCP)'
          : geminiDetected
            ? 'detected, incomplete wire'
            : 'not installed',
    },
    {
      id: 'cursor',
      displayName: 'Cursor',
      detected: Boolean(cursorDetected),
      hooksLive: cursorHooksLive,
      mcpLive: false, // MCP stays IDE UI — hooks are the organic wire
      organic: !cursorDetected
        ? 'absent'
        : cursorHooksLive
          ? 'full' // hooks-only is full for Cursor (MCP is in-app)
          : 'none',
      evidence: cursorHooksLive
        ? '~/.cursor/hooks.json'
        : cursorDetected
          ? 'detected, hooks not wired'
          : 'not installed',
    },
    {
      id: 'grok',
      displayName: 'xAI Grok Build',
      detected: Boolean(grokDetected),
      hooksLive: grokHooksLive,
      mcpLive: grokMcpLive,
      // Native MCP/skill → full/partial; Claude-only fallback → inherited.
      organic: organicOf(
        Boolean(grokDetected),
        grokHooksLive,
        grokMcpLive,
        !grokHasNative && (claudeHooks || claudeMcpLive)
      ),
      evidence: grokDetected
        ? grokNativeMcp && (grokNativeSkill || grokNativePlugin)
          ? `~/.grok/config.toml MCP + ${grokNativePlugin ? 'plugins/prjct' : 'skills/prjct'} (hooks via Claude compat)`
          : grokNativeMcp
            ? '~/.grok/config.toml MCP (hooks via Claude compat)'
            : grokNativeSkill || grokNativePlugin
              ? `${grokNativePlugin ? 'plugins/prjct' : 'skills/prjct'} (MCP via Claude compat or missing)`
              : claudeHooks || claudeMcpLive
                ? 'Claude-compat only — run prjct install for native Grok MCP+skill+plugin'
                : 'detected — run prjct install'
        : 'not installed',
    },
    {
      id: 'opencode',
      displayName: 'OpenCode',
      detected: opencodeDetected,
      hooksLive: false, // no Claude-parity hook pack
      mcpLive: opencodeMcpLive,
      // MCP-only is full for OpenCode (same model as Cursor hooks-only).
      organic: !opencodeDetected ? 'absent' : opencodeMcpLive ? 'full' : 'none',
      evidence: opencodeMcpLive
        ? '~/.config/opencode/opencode.json mcp.prjct'
        : opencodeDetected
          ? 'detected — run prjct install for OpenCode MCP'
          : 'not installed',
    },
    {
      id: 'pi',
      displayName: 'Pi',
      detected: piDetected,
      hooksLive: false,
      mcpLive: false, // Pi has no native MCP
      // Skill-only is full for Pi (anti-MCP-by-default design).
      organic: !piDetected ? 'absent' : piSkillLive ? 'full' : 'none',
      evidence: piSkillLive
        ? '~/.pi/agent/skills/prjct/SKILL.md'
        : piDetected
          ? 'detected — run prjct install for Pi skill'
          : 'not installed',
    },
    {
      id: 'kimi-cli',
      displayName: 'Kimi Code CLI',
      detected: kimiDetected,
      hooksLive: kimiHooksLive,
      mcpLive: kimiMcpLive,
      organic: organicOf(kimiDetected, kimiHooksLive, kimiMcpLive),
      evidence:
        kimiHooksLive && kimiMcpLive
          ? `~/.kimi-code/config.toml [[hooks]] + mcp.json${kimiSkillLive ? ' + ~/.agents/skills' : ''}`
          : kimiHooksLive || kimiMcpLive
            ? 'partial wire — run prjct install'
            : kimiDetected
              ? 'detected, not wired — run prjct install'
              : 'not installed',
    },
  ]

  const detected = runtimes.filter((r) => r.detected)
  const live = detected.filter((r) => r.organic === 'full' || r.organic === 'inherited')
  const detectedCount = detected.length
  const liveCount = live.length
  const organicPct = detectedCount === 0 ? 100 : Math.round((liveCount / detectedCount) * 100)
  const grade = gradeFrom(organicPct, liveCount, detectedCount)

  const summary =
    detectedCount === 0
      ? 'No benchmark CLI/IDE detected — install Claude, Codex, Gemini, Cursor, OpenCode, Pi, Kimi Code, or Grok, then `prjct install`.'
      : liveCount === detectedCount
        ? `Organic full board: ${liveCount}/${detectedCount} detected runtimes live (${organicPct}%). Same SQLite brain, multi-surface wire.`
        : `Organic board ${liveCount}/${detectedCount} live (${organicPct}%). Run \`prjct install\` to close gaps — one command, all surfaces.`

  return {
    runtimes,
    detectedCount,
    liveCount,
    organicPct,
    grade,
    summary,
  }
}

/** Markdown dominance board — install / doctor / harness score. */
export function renderHarnessCoverageMd(report: HarnessCoverageReport): string {
  const lines = [
    '## Organic multi-runtime board',
    '',
    `_Same judgment memory + code gates · ${report.liveCount}/${report.detectedCount} live · ${report.organicPct}% · grade ${report.grade}/5_`,
    '',
    '| Runtime | Detected | Hooks | MCP | Organic | Evidence |',
    '|---|---:|---:|---:|---|---|',
  ]
  for (const r of report.runtimes) {
    lines.push(
      `| ${r.displayName} | ${r.detected ? 'yes' : '—'} | ${r.hooksLive ? '●' : '○'} | ${r.mcpLive ? '●' : r.id === 'cursor' ? 'IDE' : r.id === 'pi' ? 'skill' : '○'} | \`${r.organic}\` | ${r.evidence} |`
    )
  }
  lines.push('', report.summary, '')
  lines.push(
    '_Moat: not “another skill pack” — compound WHY in SQLite, code-enforced gates, and one install that lights every agent surface without ceremony._',
    ''
  )
  return lines.join('\n')
}
