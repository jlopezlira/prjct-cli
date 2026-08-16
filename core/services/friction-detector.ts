/**
 * Friction detector — scans the Claude Code session transcript at
 * Stop time for moments of user friction and persists them as
 * `improvement-signal` memory entries.
 *
 * Design principle (matches the verb-intent-map philosophy: the LLM
 * is the engine, not regex): we DO NOT pretend to infer deep intent
 * from regex. We convert a high-confidence pushback moment into a
 * conservative structured lesson: what happened, why it mattered,
 * the pattern/anti-pattern, and the next action. Raw transcript quotes
 * are used only transiently for classification/dedup and are NOT stored
 * in durable memory — context value is the reusable lesson, not the literal.
 *
 * Quality (brutal apply-loop vs prompt-only harnesses): when the user
 * names a concrete constraint ("run the tests first", "should be feat:"),
 * distill that into the Lesson/Next action so developer-profile and
 * SessionStart can *apply* it — not a generic "recalibrate" template.
 * Identical pushback seen again (dedup hit) promotes a standing
 * `feedback` preference so the rule survives as "said", not only "showed".
 *
 * What counts as friction (precision-over-recall):
 *   - User negation directly after an assistant tool-use:
 *     "no", "stop", "cancel", "wait" → strong signal
 *   - User correction phrasing: "should be X", "rather than", "instead"
 *   - Repeated requests for the same surface ("where", "how do I"
 *     appearing 3+ times in the session)
 *   - Explicit complaint markers: "doesn't work", "broken"
 *
 * Conservative cap: max 5 signals per session. Hashed dedup against
 * existing improvement-signal entries so re-running the hook never
 * doubles them.
 */

import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import { projectMemory } from '../memory/project-memory'
import { projectIdFromPath, textOf } from './hot-path-helpers'
import { parseTranscriptJsonl, type TranscriptJsonlLine } from './transcript-jsonl'

const SOURCE_TAG = 'friction-detector'
const PROMOTE_SOURCE = 'friction-promote'
const MAX_SIGNALS_PER_SESSION = 5
const MAX_EXCERPT_CHARS = 400
const MAX_CONSTRAINT_CHARS = 160

// Negation / correction markers (English). Matched against the START of a
// user turn (after the assistant just acted) to avoid false positives in
// ordinary discussion. Memory content is English-only (feedback contract).
const NEGATION_MARKERS = [
  /^\s*no[,.!\s]/i,
  /^\s*nope\b/i,
  /^\s*stop\b/i,
  /^\s*wait\b/i,
  /^\s*cancel\b/i,
]

const CORRECTION_MARKERS = [/\bshould be\b/i, /\brather than\b/i, /\binstead\b/i]

