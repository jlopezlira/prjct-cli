/**
 * Capture gate — Rho step at write time: only persist high-excess knowledge.
 *
 * Exact fingerprint dedup already lives in projectMemory.remember.
 * This gate adds *semantic* redundancy: if content is near-duplicate of the
 * reference model R, low-stakes types (inbox/context/idea/signals) are
 * rejected instead of diluting the vault.
 *
 * Auto-sources (pattern-detector, transcript-auto, skill-miss, friction)
 * are ALWAYS excess-gated even when typed as learning — they are not
 * human judgment, they are derived noise.
 *
 * High-stakes judgment WITHOUT auto source always passes when content is
 * not an exact hash dup.
 */

import type { MemoryType } from '../../memory/entries'
import { classifyCapturePrecision } from '../../memory/precision-classifier'
import { projectMemory } from '../../memory/project-memory'
import { isJunkCaptureContent } from '../capture-junk'
import { buildReferenceIndex, CAPTURE_MIN_EXCESS, excessAgainstIndex } from './excess'
import { isAutoSource } from './purge'
import { buildReferenceModel } from './reference-model'

/** Types that must never be blocked by semantic excess — unless auto-source. */
const ALWAYS_ACCEPT = new Set([
  'decision',
  'gotcha',
  'red-herring',
  'learning',
  'fact',
  'feedback',
  'pattern',
  'anti-pattern',
  'identity',
  'voice',
  'glossary',
  'framework',
  'spec',
  'shipped',
])

/** Stricter floor for auto-derived captures. */
const AUTO_SOURCE_MIN_EXCESS = 0.28

export interface CaptureGateResult {
  accept: boolean
  reason: string
  excess?: number
  nearestId?: string | null
}

/**
 * Gate a prospective capture against the current project model.
 * Pure read of SQLite via projectMemory; no writes.
 */
export function captureGate(
  projectId: string,
  type: MemoryType,
  content: string,
  tags?: Record<string, string>
): CaptureGateResult {
  const trimmed = content.trim()
  if (trimmed.length === 0) {
    return { accept: false, reason: 'empty content' }
  }

  // Universal junk refuse (all types): accidental GTD misroutes, tool dumps,
  // bare mem ids. High-stakes types still refuse garbage — a "decision" of
  // "todo_write" is never knowledge.
  const junk = isJunkCaptureContent(trimmed, type)
  if (junk.junk) {
    return { accept: false, reason: `junk capture: ${junk.reason}` }
  }

  // Precision classifier (pure, no I/O): empty specs, open-narration gotchas,
  // sub-substance inbox. Demote is not accept-as-typed — caller (remember)
  // rewrites type; gate rejects the original public type.
  const precision = classifyCapturePrecision(trimmed, type, {
    force: tags?.force === 'true' || tags?.['precision:force'] === 'true',
  })
  if (precision.action === 'refuse') {
    return { accept: false, reason: `precision: ${precision.reason}` }
  }
  if (precision.action === 'demote') {
    return {
      accept: false,
      reason: `precision demote→${precision.demoteTo ?? 'context'}: ${precision.reason}`,
    }
  }

  const auto = isAutoSource(tags?.source)
  // Human/agent judgment always accepted (exact-hash dedup upstream).
  // Auto-sourced "learning" still goes through excess — derived noise.
  if (ALWAYS_ACCEPT.has(type) && !auto) {
    return { accept: true, reason: 'judgment type — always accept novel content' }
  }

  const entries = (() => {
    try {
      return projectMemory.allEntriesForIndex(projectId)
    } catch {
      return null
    }
  })()
  if (!entries) return { accept: true, reason: 'gate skipped (read failure)' }

  if (entries.length === 0) {
    return { accept: true, reason: 'empty vault — seed accepted' }
  }

  const R = buildReferenceModel(entries)
  if (R.length === 0) {
    return { accept: true, reason: 'empty reference — accept' }
  }

  const index = buildReferenceIndex(R)
  const ex = excessAgainstIndex(trimmed, index)
  const floor = auto ? AUTO_SOURCE_MIN_EXCESS : CAPTURE_MIN_EXCESS

  if (ex.exactDup || ex.nearDup || ex.excess < floor) {
    return {
      accept: false,
      reason: ex.exactDup
        ? `redundant exact match of ${ex.nearestId}`
        : auto
          ? `auto-source low excess ${ex.excess.toFixed(2)} (floor ${floor}) vs R nearest ${ex.nearestId}`
          : `low excess ${ex.excess.toFixed(2)} vs reference (nearest ${ex.nearestId}, sim ${ex.maxSim.toFixed(2)})`,
      excess: ex.excess,
      nearestId: ex.nearestId,
    }
  }

  return {
    accept: true,
    reason: auto
      ? `auto-source excess ${ex.excess.toFixed(2)} above floor`
      : `excess ${ex.excess.toFixed(2)} above capture floor`,
    excess: ex.excess,
    nearestId: ex.nearestId,
  }
}
