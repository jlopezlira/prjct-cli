/**
 * Skill-miss detector — at Stop time, finds captured project knowledge
 * (decision / gotcha / anti-pattern) that was RELEVANT to the work this
 * session did but was never REFERENCED in the transcript. Persists each
 * as an `improvement-signal` memory entry tagged `source:skill-miss-detector`.
 *
 * This is harness #16 (Skill Resolution Feedback) in prjct's anti-harness
 * idiom: it is a STATE SIGNAL surfaced at the next session start (under the
 * existing improvement-signals block), never a gate. The next session's
 * Claude reads it and decides whether the knowledge should have been
 * applied — we never block or enforce.
 *
 * Sibling of `friction-detector.ts`: same Stop-hook rail, same hashed
 * dedup + (type,key) latest-winner mechanism, same conservative cap, same
 * silent best-effort contract. Differs only in WHAT it detects.
 *
 * Precision over recall (matches friction-detector's stated philosophy):
 *   - relevance requires path-overlap with a changed file OR >=2 shared
 *     distinctive tokens — a single coincidental token is not enough.
 *   - the candidate is excluded if it was captured THIS session
 *     (recency containment) or has `inferred` provenance (low-confidence).
 *   - "referenced" = a distinctive token of the memory appears in the
 *     transcript; if so, the knowledge was applied — no signal.
 *
 * Transcript-primary: the Stop hook input is only {transcript_path,
 * session_id} — there is no diff. Changed-file overlap is a best-effort
 * BOOSTER fetched via getModifiedFiles() (uncommitted-only at Stop, may
 * be empty on a clean tree); its absence never errors and never blocks
 * token-based detection.
 */

import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import { projectMemory } from '../memory/project-memory'
import { getModifiedFiles } from '../session/git-helpers'
import { crewRunStorage } from '../storage/crew-run-storage'
import { projectIdFromPath, textOf } from './hot-path-helpers'
import { parseTranscriptJsonl, type TranscriptJsonlLine } from './transcript-jsonl'
import { usefulnessService } from './usefulness'

const SOURCE_TAG = 'skill-miss-detector'
const MAX_SKILL_MISSES_PER_SESSION = 3
const MAX_EXCERPT_CHARS = 280
/** Candidate memory types — captured project knowledge worth applying. */
const CANDIDATE_TYPES = ['decision', 'gotcha', 'anti-pattern'] as const
/**
 * Recency containment: a memory captured within this window of "now" is
 * treated as captured-this-session and never flagged (you cannot have
 * "missed" knowledge you just wrote). Coarse but robust — Stop fires
 * minutes after the work, and `prjct remember` rarely carries a session
 * tag we could match precisely.
 */
const CAPTURED_THIS_SESSION_MS = 90 * 60 * 1000
/**
 * Crew-isolation guard. Crew implementer/reviewer run as isolated
 * subagents in the SHARED working tree, so at the leader's Stop hook
 * `getModifiedFiles()` sees their edits — but the leader transcript
 * never carries the memory references the subagent made in its own
 * isolated transcript. A crew run whose `ended_at` is within this
 * window of "now" is plausibly the source of the current uncommitted
 * changes (older runs are normally committed), so its `files_touched`
 * are excluded from path-overlap relevance — token-overlap detection
 * stays active for non-crew work in the same session.
 */
const CREW_RUN_RECENCY_MS = 6 * 60 * 60 * 1000
/** Minimum distinctive-token overlap to call a memory "relevant" sans path hit. */
const MIN_TOKEN_OVERLAP = 2
/** Tokens shorter than this are too generic to be evidence of relevance. */
const MIN_TOKEN_LEN = 5
/**
 * A token this long is specific enough that its presence in the
 * transcript is evidence the agent actually engaged the memory (its
 * "signature"). Signature tokens establish APPLIED; the remaining
 * shorter "topic" tokens establish RELEVANCE. The two sets are kept
 * DISJOINT on purpose — otherwise the same token would prove a memory
 * both relevant and applied, and nothing could ever be a miss.
 */
const SIGNATURE_TOKEN_LEN = 8

// Generic words that overlap between almost any code memory and any
// coding session — excluded so they can't manufacture false relevance.
const STOPWORDS = new Set([
  'should',
  'because',
  'project',
  'prjct',
  'instead',
  'always',
  'never',
  'using',
  'value',
  'state',
  'change',
  'changes',
  'update',
  'updated',
  'function',
  'return',
  'returns',
  'error',
  'errors',
  'tests',
  'testing',
  'config',
  'default',
  'import',
  'export',
  'before',
  'after',
  'without',
])

