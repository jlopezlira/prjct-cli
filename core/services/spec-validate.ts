/**
 * Spec structural validation (Phase 2) — hardens `prjct spec audit` by
 * checking the STORED structure before a reviewer dispatch is emitted.
 *
 * Also home of `parseScopePath` / `parseScopePaths`, the ONE shared helper
 * for peeling path-like prefixes out of `spec.scope` entries (entries are
 * typically "core/sync/sync-manager.ts — desc"). The peel regex used to be
 * duplicated — and subtly divergent — across spec-audit-dispatch.ts and
 * spec-inventory.ts; both now consume this module.
 *
 * Rule severities (judgment call, documented so the audit gate and the
 * `spec validate` subverb agree):
 *
 *   ERRORS (block the dispatch under --strict / SDD mode=strict; fail
 *   `spec validate`):
 *     - delta-model requirement (present in the folded delta_log) whose
 *       statement is not SHALL-style (no SHALL/MUST).
 *     - delta-model requirement with zero scenarios.
 *     - scenario missing GIVEN, WHEN, or THEN content.
 *     - delta_log REMOVED op targeting a slug no earlier (or same-entry)
 *       ADDED/MODIFIED ever introduced — a corrupted / hand-edited log.
 *
 *   WARNINGS (advisory everywhere; fail `spec validate --strict` only,
 *   mirroring the established `prjct guard --strict` convention):
 *     - legacy spec (empty delta_log) with free-text acceptance criteria —
 *       the structure predates the delta model; validation must not brick
 *       existing data.
 *     - any acceptance criterion that no delta statement accounts for and
 *       that is not SHALL-style.
 *     - scope entry whose path-like prefix does not resolve to a real
 *       file/dir in the project (specs legitimately reference files that
 *       do not exist yet — greenfield work — so this is never an error).
 */

import { existsSync } from 'node:fs'
import path from 'node:path'
import type { Spec, SpecContent } from '../types/spec'
import { allDeltaStatements, requirementStatements, sortDeltaLog } from './spec-delta'

/** Path with an extension: `core/auth/login.ts` (ext allows uppercase: `.TS`). */
const SCOPE_FILE_RE = /[a-zA-Z0-9_./-]+\.[a-zA-Z]+/
/** Directory path, with or without trailing slash: `core/auth/` / `core/auth`. */
const SCOPE_DIR_RE = /[a-zA-Z0-9_./-]+\/[a-zA-Z0-9_-]+\/?/
/** Single-segment dir with trailing slash: `core/`. */
const SCOPE_DIR_SLASH_RE = /[a-zA-Z0-9_./-]+\//

/** SHALL-style statement: an explicit SHALL or MUST anywhere in the text. */
const SHALL_RE = /\b(SHALL|MUST)\b/i

/** Reviewer-tool budget: never hand more than 12 peeled paths to a reviewer. */
const SCOPE_PATH_CAP = 12

/**
 * Peel the path-like prefix from ONE scope entry, or null when the entry is
 * plain prose. Precedence: file-with-extension, then a dir path (`a/b` or
 * `a/b/`), then a single-segment dir (`a/`). The multi-segment dir form is
 * tried before the single-segment one so `core/auth` peels whole instead of
 * collapsing to the `core/` prefix the old trailing-slash regex produced.
 */
export function parseScopePath(entry: string): string | null {
  const m =
    entry.match(SCOPE_FILE_RE) ?? entry.match(SCOPE_DIR_RE) ?? entry.match(SCOPE_DIR_SLASH_RE)
  return m ? m[0] : null
}

/**
 * Peel every scope entry, deduped, capped at 12 to stay within reviewer-tool
 * budgets. This is the exact behavior of the old `extractScopePaths` in
 * spec-audit-dispatch.ts, modulo the bare-dir form above.
 */
export function parseScopePaths(scope: string[]): string[] {
  const out: string[] = []
  for (const entry of scope) {
    const p = parseScopePath(entry)
    if (p && !out.includes(p)) out.push(p)
    if (out.length >= SCOPE_PATH_CAP) break
  }
  return out
}

export interface SpecValidation {
  errors: string[]
  warnings: string[]
}

