/**
 * Machine-local LLM brain profiles — non-secret config in global.json.
 *
 * Merge semantics (retrocompatible with multi-set workflows):
 * - upsert by name merges patch onto existing; undefined fields keep prior values
 * - first create requires enough fields to form a complete profile
 * - active pointer falls back if deleted
 * - PRJCT_LLM_PROFILE env overrides active for the process (does not persist)
 *
 * Keys live in secure-key.ts — never here.
 */

import { getConfig, setConfig } from '../services/global-config'
import { isLocalBaseUrl, normalizeChatModelForBaseUrl, slugifyProfileName } from './detect'
import type { LlmProfile, LlmProfilePatch, LlmProfilesState, LlmWireKind } from './types'

const K_ACTIVE = 'llm.active'
const K_PROFILES = 'llm.profiles'

/** Session override for active profile — never written to disk. */
export const LLM_PROFILE_ENV = 'PRJCT_LLM_PROFILE'

function parseProfiles(raw: unknown): LlmProfile[] {
  if (typeof raw !== 'string' || !raw.trim()) return []
  try {
    const arr = JSON.parse(raw)
    if (!Array.isArray(arr)) return []
    const out: LlmProfile[] = []
    for (const item of arr) {
      const p = coerceProfile(item)
      if (p) out.push(p)
    }
    return out
  } catch {
    return []
  }
}

function coerceProfile(item: unknown): LlmProfile | null {
  if (!item || typeof item !== 'object') return null
  const p = item as Record<string, unknown>
  const name = typeof p.name === 'string' ? slugifyProfileName(p.name) : ''
  const baseUrl = typeof p.baseUrl === 'string' ? p.baseUrl.trim().replace(/\/+$/, '') : ''
  const model = typeof p.model === 'string' ? p.model.trim() : ''
  if (!name || !baseUrl || !model) return null
  const wire: LlmWireKind = p.wire === 'anthropic' ? 'anthropic' : 'openai-compatible'
  const profile: LlmProfile = {
    name,
    wire,
    providerLabel: typeof p.providerLabel === 'string' ? p.providerLabel : wire,
    baseUrl,
    model: normalizeChatModelForBaseUrl(model, baseUrl),
  }
  if (typeof p.authHeader === 'string') profile.authHeader = p.authHeader
  if (typeof p.authScheme === 'string') profile.authScheme = p.authScheme
  if (p.extraHeaders && typeof p.extraHeaders === 'object' && !Array.isArray(p.extraHeaders)) {
    profile.extraHeaders = p.extraHeaders as Record<string, string>
  }
  if (p.weak === true) profile.weak = true
  if (p.weak === false) profile.weak = false
  return profile
}

function persist(profiles: LlmProfile[], active: string | null): void {
  setConfig(K_PROFILES, JSON.stringify(profiles))
  setConfig(K_ACTIVE, active ?? undefined)
}

export function listLlmProfiles(): LlmProfilesState {
  const profiles = parseProfiles(getConfig(K_PROFILES))
  const activeRaw = getConfig(K_ACTIVE)
  const configuredActive: string | null =
    typeof activeRaw === 'string' && activeRaw.trim()
      ? slugifyProfileName(activeRaw)
      : (profiles[0]?.name ?? null)
  const active =
    configuredActive && profiles.some((profile) => profile.name === configuredActive)
      ? configuredActive
      : (profiles[0]?.name ?? null)
  return { active, profiles }
}

export function getLlmProfile(name: string): LlmProfile | null {
  const slug = slugifyProfileName(name)
  return listLlmProfiles().profiles.find((p) => p.name === slug) ?? null
}

/**
 * Active profile for this process:
 * 1. PRJCT_LLM_PROFILE env (if it names a known profile)
 * 2. persisted llm.active
 */
export function getActiveLlmProfile(): LlmProfile | null {
  const state = listLlmProfiles()
  if (state.profiles.length === 0) return null

  const envName = process.env[LLM_PROFILE_ENV]?.trim()
  if (envName) {
    const fromEnv = state.profiles.find((p) => p.name === slugifyProfileName(envName))
    if (fromEnv) return fromEnv
  }
  if (!state.active) return null
  return state.profiles.find((p) => p.name === state.active) ?? null
}

/**
 * Whether a complete profile can be formed from patch (+ optional existing).
 */
