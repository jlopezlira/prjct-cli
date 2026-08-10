/**
 * Pack manager — read/write which packs are active in a project.
 *
 * Source of truth: `persona.packs: string[]` in `.prjct/prjct.config.json`.
 * Pack manifests live in code (`manifests.ts`), not on disk — the user
 * doesn't need to author them, only activate/deactivate.
 *
 * All mutations go through `updateConfig()` so reads reflect writes and
 * we don't clobber unrelated config fields.
 */

import configManager from '../infrastructure/config-manager'
import type { LocalConfig, ProjectPersona } from '../types/config'
import { getPackManifest, PACK_MANIFESTS, type PackManifest } from './manifests'

/**
 * Auto-detect heuristic for a fresh repo. Returns a prioritized list of
 * pack names the user might want. Pure suggestion — never written
 * without explicit consent from the caller (humans or Claude opting in).
 *
 * Intentionally conservative: we only add `code` when the signals are
 * unambiguous. `daily` is suggested always because GTD-style capture
 * helps every context.
 */
export async function detectSuggestedPacks(projectPath: string): Promise<string[]> {
  const fs = await import('node:fs/promises')
  const path = await import('node:path')
  const out = new Set<string>(['daily'])

  const codeSignals = [
    'package.json',
    'go.mod',
    'Cargo.toml',
    'pyproject.toml',
    'Gemfile',
    'pom.xml',
    'build.gradle',
  ]
  for (const s of codeSignals) {
    try {
      await fs.stat(path.join(projectPath, s))
      out.add('code')
      break
    } catch {
      // not a signal — keep scanning
    }
  }

  return [...out]
}

export type AnticipationEnsureResult = {
  healed: boolean
  activated: string[]
  reason:
    | 'no-config'
    | 'conflictMode-off'
    | 'already-coding-pack'
    | 'conflictMode-healed'
    | 'not-code-repo'
    | 'activated-code'
    | 'noop'
}

/**
 * Product default for world-class build loop: coding repos get pack `code`
 * (conflictMode advisory + land strict) without a second `prjct pack add`.
 *
 * Heals projects that only have projectId/cloud (pre-pack era) so anticipation
 * is ON by default. Idempotent. Never overrides explicit `conflictMode: off`.
 */
export async function ensureCodingAnticipationDefaults(
  projectPath: string
): Promise<AnticipationEnsureResult> {
  const existing = await configManager.readConfig(projectPath)
  if (!existing) {
    return { healed: false, activated: [], reason: 'no-config' }
  }

  // Explicit opt-out — quiet mode stays quiet.
  if (existing.judgment?.conflictMode === 'off') {
    return { healed: false, activated: [], reason: 'conflictMode-off' }
  }

  const packs = existing.persona?.packs ?? []
  const hasCodePack = packs.includes('code') || packs.includes('code-strict')

  if (hasCodePack) {
    // Pack present but conflictMode never stamped (legacy activate path).
    if (!existing.judgment?.conflictMode && packs.includes('code')) {
      await configManager.writeConfig(projectPath, {
        ...existing,
        judgment: {
          ...existing.judgment,
          conflictMode: 'advisory',
        },
      })
      return { healed: true, activated: [], reason: 'conflictMode-healed' }
    }
    return { healed: false, activated: [], reason: 'already-coding-pack' }
  }

  const suggested = await detectSuggestedPacks(projectPath)
  if (!suggested.includes('code')) {
    return { healed: false, activated: [], reason: 'not-code-repo' }
  }

  const result = await activatePacks(projectPath, ['code'], { suggestPersona: true })
  if (result.activated.includes('code')) {
    return { healed: true, activated: result.activated, reason: 'activated-code' }
  }
  return { healed: false, activated: [], reason: 'noop' }
}

export async function activatePacks(
  projectPath: string,
  packNames: string[],
  opts: { suggestPersona?: boolean } = {}
): Promise<{ activated: string[]; skipped: string[] }> {
  const activated: string[] = []
  const skipped: string[] = []

  const existing = await configManager.readConfig(projectPath)
  if (!existing) {
    throw new Error('No prjct project here — run `prjct init` first.')
  }

  const currentPersona: ProjectPersona = existing.persona ?? { role: 'DEV' }
  const currentPacks = new Set(currentPersona.packs ?? [])

  for (const name of packNames) {
    if (!PACK_MANIFESTS[name]) {
      skipped.push(name)
      continue
    }
    if (currentPacks.has(name)) continue
    currentPacks.add(name)
    activated.push(name)
  }

  const mergedPacks = [...currentPacks]
  const nextPersona: ProjectPersona = {
    ...currentPersona,
    packs: mergedPacks,
  }

  // Persona suggestion: if caller asks and the current persona is still
  // the default (`role: "DEV"`) + unspecified MCPs, lift the first
  // activated pack's suggestedPersona onto the config. Never overwrites
  // user-set values.
  if (opts.suggestPersona && activated.length > 0) {
    applyPersonaSuggestion(nextPersona, activated)
  }

  const nextConfig: LocalConfig = {
    ...existing,
    persona: nextPersona,
    ...packConfigDefaults(existing, activated),
  }
  await configManager.writeConfig(projectPath, nextConfig)

  // Marketplace-lite: stamp version@integrity for newly activated packs.
  if (activated.length > 0 && existing.projectId) {
    try {
      const { stampPackInstalls } = await import('./pack-integrity')
      stampPackInstalls(existing.projectId, activated)
    } catch {
      /* integrity stamp is audit-only — never block activation */
    }
  }

  return { activated, skipped }
}