export interface ValidateSpecOptions {
  /** Project root for scope-path existence checks; skipped when omitted. */
  projectPath?: string
}

/** Truncate a long AC for a one-line diagnostic. */
function brief(text: string): string {
  const oneLine = text.replace(/\s+/g, ' ').trim()
  return oneLine.length > 72 ? `${oneLine.slice(0, 72)}…` : oneLine
}

/** Delta-model rules: every folded requirement needs SHALL + full scenarios. */
function validateRequirements(content: SpecContent, errors: string[]): void {
  const statements = requirementStatements(content.delta_log)
  for (const [slug, statement] of statements) {
    if (!SHALL_RE.test(statement)) {
      errors.push(`requirement "${slug}" has no SHALL-style statement`)
    }
    const scenarios = content.scenarios[slug] ?? []
    if (scenarios.length === 0) {
      errors.push(`requirement "${slug}" has no scenarios`)
    }
    for (const sc of scenarios) {
      const missing: string[] = []
      if (sc.given.length === 0) missing.push('GIVEN')
      if (sc.when.length === 0) missing.push('WHEN')
      if (sc.then.length === 0) missing.push('THEN')
      if (missing.length > 0) {
        errors.push(`scenario "${sc.name}" (requirement "${slug}") is missing ${missing.join('/')}`)
      }
    }
  }
}

/** Delta-log integrity: REMOVED must target a slug the log ever introduced. */
function validateDeltaLog(content: SpecContent, errors: string[]): void {
  const known = new Set<string>()
  for (const entry of sortDeltaLog(content.delta_log)) {
    const introducedHere = new Set([...entry.ops.added, ...entry.ops.modified].map((r) => r.slug))
    for (const slug of entry.ops.removed) {
      if (!known.has(slug) && !introducedHere.has(slug)) {
        errors.push(
          `delta_log entry "${entry.id}" REMOVES requirement "${slug}" that never existed`
        )
      }
    }
    for (const slug of introducedHere) known.add(slug)
    for (const slug of entry.ops.removed) known.delete(slug)
  }
}

/** Legacy rules: free-text ACs predating the delta model are warnings only. */
function validateLegacy(content: SpecContent, warnings: string[]): void {
  const deltaStatements = allDeltaStatements(content.delta_log)
  const freeTextAcs = content.acceptance_criteria.filter((ac) => !deltaStatements.has(ac))
  if (content.delta_log.length === 0 && freeTextAcs.length > 0) {
    warnings.push(
      'legacy spec: free-text acceptance criteria with no delta_log/scenarios — re-derive via `prjct spec apply-delta` to harden'
    )
  }
  for (const ac of freeTextAcs) {
    if (!SHALL_RE.test(ac)) {
      warnings.push(`acceptance criterion is not SHALL-style: "${brief(ac)}"`)
    }
  }
}

/** Scope paths should resolve against the project tree (advisory). */
function validateScopePaths(content: SpecContent, projectPath: string, warnings: string[]): void {
  const seen = new Set<string>()
  for (const entry of content.scope) {
    const peeled = parseScopePath(entry)
    if (!peeled || seen.has(peeled)) continue
    seen.add(peeled)
    if (!existsSync(path.resolve(projectPath, peeled))) {
      warnings.push(`scope path does not resolve in the project: ${peeled}`)
    }
  }
}

/**
 * Validate the stored structure of a spec. Pure read — never mutates, never
 * throws on legacy shapes. See the module header for rule severities.
 */
export function validateSpec(spec: Spec, opts: ValidateSpecOptions = {}): SpecValidation {
  const errors: string[] = []
  const warnings: string[] = []
  validateRequirements(spec.content, errors)
  validateDeltaLog(spec.content, errors)
  validateLegacy(spec.content, warnings)
  if (opts.projectPath) validateScopePaths(spec.content, opts.projectPath, warnings)
  return { errors, warnings }
}

/** One line per finding, ERROR-first — shared by the CLI subverb and audit(). */
export function formatValidationLines(v: SpecValidation): string[] {
  return [...v.errors.map((e) => `- ERROR: ${e}`), ...v.warnings.map((w) => `- warning: ${w}`)]
}