interface TranscriptLine {
  message?: { role?: string; content?: unknown }
  role?: string
  content?: unknown
}

interface CandidateMemory {
  id: string
  type: string
  content: string
  fileTag: string
  rememberedAt: string
  provenance: string
  session: string
}

export interface SkillMiss {
  memId: string
  memType: string
  excerpt: string
  /** Changed file that made this relevant, or '' when relevance was token-only. */
  evidenceFile: string
  reason: 'path-overlap-unused' | 'topic-overlap-unused'
}

export interface SkillMissResult {
  signalsRecorded: number
  signalsSkipped: number
  failures: Array<{
    category: 'skill-miss'
    expectedBehavior: string
    observedBehavior: string
    relatedRuleId: string
  }>
}

/**
 * Public entry. Reads the transcript, recalls captured project knowledge,
 * flags relevant-but-unreferenced entries, persists up to
 * MAX_SKILL_MISSES_PER_SESSION as `improvement-signal` memory. Idempotent
 * (hashed dedup against existing skill-miss entries). Best-effort: any
 * failure (no transcript, no project, git error) returns a zero result.
 */
export async function detectSkillMisses(
  projectPath: string,
  transcriptPath: string,
  sessionId: string | null,
  opts: { preloadedLines?: TranscriptJsonlLine[]; runtime?: string; model?: string } = {}
): Promise<SkillMissResult> {
  const lines = opts.preloadedLines
    ? (opts.preloadedLines as TranscriptLine[])
    : await fs
        .readFile(transcriptPath, 'utf-8')
        .then(parseJsonl)
        .catch(() => null)
  if (!lines) return { signalsRecorded: 0, signalsSkipped: 0, failures: [] }

  const projectId = projectIdFromPath(projectPath)
  if (!projectId) return { signalsRecorded: 0, signalsSkipped: 0, failures: [] }

  const transcriptText = transcriptTextOf(lines)
  if (!transcriptText) return { signalsRecorded: 0, signalsSkipped: 0, failures: [] }

  const candidates = (() => {
    try {
      return recallCandidates(projectId, sessionId)
    } catch {
      return null
    }
  })()
  if (!candidates) return { signalsRecorded: 0, signalsSkipped: 0, failures: [] }
  if (candidates.length === 0) return { signalsRecorded: 0, signalsSkipped: 0, failures: [] }

  // Best-effort booster — absence never blocks token-based detection.
  const changedFiles = await getModifiedFiles(projectPath).catch(() => [])

  // Files a recent crew run touched: their edits are in the shared tree
  // but the references happened in the subagent's isolated transcript,
  // invisible here. Exclude them from path-overlap relevance so crew
  // runs don't generate false nags. Best-effort — never blocks.
  const crewFiles = (() => {
    try {
      const cutoff = Date.now() - CREW_RUN_RECENCY_MS
      return new Set(
        crewRunStorage
          .list(projectId)
          .filter((run) => Date.parse(run.ended_at) > cutoff)
          .flatMap((run) => run.files_touched)
      )
    } catch {
      return new Set<string>()
    }
  })()

  const misses = analyze(transcriptText, changedFiles, candidates, crewFiles)
  if (misses.length === 0) return { signalsRecorded: 0, signalsSkipped: 0, failures: [] }

  const existing = existingSkillMissKeys(projectId)
  const outcomes: Array<'recorded' | 'skipped'> = []
  for (const miss of misses.slice(0, MAX_SKILL_MISSES_PER_SESSION)) {
    const key = hashKey(miss.memId, miss.excerpt).slice(0, 12)
    if (existing.has(key)) {
      outcomes.push('skipped')
      continue
    }
    try {
      await projectMemory.remember(projectPath, {
        type: 'improvement-signal',
        content: formatSkillMiss(miss),
        tags: {
          source: SOURCE_TAG,
          kind: 'skill-miss',
          category: 'skill-miss',
          ...(opts.runtime ? { runtime: opts.runtime } : {}),
          ...(opts.model ? { model: opts.model } : {}),
          relates: miss.memId,
          file: miss.evidenceFile,
          key,
          ...(sessionId ? { session: sessionId } : {}),
        },
        provenance: 'extracted',
        projectId,
      })
      // The remember() above auto-credited the missed entry via its
      // `relates:` tag — but a miss is not usage. Cancel it + nudge down.
      usefulnessService.penalizeSkillMiss(projectId, miss.memId)
      outcomes.push('recorded')
    } catch {
      outcomes.push('skipped')
    }
  }
  const recorded = outcomes.filter((outcome) => outcome === 'recorded').length
  const skipped = outcomes.filter((outcome) => outcome === 'skipped').length
  return {
    signalsRecorded: recorded,
    signalsSkipped: skipped,
    failures: misses.slice(0, MAX_SKILL_MISSES_PER_SESSION).map((miss) => ({
      category: 'skill-miss',
      expectedBehavior: `Apply relevant project rule ${miss.memId}.`,
      observedBehavior: 'Relevant project knowledge was not referenced in the session.',
      relatedRuleId: miss.memId,
    })),
  }
}

