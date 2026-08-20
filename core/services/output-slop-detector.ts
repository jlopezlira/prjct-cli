import { createHash } from 'node:crypto'
import { projectMemory } from '../memory/project-memory'
import type { TaskHarness } from '../schemas/state'
import { instructionFailureStorage } from '../storage/instruction-failure-storage'
import { textOf } from './hot-path-helpers'
import { type OutputProfile, outputProfileFor } from './private-skill-router'
import { buildTaskHarness } from './task-harness'
import type { TranscriptJsonlLine } from './transcript-jsonl'

type BoundedOutputProfile = Exclude<OutputProfile, 'expanded'>
export type OutputSlopReason =
  | 'broad-excess'
  | 'process-repetition'
  | 'duplicated-content'
  | 'structure-sprawl'

export interface OutputSlopSignal {
  profile: BoundedOutputProfile
  reason: OutputSlopReason
  fingerprint: string
  expectedBehavior: string
  observedBehavior: string
}

export interface OutputSlopContext {
  taskDescription?: string | null
  harness?: Pick<TaskHarness, 'level' | 'kind'> | null
}

interface TranscriptLine extends TranscriptJsonlLine {
  role?: string
  content?: unknown
  message?: { role?: string; content?: unknown }
}

const WIDE_WORD_LIMIT: Readonly<Record<BoundedOutputProfile, number>> = Object.freeze({
  compact: 600,
  standard: 1200,
})
const GLOBAL_DEVELOPER_PROFILE_ID = 'global-kb'

