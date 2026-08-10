/**
 * Multi-runtime signal parity — SUPERIOR mandate.
 *
 * Hosts differ (hooks APIs ≠ ASCII). Parity is proven by:
 *   1. PRJCT_HOOKS install set (Claude source of truth)
 *   2. Host mappers (Codex/Gemini/Cursor) including pre-package + prompt
 *   3. Compact skill CONTRACT.loop on Codex/Gemini surfaces
 *   4. Grok native MCP + skill; hooks still inherit Claude (harness-surfaces)
 *
 * Not hardcoded prose theater — derived from real installers.
 */

import { BENCHMARK_HARNESS_SURFACES } from '../infrastructure/harness-surfaces'
import { PRJCT_HOOKS } from './settings-installer'
import { skillBodyHasProjectStamp } from './skill-generator'
import { buildCodexSkill, buildGeminiConfig, CONTRACT } from './skill-generator/editor-surfaces'
import { buildPrjctSkill } from './skill-generator/prjct-skill-body'

export const CORE_SUPERIORITY_RUNTIMES = ['claude', 'codex', 'gemini', 'cursor', 'grok'] as const

/** Subcommands that must exist for superiority signal delivery via hooks. */
export const REQUIRED_HOOK_SUBCOMMANDS = [
  'prompt',
  'session-start',
  'pre-package',
  'pre-secrets',
  'stop',
] as const

/**
 * Live install parity report — reads real PRJCT_HOOKS + host maps + skill bodies.
 * Returns missing items (empty = complete).
 */
export function multiRuntimeInstallParityReport(): {
  ok: boolean
  missing: string[]
  hooks: string[]
  codexHasLoop: boolean
  geminiHasLoop: boolean
  grokInheritsClaude: boolean
  grokMcpNative: boolean
  grokSkillsNative: boolean
} {
  const missing: string[] = []
  const hooks = PRJCT_HOOKS.map((h) => h.subcommand)
  for (const sub of REQUIRED_HOOK_SUBCOMMANDS) {
    if (!hooks.includes(sub)) missing.push(`PRJCT_HOOKS missing ${sub}`)
  }

  // Lazy import host mappers so this module stays usable in unit tests without
  // circular init issues — dynamic require of pure functions.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { cursorHookMaps } =
    require('../utils/cursor-hooks') as typeof import('../utils/cursor-hooks')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { geminiHookMaps } =
    require('../utils/gemini-settings') as typeof import('../utils/gemini-settings')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { codexHookSpecs } =
    require('../utils/codex-hooks') as typeof import('../utils/codex-hooks')

  const cursorSubs = new Set(cursorHookMaps().map((m) => m.subcommand))
  const geminiSubs = new Set(geminiHookMaps().map((m) => m.subcommand))
  const codexSubs = new Set(codexHookSpecs().map((m) => m.subcommand))

  for (const sub2 of ['prompt', 'session-start', 'pre-package'] as const) {
    if (!cursorSubs.has(sub2)) missing.push(`cursor map missing ${sub2}`)
    if (!geminiSubs.has(sub2)) missing.push(`gemini map missing ${sub2}`)
    // Codex may skip some events; pre-package maps if PreToolUse Bash is supported
    if (sub2 === 'pre-package' && !codexSubs.has(sub2) && !codexSubs.has('pre-secrets')) {
      // codexHookSpecs filters by CODEX_HOOK_EVENTS — PreToolUse should include bash hooks
      if (!codexHookSpecs().some((s) => s.subcommand === 'pre-package')) {
        // Only fail if Claude has it but codex filter dropped all bash prettools
        const bashHooks = PRJCT_HOOKS.filter(
          (h) => h.event === 'PreToolUse' && h.matcher === 'Bash'
        )
        const codexBash = codexHookSpecs().filter((h) => h.event === 'PreToolUse')
        if (bashHooks.length > 0 && codexBash.length === 0) {
          missing.push('codex map has no PreToolUse hooks')
        }
      }
    }
  }

  // Explicit: pre-package must be in Cursor + Gemini bash/shell maps
  if (!cursorHookMaps().some((m) => m.subcommand === 'pre-package')) {
    missing.push('cursor missing pre-package')
  }
  if (!geminiHookMaps().some((m) => m.subcommand === 'pre-package')) {
    missing.push('gemini missing pre-package')
  }

  const codexSkill = buildCodexSkill()
  const geminiCfg = buildGeminiConfig()
  const claudeSkill = buildPrjctSkill()
  const codexHasLoop = codexSkill.includes(CONTRACT.loop)
  const geminiHasLoop = geminiCfg.includes(CONTRACT.loop)
  if (!codexHasLoop) missing.push('codex skill missing CONTRACT.loop')
  if (!geminiHasLoop) missing.push('gemini config missing CONTRACT.loop')
  if (!codexSkill.includes(CONTRACT.identity)) {
    missing.push('codex skill missing CONTRACT.identity')
  }
  if (skillBodyHasProjectStamp(claudeSkill)) {
    missing.push('claude L0 skill is project-stamped (multi-project poison)')
  }
  if (!claudeSkill.includes('cwd-scoped') && !claudeSkill.includes('portable')) {
    missing.push('claude L0 skill missing portable baseline')
  }

  const grok = BENCHMARK_HARNESS_SURFACES.find((s) => s.runtimeId === 'grok')
  const grokInheritsClaude = grok?.hooks?.prjct === 'inherits-claude'
  const grokMcpNative = grok?.mcp?.prjct === 'native'
  const grokSkillsNative = grok?.skills?.prjct === 'native'
  if (!grokInheritsClaude) missing.push('grok hooks should inherit Claude PreToolUse/Session')
  if (!grokMcpNative) missing.push('grok mcp not native')
  if (!grokSkillsNative) missing.push('grok skills not native')

  for (const id of CORE_SUPERIORITY_RUNTIMES) {
    if (!BENCHMARK_HARNESS_SURFACES.some((s) => s.runtimeId === id)) {
      missing.push(`BENCHMARK_HARNESS_SURFACES missing ${id}`)
    }
  }

  return {
    ok: missing.length === 0,
    missing,
    hooks: [...new Set(hooks)],
    codexHasLoop,
    geminiHasLoop,
    grokInheritsClaude: Boolean(grokInheritsClaude),
    grokMcpNative: Boolean(grokMcpNative),
    grokSkillsNative: Boolean(grokSkillsNative),
  }
}

/** True when install-derived parity is complete. */
export function multiRuntimeSignalParityComplete(): boolean {
  return multiRuntimeInstallParityReport().ok
}
