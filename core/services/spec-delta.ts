/**
 * Spec deltas — parser + applier for a strict subset of the OpenSpec delta
 * format (know-how reimplemented, no openspec dependency). This is the
 * CANONICAL update path for requirement-level changes:
 *
 *   ## ADDED Requirements
 *   ### Requirement: User Auth
 *   The system SHALL authenticate requests via bearer tokens.
 *
 *   #### Scenario: valid token
 *   - **GIVEN** a valid token
 *   - **WHEN** the request arrives
 *   - **THEN** access is granted
 *
 *   ## MODIFIED Requirements   (same body shape; targets an existing slug)
 *   ## REMOVED Requirements    (### Requirement: <name> only)
 *
 * Mapping onto SpecContent: the requirement statement IS the acceptance
 * criterion string; the requirement name becomes a stable slug; scenarios
 * land in `content.scenarios` keyed by that slug. Every applied delta is
 * recorded in `content.delta_log` with its full structured ops, which makes
 * the log the source of truth for re-materialization (sync merge) and gives
 * idempotency by delta id (default id = content hash of the markdown, so the
 * same delta text has the same id on every machine).
 *
 * Convergence rule: `acceptance_criteria` / `scenarios` are DERIVED from the
 * sorted delta log (sorted by `(ts, id)`) plus any hand-written ACs the log
 * never touched. Applying the same delta set in any order therefore yields
 * deep-equal content — the property the sync delta-union merge relies on.
 */

import { createHash } from 'node:crypto'
import {
  type DeltaEntry,
  type DeltaOps,
  type DeltaRequirement,
  type SpecContent,
  SpecContentSchema,
  type SpecScenario,
} from '../types/spec'
import { getTimestamp } from '../utils/date-helper'