export function canCompleteProfile(
  patch: LlmProfilePatch,
  existing: LlmProfile | null
): { ok: true; profile: LlmProfile } | { ok: false; missing: string[] } {
  const name = slugifyProfileName(patch.name)
  const baseUrl = (patch.baseUrl ?? existing?.baseUrl)?.trim().replace(/\/+$/, '')
  const modelRaw = (patch.model ?? existing?.model)?.trim()
  const wire: LlmWireKind | undefined = patch.wire ?? existing?.wire
  const providerLabel = patch.providerLabel ?? existing?.providerLabel

  const missing: string[] = []
  if (!baseUrl) missing.push('baseUrl')
  if (!modelRaw) missing.push('model')
  if (!wire) missing.push('wire')
  if (missing.length) return { ok: false, missing }

  const model = normalizeChatModelForBaseUrl(modelRaw as string, baseUrl as string)
  const profile: LlmProfile = {
    name,
    wire: wire as LlmWireKind,
    providerLabel: providerLabel ?? (wire as string),
    baseUrl: baseUrl as string,
    model,
  }

  // auth: null clears; undefined keeps existing; string sets
  if (patch.authHeader === null) {
    /* omit */
  } else if (typeof patch.authHeader === 'string') {
    profile.authHeader = patch.authHeader
  } else if (existing?.authHeader !== undefined) {
    profile.authHeader = existing.authHeader
  }

  if (patch.authScheme === null) {
    /* omit */
  } else if (typeof patch.authScheme === 'string') {
    profile.authScheme = patch.authScheme
  } else if (existing?.authScheme !== undefined) {
    profile.authScheme = existing.authScheme
  }

  if (patch.extraHeaders === null) {
    /* omit */
  } else if (patch.extraHeaders) {
    profile.extraHeaders = patch.extraHeaders
  } else if (existing?.extraHeaders) {
    profile.extraHeaders = existing.extraHeaders
  }

  if (patch.weak === null) {
    /* omit → heuristics */
  } else if (patch.weak === true || patch.weak === false) {
    profile.weak = patch.weak
  } else if (existing?.weak === true || existing?.weak === false) {
    profile.weak = existing.weak
  }

  return { ok: true, profile }
}

/**
 * Upsert with merge. activate defaults true for new profiles and when
 * activate is explicitly true; partial updates keep prior active unless activate.
 */
export function upsertLlmProfile(
  patch: LlmProfilePatch,
  opts: { activate?: boolean } = {}
): LlmProfile {
  const name = slugifyProfileName(patch.name)
  const state = listLlmProfiles()
  const existing = state.profiles.find((p) => p.name === name) ?? null
  const completed = canCompleteProfile({ ...patch, name }, existing)
  if (!completed.ok) {
    throw new Error(
      `Incomplete LLM profile '${name}' — missing: ${completed.missing.join(', ')}. ` +
        `Provide --base-url and --model (or --key for auto-detect), or set a full profile first.`
    )
  }
  const profile = completed.profile
  const next = state.profiles.filter((p) => p.name !== name)
  next.push(profile)
  next.sort((a, b) => a.name.localeCompare(b.name))

  const isNew = !existing
  // activate: true → always; false → keep prior; undefined → activate if new or none active
  const desiredActive =
    opts.activate === true || (opts.activate !== false && (isNew || !state.active))
      ? name
      : state.active
  const active =
    desiredActive && next.some((profile) => profile.name === desiredActive)
      ? desiredActive
      : (next[0]?.name ?? null)

  persist(next, active)
  return profile
}

export function setActiveLlmProfile(name: string): LlmProfile {
  const slug = slugifyProfileName(name)
  const profile = getLlmProfile(slug)
  if (!profile) {
    throw new Error(`Unknown LLM profile '${slug}'. Run: prjct llm status`)
  }
  const state = listLlmProfiles()
  persist(state.profiles, slug)
  return profile
}

export function removeLlmProfile(name: string): boolean {
  const slug = slugifyProfileName(name)
  const state = listLlmProfiles()
  const next = state.profiles.filter((p) => p.name !== slug)
  if (next.length === state.profiles.length) return false
  const active = state.active === slug ? (next[0]?.name ?? null) : state.active
  persist(next, active)
  return true
}

export function clearAllLlmProfiles(): string[] {
  const names = listLlmProfiles().profiles.map((p) => p.name)
  persist([], null)
  return names
}

/** Effective weak-mode for a profile (explicit flag or heuristics). */
export function profileImpliesWeakMode(profile: LlmProfile): boolean {
  if (profile.weak === true) return true
  if (profile.weak === false) return false
  if (isLocalBaseUrl(profile.baseUrl)) return true
  if (
    /\b([1-7])b\b/i.test(profile.model) &&
    /ollama|lm studio|local/i.test(profile.providerLabel)
  ) {
    return true
  }
  return false
}
