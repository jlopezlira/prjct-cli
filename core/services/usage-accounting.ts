export interface UsageObservation {
  work_cycle_id: string | null
  source: string | null
  model_id: string | null
  input_tokens: number
  output_tokens: number
  is_estimated: number
  measured_at: number
  description?: string | null
  observation_id?: string | null
  usage_kind?: 'total' | 'model' | 'context' | null
  runtime?: string | null
}

export function isContextUsage(row: UsageObservation): boolean {
  return (
    row.usage_kind === 'context' ||
    /^(hook-injection|cli-md|mcp-result)(:|$)/.test(row.source ?? '')
  )
}

const total = (r: UsageObservation): number => r.input_tokens + r.output_tokens
const family = (r: UsageObservation): string => r.source?.split(':')[0] ?? 'unknown'
const quality = (a: UsageObservation, b: UsageObservation): number =>
  a.is_estimated - b.is_estimated ||
  total(b) - total(a) ||
  b.measured_at - a.measured_at ||
  (a.source ?? '').localeCompare(b.source ?? '')

/** One nonoverlapping set shared by token, model, source and inference reports. */
export function canonicalUsage(rows: UsageObservation[]): {
  rows: UsageObservation[]
  context: UsageObservation[]
  ambiguousCycles: string[]
} {
  const context = rows.filter(isContextUsage)
  const groups = new Map<string, UsageObservation[]>()
  const ambiguous = new Set<string>()
  for (const original of rows.filter((r) => !isContextUsage(r))) {
    // Pre-migration writers already encoded provider/session identity in source.
    const session = /^([^:]+)-session:([^:]+):/.exec(original.source ?? '')
    const row =
      !original.observation_id && session
        ? { ...original, observation_id: `${session[1]}:${session[2]}` }
        : original
    const key = JSON.stringify([row.work_cycle_id, row.observation_id ?? null])
    const group = groups.get(key) ?? []
    group.push(row)
    groups.set(key, group)
  }
  const counted: UsageObservation[] = []
  for (const group of groups.values()) {
    // Writers use SET semantics. Also deduplicate imported repeated observations.
    const latest = new Map<string, UsageObservation>()
    for (const row of group) {
      const key = JSON.stringify([
        row.source,
        row.usage_kind ?? (row.model_id ? 'model' : 'total'),
        row.model_id,
      ])
      const previous = latest.get(key)
      if (
        !previous ||
        row.is_estimated < previous.is_estimated ||
        (row.is_estimated === previous.is_estimated && row.measured_at >= previous.measured_at)
      )
        latest.set(key, row)
    }
    const observations = [...latest.values()]
    const totals = observations
      .filter((r) => r.usage_kind === 'total' || (!r.usage_kind && !r.model_id))
      .sort(quality)
    const models = observations.filter(
      (r) => r.usage_kind === 'model' || (!r.usage_kind && Boolean(r.model_id))
    )
    const families = new Map<string, UsageObservation[]>()
    for (const row of models) {
      const set = families.get(family(row)) ?? []
      set.push(row)
      families.set(family(row), set)
    }
    const breakdowns = [...families.values()]
      .map((set) => {
        const byModel = new Map<string, UsageObservation>()
        for (const row of set.sort(quality))
          if (!byModel.has(row.model_id ?? 'unknown')) byModel.set(row.model_id ?? 'unknown', row)
        return [...byModel.values()]
      })
      .sort(
        (a, b) =>
          Math.max(...a.map((r) => r.is_estimated)) - Math.max(...b.map((r) => r.is_estimated)) ||
          b.reduce((n, r) => n + total(r), 0) - a.reduce((n, r) => n + total(r), 0)
      )
    const authoritative =
      totals[0]?.is_estimated && breakdowns[0]?.every((r) => !r.is_estimated)
        ? undefined
        : totals[0]
    const breakdown = authoritative
      ? (breakdowns.find((set) => family(set[0]!) === family(authoritative)) ?? [])
      : (breakdowns[0] ?? [])
    const cycle = group[0]?.work_cycle_id ?? 'unknown'
    if (!group[0]?.observation_id && (totals.length > 1 || families.size > 1)) ambiguous.add(cycle)
    if (!authoritative) {
      counted.push(...breakdown)
      continue
    }
    const input = breakdown.reduce((n, r) => n + r.input_tokens, 0)
    const output = breakdown.reduce((n, r) => n + r.output_tokens, 0)
    if (
      input > authoritative.input_tokens ||
      output > authoritative.output_tokens ||
      breakdown.some((r) => r.is_estimated > authoritative.is_estimated)
    ) {
      ambiguous.add(cycle)
      counted.push({ ...authoritative, model_id: null })
      continue
    }
    counted.push(...breakdown)
    if (input < authoritative.input_tokens || output < authoritative.output_tokens)
      counted.push({
        ...authoritative,
        model_id: null,
        input_tokens: authoritative.input_tokens - input,
        output_tokens: authoritative.output_tokens - output,
      })
  }
  // Explicit session data and ambiguous historical cycle totals may overlap.
  // Keep the greater coherent observation, never add both without provenance.
  const byCycle = new Map<string, UsageObservation[]>()
  for (const row of counted) {
    const key = row.work_cycle_id ?? 'unknown'
    const group = byCycle.get(key) ?? []
    group.push(row)
    byCycle.set(key, group)
  }
  const selected = [...byCycle.values()].flatMap((group) => {
    const identified = group.filter((r) => r.observation_id)
    const legacy = group.filter((r) => !r.observation_id)
    if (!identified.length || !legacy.length) return group
    ambiguous.add(group[0]?.work_cycle_id ?? 'unknown')
    const exactIdentified = identified.every((r) => !r.is_estimated)
    const exactLegacy = legacy.every((r) => !r.is_estimated)
    if (exactIdentified !== exactLegacy) return exactIdentified ? identified : legacy
    return identified.reduce((n, r) => n + total(r), 0) >= legacy.reduce((n, r) => n + total(r), 0)
      ? identified
      : legacy
  })
  return { rows: selected, context, ambiguousCycles: [...ambiguous] }
}
