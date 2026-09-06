/**
 * Say something when the config contains a key prjct will ignore.
 *
 * `readConfig` casts parsed JSON straight to `LocalConfig` — a cast, not a
 * check — so a typo like `maxTokenPerCycle` parses fine, is silently ignored,
 * and the feature it was meant to enable simply never runs. The author has no
 * way to tell that from the feature being broken.
 *
 * deepseek-harness fails plugin construction on an unrecognized key. That is
 * right for a runtime that owns startup; prjct reads config inside hooks that
 * must never brick a session, so this reports instead of throwing — but it
 * reports loudly, names the near-miss, and surfaces in `prjct doctor` where a
 * `console.warn` from a hook would never be seen.
 */

/** Every top-level key `LocalConfig` defines. */
export const KNOWN_CONFIG_KEYS: readonly string[] = [
  'projectId',
  'dataPath',
  'showMetrics',
  'verification',
  'persona',
  'lean',
  'tdd',
  'sdd',
  'maxTurnsPerCycle',
  'maxTurnsPerSession',
  'maxTokensPerCycle',
  'contextPressure',
  'delivery',
  'deliveryGeometry',
  'land',
  'judgment',
  'qa',
  'notify',
  'enforce',
  'gauntlet',
  'harness',
  'retention',
  'multiAgent',
  'embeddings',
  'cloud',
]

export interface UnknownConfigKey {
  key: string
  /** Closest known key, when one is near enough to be a plausible typo. */
  didYouMean: string | null
}

/** Single-character edit distance, capped — enough to catch a typo. */
function editDistance(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 3) return 99
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i)
  const row = [...prev]
  for (const [i, ca] of [...a].entries()) {
    row[0] = i + 1
    for (const [j, cb] of [...b].entries()) {
      const cost = ca === cb ? 0 : 1
      row[j + 1] = Math.min(row[j]! + 1, prev[j + 1]! + 1, prev[j]! + cost)
    }
    prev.splice(0, prev.length, ...row)
  }
  return prev[b.length] ?? 99
}

/**
 * Keys prjct does not recognise, each with a suggestion when one is close.
 *
 * Comment keys are tolerated: the file may be `.jsonc`, and a leading `//` or
 * `$` is a convention for annotations rather than a mistake.
 */
export function unknownConfigKeys(config: unknown): UnknownConfigKey[] {
  if (!config || typeof config !== 'object' || Array.isArray(config)) return []
  const known = new Set(KNOWN_CONFIG_KEYS)
  return Object.keys(config as Record<string, unknown>)
    .filter((key) => !known.has(key) && !key.startsWith('//') && !key.startsWith('$'))
    .map((key) => {
      const ranked = KNOWN_CONFIG_KEYS.map((candidate) => ({
        candidate,
        distance: editDistance(key.toLowerCase(), candidate.toLowerCase()),
      })).sort((a, b) => a.distance - b.distance)
      const best = ranked[0]
      // Only suggest a genuinely close key; a wrong guess is worse than none.
      return {
        key,
        didYouMean:
          best && best.distance <= Math.max(2, Math.ceil(key.length / 4)) ? best.candidate : null,
      }
    })
}

/** One actionable line per unknown key, or null when the config is clean. */
export function unknownConfigKeysMessage(config: unknown): string | null {
  const unknown = unknownConfigKeys(config)
  if (unknown.length === 0) return null
  const lines = unknown.map(({ key, didYouMean }) =>
    didYouMean
      ? `  \`${key}\` is ignored — did you mean \`${didYouMean}\`?`
      : `  \`${key}\` is ignored — not a prjct config key.`
  )
  return [
    `${unknown.length} unrecognised project setting${unknown.length === 1 ? '' : 's'}:`,
    ...lines,
    `Fix it in prjct's global project settings; the client locator is not configuration.`,
  ].join('\n')
}