const COMPLAINT_MARKERS = [/\bdoesn'?t work\b/i, /\bbroken\b/i, /\bagain\b.*\bsame\b/i]

interface TranscriptLine {
  type?: string
  message?: { role?: string; content?: unknown }
  role?: string
  content?: unknown
}

interface FrictionSignal {
  excerpt: string
  category: 'negation' | 'correction' | 'complaint'
  /** Assistant turn (truncated) that immediately preceded the signal. */
  precedingAssistantPreview: string
}

export interface FrictionResult {
  signalsRecorded: number
  signalsSkipped: number
  failures: InstructionFailureCandidate[]
}

export interface InstructionFailureCandidate {
  category: string
  expectedBehavior: string
  observedBehavior: string
  relatedRuleId: string | null
}

/**
 * Public entry. Reads the transcript JSONL, extracts up to
 * MAX_SIGNALS_PER_SESSION friction signals, persists them via
 * projectMemory.remember with type `improvement-signal`. Idempotent
 * (hashed dedup against existing entries with the same source tag).
 */
export async function detectFriction(
  projectPath: string,
  transcriptPath: string,
  sessionId: string | null,
  opts: { preloadedLines?: TranscriptJsonlLine[]; runtime?: string; model?: string } = {}
): Promise<FrictionResult> {
  const lines: TranscriptLine[] | null = opts.preloadedLines
    ? (opts.preloadedLines as TranscriptLine[])
    : await fs
        .readFile(transcriptPath, 'utf-8')
        .then(parseJsonl)
        .catch(() => null)
  if (!lines) return { signalsRecorded: 0, signalsSkipped: 0, failures: [] }
  const signals = extractSignals(lines)
  if (signals.length === 0) {
    return { signalsRecorded: 0, signalsSkipped: 0, failures: [] }
  }
  const failures = signals.slice(0, MAX_SIGNALS_PER_SESSION).map((signal) => ({
    category: signal.category,
    expectedBehavior: 'Follow the user constraint without requiring correction.',
    observedBehavior: `The assistant response triggered user ${signal.category}.`,
    relatedRuleId: null,
  }))

  // Dedup against signals already in memory (hashing on excerpt).
  const existing = projectMemoryHashes(projectPath)
  const projectId = projectIdFromPath(projectPath) ?? undefined
  const counts = await signals
    .slice(0, MAX_SIGNALS_PER_SESSION)
    .reduce<Promise<Omit<FrictionResult, 'failures'>>>(
      async (pendingCounts, signal) => {
        const counts = await pendingCounts
        // `existing` holds the 12-char keys stored on prior signals (see
        // projectMemoryHashes), so the comparison unit MUST be the same 12-char
        // slice — comparing the full 64-char hash here silently never matched.
        const dedupKey = hashSignal(signal.excerpt).slice(0, 12)
        if (existing.has(dedupKey)) {
          await maybePromoteStandingPreference(projectPath, projectId, signal).catch(() => {})
          return { ...counts, signalsSkipped: counts.signalsSkipped + 1 }
        }
        try {
          await projectMemory.remember(projectPath, {
            type: 'improvement-signal',
            content: formatSignal(signal),
            tags: {
              source: SOURCE_TAG,
              category: signal.category,
              ...(opts.runtime ? { runtime: opts.runtime } : {}),
              ...(opts.model ? { model: opts.model } : {}),
              ...(sessionId ? { session: sessionId } : {}),
              key: dedupKey,
            },
            provenance: 'extracted',
            projectId,
          })
          existing.add(dedupKey)
          return { ...counts, signalsRecorded: counts.signalsRecorded + 1 }
        } catch {
          return { ...counts, signalsSkipped: counts.signalsSkipped + 1 }
        }
      },
      Promise.resolve({ signalsRecorded: 0, signalsSkipped: 0 })
    )
  return { ...counts, failures }
}

// Helpers — exported for tests via _internal.

function parseJsonl(raw: string): TranscriptLine[] {
  return parseTranscriptJsonl(raw) as TranscriptLine[]
}

/**
 * Walk the transcript turn-by-turn. A "friction signal" is a USER
 * turn whose first 200 chars match a marker, recorded with the
 * preceding ASSISTANT turn as context.
 */
function extractSignals(lines: TranscriptLine[]): FrictionSignal[] {
  const state: { signals: FrictionSignal[]; lastAssistantText: string } = {
    signals: [],
    lastAssistantText: '',
  }
  for (const line of lines) {
    const role = line.role ?? line.message?.role
    const content = textOf(line.content ?? line.message?.content)
    if (!content) continue
    if (role === 'assistant') {
      state.lastAssistantText = content
      continue
    }
    if (role !== 'user') continue
    const category = classify(content.slice(0, 300))
    if (!category) continue
    state.signals.push({
      excerpt: content.slice(0, MAX_EXCERPT_CHARS).trim(),
      category,
      precedingAssistantPreview: state.lastAssistantText.slice(0, MAX_EXCERPT_CHARS).trim(),
    })
  }
  return state.signals
}

function classify(text: string): FrictionSignal['category'] | null {
  // Complaints checked FIRST: multi-word complaint patterns are more
  // specific than a bare "no…" negation prefix and shouldn't be
  // miscategorised as pure rejection.
  if (COMPLAINT_MARKERS.some((re) => re.test(text))) return 'complaint'
  if (NEGATION_MARKERS.some((re) => re.test(text))) return 'negation'
  if (CORRECTION_MARKERS.some((re) => re.test(text))) return 'correction'
  return null
}

function formatSignal(signal: FrictionSignal): string {
  const template = lessonTemplate(signal.category)
  const specific = extractSpecificConstraint(signal.excerpt)
  const lesson = specific ? `Obey developer constraint: ${specific}` : template.lesson
  const nextAction = specific ? `Always: ${specific}` : template.nextAction
  const lines = [
    `[${signal.category}] Lesson: ${lesson}`,
    'What happened: The user pushed back after the assistant response.',
    `Why it mattered: ${template.why}`,
    `Pattern: ${template.pattern}`,
    `Anti-pattern: ${template.antiPattern}`,
    `Next action: ${nextAction}`,
  ]
  return lines.join('\n')
}

/**
 * Distill a reusable standing constraint from the user turn without storing
 * the raw quote. High precision: only patterns that name a concrete rule.
 * Returns null → fall back to category template (still better than silence).
 */
function extractSpecificConstraint(excerpt: string): string | null {
  const normalized = excerpt.replace(/\s+/g, ' ').trim()
  if (!normalized) return null

  // Drop leading rejection particles so the remainder is the rule.
  const t = normalized.replace(/^\s*(?:nope|no|stop|wait|cancel)[,.!\s:—-]*/i, '').trim()

  const shouldBe = t.match(/\bshould be\b\s+(.+?)$/i)
  if (shouldBe?.[1]) return cleanConstraint(`Prefer ${shouldBe[1]}`)

  const rather = t.match(/^(.+?)\s+rather than\s+(.+?)$/i)
  if (rather?.[1] && rather[2]) {
    return cleanConstraint(`Prefer ${rather[1].trim()} rather than ${rather[2].trim()}`)
  }

  const useInstead = t.match(
    /\b(?:use|prefer|do|run|ship|write|keep)\s+(.+?)\s+instead(?:\s+of\s+(.+))?$/i
  )
  if (useInstead?.[1]) {
    const of = useInstead[2] ? ` instead of ${useInstead[2].trim()}` : ' instead'
    return cleanConstraint(`Use ${useInstead[1].trim()}${of}`)
  }

  const insteadOf = t.match(/\binstead of\b\s+(.+?)$/i)
  if (insteadOf?.[1]) return cleanConstraint(`Avoid ${insteadOf[1].trim()}`)

  const never = t.match(/\b(?:don'?t|do not|never)\s+(.+?)$/i)
  if (never?.[1]) return cleanConstraint(`Never ${never[1].trim()}`)

  const always = t.match(/\balways\s+(.+?)$/i)
  if (always?.[1]) return cleanConstraint(`Always ${always[1].trim()}`)

  // Imperative remainder after stripping "no," — "run the tests first".
  if (
    t.length >= 12 &&
    t.length <= MAX_CONSTRAINT_CHARS &&
    /^(?:run|use|do|ship|write|keep|add|fix|remove|prefer|test|check|verify|read|ask|stop|start)\b/i.test(
      t
    )
  ) {
    const rule = t.charAt(0).toUpperCase() + t.slice(1)
    return cleanConstraint(rule.replace(/[.!?]+$/, ''))
  }

  return null
}

function cleanConstraint(raw: string): string | null {
  const r = raw
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[-*•]\s+/, '')
    .replace(/[.!?]+$/, '')
    .slice(0, MAX_CONSTRAINT_CHARS)
  if (r.length < 12) return null
  // Never persist residual raw negation lead-ins.
  if (/^(?:nope|no|stop|wait|cancel)\b/i.test(r)) return null
  return r
}

/**
 * Second identical pushback → standing `feedback` preference (apply-loop).
 * Deduped by key so re-runs never spam preferences.
 */
async function maybePromoteStandingPreference(
  projectPath: string,
  projectId: string | undefined,
  signal: FrictionSignal
): Promise<void> {
  if (!projectId) return
  const specific = extractSpecificConstraint(signal.excerpt)
  if (!specific) return
  const rule = `Always: ${specific}`
  const prefKey = `fp:${hashSignal(specific).slice(0, 12)}`
  try {
    const existing = projectMemory.recall(projectId, {
      types: ['feedback'],
      tags: { source: PROMOTE_SOURCE, key: prefKey },
      limit: 1,
      dedupeByKey: false,
    })
    if (existing.length > 0) return
    await projectMemory.remember(projectPath, {
      type: 'feedback',
      content: rule,
      tags: {
        source: PROMOTE_SOURCE,
        key: prefKey,
        category: signal.category,
        from: 'recurring-friction',
      },
      provenance: 'extracted',
      projectId,
    })
  } catch {
    // Best-effort: promotion must never fail Stop.
  }
}

function lessonTemplate(category: FrictionSignal['category']): {
  lesson: string
  why: string
  pattern: string
  antiPattern: string
  nextAction: string
} {
  if (category === 'complaint') {
    return {
      lesson:
        'Treat explicit failure complaints as evidence that the last result needs diagnosis, not repetition.',
      why: 'The user reported that the delivered behavior or command did not work.',
      pattern: 'User names a broken or non-working result after an assistant action.',
      antiPattern: 'Retrying the same path or moving on without isolating the failure.',
      nextAction:
        'Stop, inspect the failing output or assumption, and propose the smallest verifiable fix.',
    }
  }
  if (category === 'correction') {
    return {
      lesson: 'Update the working assumption when the user corrects the intended direction.',
      why: 'The assistant was using an assumption that did not match what the user wanted.',
      pattern: 'User redirects the implementation or workflow with a correction.',
      antiPattern: 'Continuing with the original plan after the user clarified a different target.',
      nextAction: 'Restate the corrected target as an actionable rule before continuing.',
    }
  }
  return {
    lesson: 'Recalibrate before continuing when the user rejects the assistant’s last step.',
    why: 'The assistant likely violated sequencing, scope, or approval expectations.',
    pattern: 'User immediately rejects an assistant action or proposed next step.',
    antiPattern:
      'Treating the rejected action as acceptable and continuing without changing course.',
    nextAction:
      'Pause, convert the pushback into a workflow constraint, and adjust the next tool use.',
  }
}

function hashSignal(excerpt: string): string {
  // Hash on the lowercased, whitespace-normalised excerpt so trivial
  // formatting differences don't double-count.
  const normalised = excerpt.toLowerCase().replace(/\s+/g, ' ').trim()
  return crypto.createHash('sha256').update(normalised).digest('hex')
}

function projectMemoryHashes(projectPath: string): Set<string> {
  // Read configManager-resolved projectId via the recall API. If we
  // can't get one, return an empty set (every signal is "new"); the
  // caller's MAX_SIGNALS_PER_SESSION cap prevents runaway noise.
  try {
    // We need projectId — recall accepts it directly. Caller should
    // have validated config exists before calling detectFriction; if
    // it didn't, recall throws and we fall through.
    const id = projectIdFromPath(projectPath)
    if (!id) return new Set()
    const entries = projectMemory.recall(id, {
      types: ['improvement-signal'],
      tags: { source: SOURCE_TAG },
      limit: 100,
      dedupeByKey: false,
    })
    const hashes = new Set<string>()
    for (const e of entries) {
      const key = e.tags.key
      if (key) hashes.add(key)
    }
    return hashes
  } catch {
    return new Set()
  }
}

export const _internal = {
  parseJsonl,
  extractSignals,
  classify,
  hashSignal,
  textOf,
  formatSignal,
  extractSpecificConstraint,
  MAX_SIGNALS_PER_SESSION,
  PROMOTE_SOURCE,
}