/** First-activation defaults from pack manifests — never overwrite set fields. */
function packConfigDefaults(existing: LocalConfig, activated: string[]): Partial<LocalConfig> {
  const patch: Partial<LocalConfig> = {}
  for (const name of activated) {
    const defaults = PACK_MANIFESTS[name]?.configDefaults
    if (!defaults) continue
    if (defaults.sdd && !existing.sdd) patch.sdd = { mode: defaults.sdd }
    if (defaults.tdd && !existing.tdd) patch.tdd = { mode: defaults.tdd }
    if (
      defaults.maxTurnsPerCycle != null &&
      existing.maxTurnsPerCycle == null &&
      patch.maxTurnsPerCycle == null
    ) {
      patch.maxTurnsPerCycle = defaults.maxTurnsPerCycle
    }
    if (defaults.deliveryGeometry && !existing.deliveryGeometry) {
      patch.deliveryGeometry = { mode: defaults.deliveryGeometry }
    }
    if (defaults.land && !existing.land) {
      patch.land = { mode: defaults.land }
    }
    if (defaults.conflictMode && !existing.judgment?.conflictMode) {
      patch.judgment = {
        ...existing.judgment,
        ...patch.judgment,
        conflictMode: defaults.conflictMode,
      }
    }
  }
  return patch
}

export async function deactivatePacks(
  projectPath: string,
  packNames: string[]
): Promise<{ deactivated: string[]; notActive: string[] }> {
  const existing = await configManager.readConfig(projectPath)
  if (!existing) throw new Error('No prjct project here — run `prjct init` first.')

  const currentPersona: ProjectPersona = existing.persona ?? { role: 'DEV' }
  const currentPacks = new Set(currentPersona.packs ?? [])

  const deactivated: string[] = []
  const notActive: string[] = []

  for (const name of packNames) {
    if (currentPacks.delete(name)) deactivated.push(name)
    else notActive.push(name)
  }

  const nextPersona: ProjectPersona = { ...currentPersona, packs: [...currentPacks] }
  const nextConfig: LocalConfig = { ...existing, persona: nextPersona }
  await configManager.writeConfig(projectPath, nextConfig)

  if (deactivated.length > 0 && existing.projectId) {
    try {
      const { clearPackInstalls } = await import('./pack-integrity')
      clearPackInstalls(existing.projectId, deactivated)
    } catch {
      /* audit-only */
    }
  }

  return { deactivated, notActive }
}

export interface ActivatedPackSummary {
  name: string
  description: string
  memoryTypes: string[]
  slots: string[]
  version?: string
  integrity?: string
  status?: string
}

export async function listActivePacks(projectPath: string): Promise<ActivatedPackSummary[]> {
  const config = await configManager.readConfig(projectPath)
  const active = config?.persona?.packs ?? []
  const catalog = await import('./pack-integrity')
    .then(({ buildPackCatalog }) => buildPackCatalog(projectPath))
    .catch(() => [])
  const integrityByName = Object.fromEntries(
    catalog
      .filter((entry) => entry.active)
      .map((entry) => [
        entry.name,
        { version: entry.version, integrity: entry.integrity, status: entry.status },
      ])
  )
  const summaries: ActivatedPackSummary[] = []
  for (const name of active) {
    const m = PACK_MANIFESTS[name]
    if (!m) {
      const meta = integrityByName[name]
      summaries.push({
        name,
        description: 'Unknown pack (not in built-in catalog)',
        memoryTypes: [],
        slots: [],
        version: meta?.version,
        integrity: meta?.integrity,
        status: meta?.status ?? 'unknown',
      })
      continue
    }
    const meta = integrityByName[name]
    summaries.push({
      name: m.name,
      description: m.description,
      memoryTypes: m.memoryTypes,
      slots: Object.keys(m.workflowSlots),
      version: meta?.version ?? m.version,
      integrity: meta?.integrity,
      status: meta?.status ?? 'active',
    })
  }
  return summaries
}

function applyPersonaSuggestion(persona: ProjectPersona, activatedPackNames: string[]): void {
  const hasCustomRole = persona.role && persona.role !== 'DEV'
  const hasMcps = persona.mcps && persona.mcps.length > 0

  for (const name of activatedPackNames) {
    const m: PackManifest | null = getPackManifest(name)
    if (!m?.suggestedPersona) continue

    if (!hasCustomRole && m.suggestedPersona.role) {
      persona.role = m.suggestedPersona.role
    }
    if (!persona.focus && m.suggestedPersona.focus) {
      persona.focus = m.suggestedPersona.focus
    }
    if (!hasMcps && m.suggestedPersona.mcps) {
      persona.mcps = [...m.suggestedPersona.mcps]
    }
    // First suggesting pack wins — stop after the first useful one.
    if (persona.role && persona.role !== 'DEV') break
  }
}
