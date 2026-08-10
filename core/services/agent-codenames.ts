/**
 * Adorable auto-names for multi-agent fan-out (Codex-style: Popper, Copernicus…).
 *
 * Pure + deterministic from a seed (work description / cycle id) so the same
 * cycle always re-surfaces the same cast. Used in orchestration directives and
 * as the default claim identity when PRJCT_AGENT is unset.
 *
 * Delight without a new verb — the cast rides on work/claim/phases output.
 */

/** Scientists, inventors, pioneers — memorable, not role-names. */
export const AGENT_CODENAME_POOL = [
  'Popper',
  'Copernicus',
  'McClintock',
  'Volta',
  'Ada',
  'Turing',
  'Hypatia',
  'Feynman',
  'Lovelace',
  'Curie',
  'Hopper',
  'Tesla',
  'Noether',
  'Faraday',
  'Kepler',
  'Mendel',
  'Dirac',
  'Shannon',
  'Babbage',
  'Boole',
  'Planck',
  'Hubble',
  'Sagan',
  'Meitner',
  'Ramanujan',
  'Euclid',
  'Gauss',
  'Fourier',
  'Pascal',
  'Archimedes',
] as const

export interface AgentCastMember {
  role: string
  name: string
}

/** Stable non-crypto hash for seed → pool index. */
export function hashSeed(seed: string): number {
  return (
    seed
      .split('')
      .reduce((hash, char) => Math.imul(hash ^ char.charCodeAt(0), 16777619), 2166136261) >>> 0
  )
}

/**
 * Pick one unique codename from the pool.
 * `exclude` skips already-claimed names (multi-agent claim races).
 */
export function pickCodename(seed: string, exclude: Iterable<string> = []): string {
  const taken = new Set([...exclude].map((s) => s.toLowerCase()))
  const pool = AGENT_CODENAME_POOL.filter((n) => !taken.has(n.toLowerCase()))
  const use = pool.length > 0 ? pool : [...AGENT_CODENAME_POOL]
  const idx = hashSeed(seed) % use.length
  return use[idx]!
}

/**
 * Assign distinct codenames to ordered roles for a fan-out cast.
 * Deterministic for (roles, seed).
 */
export function assignAgentCast(roles: string[], seed: string): AgentCastMember[] {
  const used = new Set<string>()
  return roles.map((role, index) => {
    const name = pickCodename(`${seed}::${role}::${index}`, used)
    used.add(name.toLowerCase())
    return { role, name }
  })
}

/** Roles for parallel geometry (explore → implement → review). */
export const PARALLEL_CAST_ROLES = ['explore', 'implement', 'review'] as const

/** Roles for crew geometry. */
export const CREW_CAST_ROLES = ['leader', 'implementer', 'reviewer'] as const

/**
 * One-line cast for agent prompts / work output.
 * e.g. "Cast: explore→Popper · implement→Copernicus · review→McClintock"
 */
export function formatAgentCastLine(cast: AgentCastMember[]): string {
  if (cast.length === 0) return ''
  return `Cast: ${cast.map((m) => `${m.role}→${m.name}`).join(' · ')}`
}

/**
 * Dispatch hint: use names as description labels when spawning.
 */
export function formatAgentCastDispatchHint(cast: AgentCastMember[]): string {
  if (cast.length === 0) return ''
  const bits = cast.map((m) => `\`${m.name}\` (${m.role})`)
  return `Name each subagent when you dispatch: ${bits.join(', ')}. Reuse these labels in logs/claims so the cast stays legible.`
}

/** Build cast for a fan-out mode + seed (empty for direct). */
export function castForFanout(
  fanout: 'direct' | 'parallel' | 'crew',
  seed: string
): AgentCastMember[] {
  if (fanout === 'parallel') return assignAgentCast([...PARALLEL_CAST_ROLES], seed)
  if (fanout === 'crew') return assignAgentCast([...CREW_CAST_ROLES], seed)
  return []
}