/** Stable identity for a requirement: lowercase, non-alphanumeric runs → `-`. */
export function slugifyRequirement(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/**
 * Default delta id: content hash of the markdown. Deterministic across
 * machines (same text ⇒ same id), which is what makes the sync delta-union
 * dedupe and the idempotent re-apply work without coordination.
 */
export function deltaIdFor(deltaMarkdown: string): string {
  return `delta-${createHash('sha256').update(deltaMarkdown.trim()).digest('hex').slice(0, 12)}`
}

/** Canonical order for a delta log: `(ts, id)`. Same set ⇒ same sequence. */
export function sortDeltaLog(entries: DeltaEntry[]): DeltaEntry[] {
  return [...entries].sort((a, b) =>
    a.ts === b.ts ? (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) : a.ts < b.ts ? -1 : 1
  )
}

/** Union of two delta logs by entry id (first writer wins on id collision), sorted. */
export function mergeDeltaLogs(a: DeltaEntry[], b: DeltaEntry[]): DeltaEntry[] {
  const byId = new Map<string, DeltaEntry>()
  for (const entry of [...a, ...b]) {
    if (!byId.has(entry.id)) byId.set(entry.id, entry)
  }
  return sortDeltaLog([...byId.values()])
}

/** Every statement any delta ever wrote (added + modified, historical included). */
export function allDeltaStatements(entries: DeltaEntry[]): Set<string> {
  const out = new Set<string>()
  for (const entry of entries) {
    for (const req of [...entry.ops.added, ...entry.ops.modified]) out.add(req.statement)
  }
  return out
}

interface RequirementState {
  order: string[]
  statements: Map<string, string>
  scenarios: Map<string, SpecScenario[]>
}

/**
 * Fold a delta log into requirement state. Lenient by design (used by the
 * sync materializer, which must be total): MODIFIED of an absent slug acts
 * as ADDED, REMOVED of an absent slug is a no-op, ADDED of a present slug
 * updates in place (position preserved).
 */
function foldEntries(entries: DeltaEntry[]): RequirementState {
  const state: RequirementState = { order: [], statements: new Map(), scenarios: new Map() }
  const upsert = (req: DeltaRequirement) => {
    if (!state.statements.has(req.slug)) state.order.push(req.slug)
    state.statements.set(req.slug, req.statement)
    if (req.scenarios.length > 0) state.scenarios.set(req.slug, req.scenarios)
    else state.scenarios.delete(req.slug)
  }
  for (const entry of sortDeltaLog(entries)) {
    for (const req of entry.ops.added) upsert(req)
    for (const req of entry.ops.modified) upsert(req)
    for (const slug of entry.ops.removed) {
      state.statements.delete(slug)
      state.scenarios.delete(slug)
      const idx = state.order.indexOf(slug)
      if (idx >= 0) state.order.splice(idx, 1)
    }
  }
  return state
}

/** slug → current statement, from a delta log. Used by the markdown renderer. */
export function requirementStatements(entries: DeltaEntry[]): Map<string, string> {
  return foldEntries(entries).statements
}

/**
 * Deterministically re-materialize `acceptance_criteria` + `scenarios` from
 * a delta log. Same input set (in any order) ⇒ identical output.
 */
export function materializeDeltas(entries: DeltaEntry[]): {
  acceptance_criteria: string[]
  scenarios: Record<string, SpecScenario[]>
} {
  const state = foldEntries(entries)
  const scenarios: Record<string, SpecScenario[]> = {}
  for (const slug of state.order) {
    const sc = state.scenarios.get(slug)
    if (sc) scenarios[slug] = sc
  }
  return {
    acceptance_criteria: state.order.map((slug) => state.statements.get(slug) ?? ''),
    scenarios,
  }
}

/**
 * Parse delta markdown into structured ops. Strict subset of the OpenSpec
 * delta format: only the three `## … Requirements` sections; scenario
 * bullets accept GIVEN/WHEN/THEN with or without `**` bold markers, and
 * `AND` bullets continue the previous clause.
 */
export function parseDelta(deltaMarkdown: string): DeltaOps {
  const added: DeltaRequirement[] = []
  const modified: DeltaRequirement[] = []
  const removed: string[] = []

  type Section = 'added' | 'modified' | 'removed' | null
  type Clause = 'given' | 'when' | 'then'
  const state: {
    section: Section
    req: { name: string; statementLines: string[]; scenarios: SpecScenario[] } | null
    scenario: {
      name: string
      given: string[]
      when: string[]
      then: string[]
      last: Clause | null
    } | null
  } = { section: null, req: null, scenario: null }

  const flushScenario = () => {
    if (state.scenario && state.req) {
      state.req.scenarios.push({
        name: state.scenario.name,
        given: state.scenario.given,
        when: state.scenario.when,
        // biome-ignore lint/suspicious/noThenProperty: GIVEN/WHEN/THEN domain language; never awaited
        then: state.scenario.then,
      })
    }
    state.scenario = null
  }
  const flushReq = () => {
    flushScenario()
    const req = state.req
    state.req = null
    if (!req) return
    const slug = slugifyRequirement(req.name)
    if (!slug) {
      throw new Error(`DELTA_PARSE: requirement name yields an empty slug: "${req.name}"`)
    }
    if (state.section === 'removed') {
      removed.push(slug)
      return
    }
    const statement = req.statementLines.join('\n').trim()
    if (!statement) {
      throw new Error(`DELTA_PARSE: requirement "${req.name}" has no SHALL statement`)
    }
    const target = state.section === 'modified' ? modified : added
    target.push({ slug, name: req.name, statement, scenarios: req.scenarios })
  }

  for (const rawLine of deltaMarkdown.split('\n')) {
    const line = rawLine.trim()
    const sectionMatch = line.match(/^##\s+(ADDED|MODIFIED|REMOVED)\s+Requirements\s*$/i)
    if (sectionMatch) {
      flushReq()
      state.section = sectionMatch[1].toLowerCase() as Exclude<Section, null>
      continue
    }
    // Any other level-1/2 heading ends the current delta section.
    if (/^#{1,2}\s/.test(line)) {
      flushReq()
      state.section = null
      continue
    }
    const reqMatch = line.match(/^###\s+Requirement:\s*(.+)$/i)
    if (reqMatch) {
      flushReq()
      if (!state.section) {
        throw new Error(
          'DELTA_PARSE: "### Requirement:" outside an ADDED/MODIFIED/REMOVED Requirements section'
        )
      }
      state.req = { name: reqMatch[1].trim(), statementLines: [], scenarios: [] }
      continue
    }
    const scenMatch = line.match(/^####\s+Scenario:\s*(.+)$/i)
    if (scenMatch) {
      flushScenario()
      if (!state.req) {
        throw new Error('DELTA_PARSE: "#### Scenario:" outside a "### Requirement:" block')
      }
      state.scenario = {
        name: scenMatch[1].trim(),
        given: [],
        when: [],
        // biome-ignore lint/suspicious/noThenProperty: GIVEN/WHEN/THEN domain language; never awaited
        then: [],
        last: null,
      }
      continue
    }
    if (state.scenario && line.startsWith('-')) {
      const clause = line
        .replace(/^-\s+/, '')
        .match(/^(?:\*\*)?(GIVEN|WHEN|THEN|AND)\b\s*:?\s*(?:\*\*)?\s*(.*)$/i)
      if (clause) {
        const kind = clause[1].toUpperCase()
        const target: Clause =
          kind === 'AND' ? (state.scenario.last ?? 'when') : (kind.toLowerCase() as Clause)
        state.scenario[target].push(clause[2].trim())
        state.scenario.last = target
      }
      continue
    }
    if (state.req && !state.scenario && line !== '') state.req.statementLines.push(line)
  }
  flushReq()

  if (added.length + modified.length + removed.length === 0) {
    throw new Error('DELTA_EMPTY: no ADDED/MODIFIED/REMOVED Requirements sections found')
  }
  return { added, modified, removed }
}

export interface ApplyDeltaOptions {
  /** Override the delta id (default: content hash of the markdown). */
  id?: string
  /** Override the timestamp (default: now). Mainly for deterministic tests. */
  ts?: string
}

/**
 * Apply a delta to spec content, returning new content. Pure.
 *
 * Idempotent by delta id: re-applying an already-logged delta returns the
 * input unchanged. Strict on targets: MODIFIED/REMOVED of a slug neither in
 * the current log nor added by this same delta throws (typo safety). The
 * requirement body is re-derived from the sorted log, so application order
 * across deltas does not affect the result.
 */
export function applyDelta(
  content: SpecContent,
  deltaMarkdown: string,
  opts: ApplyDeltaOptions = {}
): SpecContent {
  const ops = parseDelta(deltaMarkdown)
  const id = opts.id ?? deltaIdFor(deltaMarkdown)
  if (content.delta_log.some((e) => e.id === id)) return content

  const known = foldEntries(content.delta_log).statements
  const freshSlugs = new Set(ops.added.map((r) => r.slug))
  for (const req of ops.modified) {
    if (!known.has(req.slug) && !freshSlugs.has(req.slug)) {
      throw new Error(
        `DELTA_UNKNOWN_REQUIREMENT: MODIFIED target "${req.name}" (slug: ${req.slug}) does not exist`
      )
    }
  }
  for (const slug of ops.removed) {
    if (!known.has(slug) && !freshSlugs.has(slug)) {
      throw new Error(`DELTA_UNKNOWN_REQUIREMENT: REMOVED target slug "${slug}" does not exist`)
    }
  }

  const entry: DeltaEntry = { id, ts: opts.ts ?? getTimestamp(), ops }
  const log = sortDeltaLog([...content.delta_log, entry])
  // Hand-written ACs (never touched by any delta statement, current or
  // superseded) survive untouched, ahead of the delta-managed block.
  const historical = allDeltaStatements(log)
  const preserved = content.acceptance_criteria.filter((ac) => !historical.has(ac))
  const materialized = materializeDeltas(log)
  return SpecContentSchema.parse({
    ...content,
    acceptance_criteria: [...preserved, ...materialized.acceptance_criteria],
    scenarios: materialized.scenarios,
    delta_log: log,
  })
}