// Pure core — exported via _internal for unit tests (no DB / no fs).

/**
 * Given the session transcript text, the changed-file list, and candidate
 * memories, return the skill-misses ordered strongest-first (path-overlap
 * beats token-only). Pure + deterministic — the unit-test seam.
 */
function analyze(
  transcriptText: string,
  changedFiles: string[],
  candidates: CandidateMemory[],
  crewFiles: Set<string> = new Set()
): SkillMiss[] {
  const sessionTokens = tokenize(transcriptText)
  if (sessionTokens.size === 0) return []
  // Crew-isolation guard: a file edited by a recent crew subagent must
  // not, by itself, make a memory "relevant" — the leader transcript is
  // blind to whether the subagent referenced it. Token-overlap on the
  // leader transcript still applies, so non-crew work stays covered.
  const effectiveChanged = changedFiles.filter((f) => !crewFiles.has(f))
  const changedStems = fileStems(effectiveChanged)

  const scored: Array<{ miss: SkillMiss; rank: number; overlap: number }> = []
  for (const mem of candidates) {
    const memTokens = tokenize(`${mem.content} ${mem.fileTag}`)
    if (memTokens.size === 0) continue

    // Relevance signal A — a non-crew changed file this memory is about.
    const pathHit =
      (mem.fileTag !== '' && effectiveChanged.some((f) => sharesStem(f, mem.fileTag))) ||
      [...changedStems].some((stem) => memTokens.has(stem))

    // Split the memory's vocabulary into a SIGNATURE (specific/long
    // tokens — their presence proves the agent engaged this memory) and
    // TOPIC tokens (the broader area). The sets are disjoint so the
    // token that makes a memory relevant can never also mark it applied.
    const signature = signatureOf(memTokens)
    const overlap = [...memTokens].filter(
      (token) => !signature.has(token) && sessionTokens.has(token)
    ).length

    // Relevance signal B — shared topic vocabulary (signature excluded).
    const relevant = pathHit || overlap >= MIN_TOKEN_OVERLAP
    if (!relevant) continue

    // Applied? A signature token of the memory appears in the transcript
    // → the agent engaged its specific content. Touching the file alone
    // is NOT enough (pathHit does not imply applied).
    const referenced = [...signature].some((t) => sessionTokens.has(t))
    if (referenced) continue

    const evidenceFile =
      mem.fileTag !== '' && effectiveChanged.some((f) => sharesStem(f, mem.fileTag))
        ? mem.fileTag
        : (effectiveChanged.find((f) => [...fileStems([f])].some((s) => memTokens.has(s))) ?? '')

    scored.push({
      miss: {
        memId: mem.id,
        memType: mem.type,
        excerpt: mem.content.replace(/\s+/g, ' ').trim().slice(0, MAX_EXCERPT_CHARS),
        evidenceFile,
        reason: pathHit ? 'path-overlap-unused' : 'topic-overlap-unused',
      },
      // path-overlap is the stronger signal — surface it first.
      rank: pathHit ? 2 : 1,
      overlap,
    })
  }

  scored.sort((a, b) => b.rank - a.rank || b.overlap - a.overlap)
  return scored.map((s) => s.miss)
}

function parseJsonl(raw: string): TranscriptLine[] {
  return parseTranscriptJsonl(raw) as TranscriptLine[]
}