const PROCESS_MARKERS =
  /\b(?:i(?:'ll| will| am going to)|let me|next i(?:'ll| will)|now i(?:'ll| will)|checking|inspecting|investigating|running|voy a|ahora voy a|d[eé]jame|revisando|comprobando|ejecutando|investigando)\b/gi
const RESULT_MARKERS =
  /\b(?:result|outcome|found|root cause|fixed|implemented|completed|passed|failed|done|resultado|hallazgo|encontr[eé]|causa|corregid[oa]|implementad[oa]|completad[oa]|pas[oó]|fall[oó])\b/i

function latestExchange(lines: TranscriptJsonlLine[]): { prompt: string; response: string } | null {
  const state: {
    prompt: string
    latest: { prompt: string; response: string } | null
  } = { prompt: '', latest: null }
  for (const raw of lines as TranscriptLine[]) {
    const role = raw.role ?? raw.message?.role
    const content = textOf(raw.content ?? raw.message?.content)
    if (!content) continue
    if (role === 'user') {
      state.prompt = content
    } else if (role === 'assistant') {
      state.latest = { prompt: state.prompt, response: content }
    }
  }
  return state.latest
}

function wordCount(text: string): number {
  return text.match(/[\p{L}\p{N}]+/gu)?.length ?? 0
}

function countBucket(words: number): string {
  if (words < 900) return '600-899'
  if (words < 1200) return '900-1199'
  if (words < 1800) return '1200-1799'
  return '1800-plus'
}

function duplicateBucket(words: number): string {
  if (words < 80) return '40-79'
  if (words < 160) return '80-159'
  return '160-plus'
}

function fingerprintFor(
  profile: BoundedOutputProfile,
  reason: OutputSlopReason,
  bucket: string
): string {
  return createHash('sha256').update(`${profile}:${reason}:${bucket}`).digest('hex')
}

function normalizeRepeatedUnit(unit: string): string {
  return unit
    .replace(/^\s*(?:#{1,6}|[-*+] |\d+[.)] )\s*/, '')
    .replace(/[`*_~>[\]()]/g, ' ')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function normalizedRepeatedUnits(text: string): Array<{ key: string; words: number }> {
  const paragraphs = text
    .split(/\n\s*\n+/)
    .map(normalizeRepeatedUnit)
    .filter((unit) => wordCount(unit) >= 12)
    .map((unit) => ({ key: `paragraph:${unit}`, words: wordCount(unit) }))
  const sentences = text
    .split(/(?<=[.!?])\s+|\n+/)
    .map(normalizeRepeatedUnit)
    .filter((unit) => wordCount(unit) >= 12)
    .map((unit) => ({ key: `sentence:${unit}`, words: wordCount(unit) }))
  return [...paragraphs, ...sentences]
}

function repeatedWordCount(text: string): number {
  const seen = new Set<string>()
  const result = { repeated: 0 }
  for (const unit of normalizedRepeatedUnits(text)) {
    if (seen.has(unit.key)) result.repeated += unit.words
    else seen.add(unit.key)
  }
  return result.repeated
}

function nextActionFor(reason: OutputSlopReason): string {
  switch (reason) {
    case 'process-repetition':
      return 'Lead with the result and collapse progress into one verification summary.'
    case 'duplicated-content':
      return 'State each result once and remove repeated summaries or conclusions.'
    case 'structure-sprawl':
      return 'Keep only headings that carry a distinct decision or evidence set.'
    case 'broad-excess':
      return 'Answer at the smallest useful profile and lead with the outcome.'
  }
}

/**
 * Conservative, PII-free classification of the latest assistant response.
 * It never returns a signal for an explicit expanded request and never places
 * transcript text in the returned/persisted fields.
 */
export function analyzeOutputSlop(
  lines: TranscriptJsonlLine[],
  context: OutputSlopContext = {}
): OutputSlopSignal | null {
  const exchange = latestExchange(lines)
  if (!exchange) return null
  const profile = outputProfileFor({
    intent: [context.taskDescription, exchange.prompt].filter(Boolean).join('\n'),
    harness: context.harness ?? buildTaskHarness(exchange.prompt),
  })
  if (profile === 'expanded') return null

  const words = wordCount(exchange.response)
  if (words >= WIDE_WORD_LIMIT[profile]) {
    const bucket = countBucket(words)
    return {
      profile,
      reason: 'broad-excess',
      fingerprint: fingerprintFor(profile, 'broad-excess', bucket),
      expectedBehavior: `Keep ${profile} responses near their soft target unless completeness requires more.`,
      observedBehavior: `Assistant response exceeded the ${profile} profile by a wide margin (${bucket} word bucket).`,
    }
  }

  const processUpdates = exchange.response.match(PROCESS_MARKERS)?.length ?? 0
  if (processUpdates >= 8 || (processUpdates >= 5 && !RESULT_MARKERS.test(exchange.response))) {
    const bucket = processUpdates >= 8 ? '8-plus' : '5-7'
    return {
      profile,
      reason: 'process-repetition',
      fingerprint: fingerprintFor(profile, 'process-repetition', bucket),
      expectedBehavior:
        'Lead with the outcome and include only process detail that changes a decision or verifies the result.',
      observedBehavior:
        processUpdates >= 8
          ? `Assistant response contained excessive process narration (${bucket} update bucket).`
          : `Assistant response repeated process updates without a result marker (${bucket} update bucket).`,
    }
  }

  const repeatedWords = repeatedWordCount(exchange.response)
  if (repeatedWords >= 40) {
    const bucket = duplicateBucket(repeatedWords)
    return {
      profile,
      reason: 'duplicated-content',
      fingerprint: fingerprintFor(profile, 'duplicated-content', bucket),
      expectedBehavior:
        'State each result once, then add only distinct evidence or decision-relevant detail.',
      observedBehavior: `Assistant response repeated substantial content (${bucket} repeated-word bucket).`,
    }
  }

  const headings = exchange.response.match(/^\s{0,3}#{1,6}\s+\S/gm)?.length ?? 0
  const structureLimit = profile === 'compact' ? 6 : 12
  const structureFloor = profile === 'compact' ? 120 : 300
  if (headings >= structureLimit && words >= structureFloor) {
    const bucket =
      headings >= structureLimit * 2
        ? `${structureLimit * 2}-plus`
        : `${structureLimit}-${structureLimit * 2 - 1}`
    return {
      profile,
      reason: 'structure-sprawl',
      fingerprint: fingerprintFor(profile, 'structure-sprawl', bucket),
      expectedBehavior:
        'Use the smallest structure that makes the outcome, evidence, and decisions easy to scan.',
      observedBehavior: `Assistant response fragmented a ${profile} answer across many headings (${bucket} heading bucket).`,
    }
  }
  return null
}

export async function recordOutputSlop(
  projectPath: string,
  projectId: string,
  lines: TranscriptJsonlLine[],
  opts: {
    runtime: string
    model: string
    sessionId?: string | null
    taskId?: string | null
    taskDescription?: string | null
    harness?: Pick<TaskHarness, 'level' | 'kind'> | null
  }
): Promise<{ inserted: boolean; memoryRecorded: boolean; signal: OutputSlopSignal } | null> {
  const signal = analyzeOutputSlop(lines, {
    taskDescription: opts.taskDescription,
    harness: opts.harness,
  })
  if (!signal) return null
  const key = signal.fingerprint.slice(0, 16)
  const recorded = instructionFailureStorage.record(projectId, {
    source: 'output-slop-detector',
    runtime: opts.runtime,
    model: opts.model,
    sessionId: opts.sessionId ?? null,
    taskId: opts.taskId ?? null,
    category: 'output-slop',
    expectedBehavior: signal.expectedBehavior,
    observedBehavior: signal.observedBehavior,
    relatedRuleId: `output-slop:${key}`,
  })
  const existing = projectMemory.recall(projectId, {
    types: ['improvement-signal'],
    tags: { source: 'output-slop-detector', key },
    limit: 1,
    dedupeByKey: false,
  })
  const memoryRecorded = existing.length === 0
  const content = [
    '[output-slop] Adaptive output signal.',
    `Observed: ${signal.observedBehavior}`,
    `Expected: ${signal.expectedBehavior}`,
    `Next action: ${nextActionFor(signal.reason)}`,
  ].join('\n')
  if (memoryRecorded) {
    await projectMemory.remember(projectPath, {
      type: 'improvement-signal',
      content,
      tags: {
        source: 'output-slop-detector',
        category: 'output-slop',
        profile: signal.profile,
        reason: signal.reason,
        runtime: opts.runtime,
        model: opts.model,
        ...(opts.sessionId ? { session: opts.sessionId } : {}),
        key,
      },
      provenance: 'extracted',
      projectId,
    })
  }
  // Output discipline is a developer preference, not project knowledge.
  // The persisted content is deliberately coarse and PII-free, so the same
  // learned behavior can apply across projects without leaking source text.
  try {
    const globalExisting = projectMemory.recall(GLOBAL_DEVELOPER_PROFILE_ID, {
      types: ['improvement-signal'],
      tags: { source: 'output-slop-detector', key },
      limit: 1,
      dedupeByKey: false,
    })
    if (globalExisting.length === 0) {
      await projectMemory.remember(projectPath, {
        type: 'improvement-signal',
        content,
        tags: {
          source: 'output-slop-detector',
          category: 'output-slop',
          profile: signal.profile,
          reason: signal.reason,
          scope: 'global-developer-profile',
          key,
        },
        provenance: 'extracted',
        projectId: GLOBAL_DEVELOPER_PROFILE_ID,
      })
    }
  } catch {
    // Cross-project adaptation is best-effort; keep the project-local signal.
  }
  return { inserted: recorded.inserted, memoryRecorded, signal }
}