/** Flatten all user + assistant turn text into one lowercased blob. */
function transcriptTextOf(lines: TranscriptLine[]): string {
  const parts: string[] = []
  for (const line of lines) {
    const role = line.role ?? line.message?.role
    if (role !== 'user' && role !== 'assistant') continue
    const text = textOf(line.content ?? line.message?.content)
    if (text) parts.push(text)
  }
  return parts.join('\n').toLowerCase()
}

function tokenize(text: string): Set<string> {
  const out = new Set<string>()
  for (const rawTok of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (rawTok.length < MIN_TOKEN_LEN) continue
    if (STOPWORDS.has(rawTok)) continue
    out.add(rawTok)
  }
  return out
}

/**
 * The memory's "signature" — tokens specific enough that seeing one in
 * the transcript proves the agent engaged this memory. Long tokens
 * (≥ SIGNATURE_TOKEN_LEN) qualify; if a memory has none, fall back to
 * its single longest token (deterministic: length desc, then
 * lexicographic) so there is always an APPLIED anchor disjoint from
 * the topic tokens.
 */
function signatureOf(memTokens: Set<string>): Set<string> {
  const long = [...memTokens].filter((t) => t.length >= SIGNATURE_TOKEN_LEN)
  if (long.length > 0) return new Set(long)
  const best = [...memTokens].sort((a, b) => b.length - a.length || a.localeCompare(b))[0] ?? ''
  return best ? new Set([best]) : new Set()
}

/** Path basenames without extension, plus meaningful path segments. */
function fileStems(files: string[]): Set<string> {
  const stems = new Set<string>()
  for (const f of files) {
    for (const seg of f.split('/')) {
      const stem = seg.replace(/\.[a-z0-9]+$/i, '').toLowerCase()
      if (stem.length >= MIN_TOKEN_LEN && !STOPWORDS.has(stem)) stems.add(stem)
    }
  }
  return stems
}

function sharesStem(file: string, other: string): boolean {
  const a = fileStems([file])
  for (const s of fileStems([other])) {
    if (a.has(s)) return true
  }
  return false
}

function formatSkillMiss(miss: SkillMiss): string {
  const where =
    miss.evidenceFile !== '' ? `touched \`${miss.evidenceFile}\`` : 'worked the same area'
  return [
    `[skill-miss] Unused project knowledge (${miss.memType}, ${miss.memId}): "${miss.excerpt}"`,
    `This session ${where} but never referenced it. Apply it, or supersede it via: prjct remember decision "<resolution>" --tags resolves:skill-miss,relates:${miss.memId}`,
  ].join('\n')
}

function hashKey(memId: string, excerpt: string): string {
  const normalised = `${memId}::${excerpt.toLowerCase().replace(/\s+/g, ' ').trim()}`
  return crypto.createHash('sha256').update(normalised).digest('hex')
}

function recallCandidates(projectId: string, sessionId: string | null): CandidateMemory[] {
  const entries = projectMemory.recall(projectId, {
    types: [...CANDIDATE_TYPES],
    limit: 120,
  })
  const cutoff = Date.now() - CAPTURED_THIS_SESSION_MS
  const out: CandidateMemory[] = []
  for (const e of entries) {
    // Low-confidence inferences are not "missed knowledge" — only the
    // user/LLM-asserted (declared) and verifiable (extracted) entries
    // and ambiguous ones count.
    if (e.provenance === 'inferred') continue
    // Recency containment — captured this session can't be a "miss".
    if (Date.parse(e.rememberedAt) > cutoff) continue
    if (sessionId && e.tags.session === sessionId) continue
    out.push({
      id: e.id,
      type: e.type,
      content: e.content,
      fileTag: e.tags.file ?? '',
      rememberedAt: e.rememberedAt,
      provenance: e.provenance,
      session: e.tags.session ?? '',
    })
  }
  return out
}

function existingSkillMissKeys(projectId: string): Set<string> {
  try {
    const entries = projectMemory.recall(projectId, {
      types: ['improvement-signal'],
      tags: { source: SOURCE_TAG },
      limit: 100,
      dedupeByKey: false,
    })
    const keys = new Set<string>()
    for (const e of entries) {
      if (e.tags.key) keys.add(e.tags.key)
    }
    return keys
  } catch {
    return new Set()
  }
}

export const _internal = {
  analyze,
  parseJsonl,
  transcriptTextOf,
  textOf,
  tokenize,
  fileStems,
  sharesStem,
  formatSkillMiss,
  hashKey,
  MAX_SKILL_MISSES_PER_SESSION,
}
