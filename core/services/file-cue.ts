import {
  formatRelevantProjectPatterns,
  selectRelevantProjectPatterns,
} from './project-pattern-context'
import { getActiveProjectStyle } from './project-style-evolution'
import { resolveWorkScopeSync, toLikelyFileHits, type WorkScopeHit } from './work-scope'

export interface LikelyFileHit {
  path: string
  signals: string[]
  /** One-line, honest reason this file surfaced — lets the agent trust the cue
   *  and read it directly instead of grep-walking the repo. */
  reason: string
}

const DEFAULT_FILE_CUE_COUNT = 8
/** Prompt-hook push is leaner than work-start: the agent can always pull
 *  the full scope via prjct_relevant_files (pull-first). */
const PROMPT_FILE_CUE_COUNT = 5
const PROMPT_ALIGNMENT_FILE_COUNT = 3
const PROMPT_ALIGNMENT_PATH_BUDGET = 150

export interface RepositoryAlignmentCard {
  content: string
  /** Stable until sync/analysis creates a materially new style snapshot. */
  revision: string
}

/**
 * Rank likely files via the unified work-scope pipeline:
 * memory seeds (FTS) + BM25 + import graph + co-change + graph expand.
 * Prefer async `resolveWorkScope` at work-start for semantic memory blend.
 */
export function rankLikelyFiles(
  projectId: string,
  query: string,
  limit: number = DEFAULT_FILE_CUE_COUNT
): LikelyFileHit[] {
  return toLikelyFileHits(resolveWorkScopeSync(projectId, query, limit).files)
}

export function formatLikelyFileForAgent(file: LikelyFileHit | WorkScopeHit): string {
  const suffix = file.signals.length > 0 ? ` (${file.signals.join('+')})` : ''
  return `\`${file.path}\` — ${file.reason}${suffix}`
}

/**
 * Prompt-hook push: constrained file list + MUST-not-grep discipline.
 * Silent when there are zero hits (keeps prompt lean); work-start always
 * surfaces the full empty/cold guidance.
 */
export function buildIndexedFileCue(projectId: string, query: string): string | null {
  const scope = resolveWorkScopeSync(projectId, query, PROMPT_FILE_CUE_COUNT)
  if (scope.files.length === 0) return null
  return scope.agentBlock || null
}

/**
 * Required prompt lane for code-producing turns. This is deliberately shorter
 * than the regular indexed-file cue so it can coexist with a routed workflow
 * inside UserPromptSubmit's 700-character budget.
 *
 * The file index is not merely navigation: the top hits are the concrete
 * implementations Codex must inspect before it invents a new abstraction.
 */
export function buildRepositoryAlignmentCard(
  projectId: string,
  query: string,
  patternQuery: string = query
): RepositoryAlignmentCard | null {
  const scope = resolveWorkScopeSync(projectId, query, PROMPT_ALIGNMENT_FILE_COUNT)
  const targetFiles = scope.files.map((file) => file.path)
  const snapshot = getActiveProjectStyle(projectId)
  const syncedPatterns = formatRelevantProjectPatterns(
    selectRelevantProjectPatterns(snapshot, patternQuery, {
      targetFiles,
      maxPatterns: 2,
      maxConventions: 1,
      maxAntiPatterns: 1,
    }),
    { maxChars: 280, header: 'Synced patterns relevant to this task:' }
  )
  const discipline = syncedPatterns
    ? [
        '# prjct: repository alignment (MUST before edit)',
        'Apply the synced house patterns below. Inspect only the target/canonical evidence when needed; never rediscover the whole repo.',
      ]
    : [
        '# prjct: repository alignment (MUST before edit)',
        'Read the existing implementation first. Reuse existing abstractions and patterns. Do not duplicate logic inline or invent a parallel helper.',
      ]
  if (scope.files.length === 0) {
    return {
      content: [
        ...discipline,
        syncedPatterns,
        'No indexed hit: resolve the existing implementation with `prjct search` / `prjct_relevant_files` before writing.',
      ]
        .filter(Boolean)
        .join('\n'),
      revision: snapshot?.id ?? 'index-only',
    }
  }
  const rawFiles = scope.files.map((file) => `\`${file.path}\``).join(', ')
  const files =
    rawFiles.length <= PROMPT_ALIGNMENT_PATH_BUDGET
      ? rawFiles
      : `${rawFiles.slice(0, PROMPT_ALIGNMENT_PATH_BUDGET - 1)}…`
  return {
    content: [...discipline, syncedPatterns, `Target implementation: ${files}`]
      .filter(Boolean)
      .join('\n'),
    revision: snapshot?.id ?? 'index-only',
  }
}

/** Backward-compatible string surface for callers that do not own delivery. */
export function buildRepositoryAlignmentCue(
  projectId: string,
  query: string,
  patternQuery: string = query
): string | null {
  return buildRepositoryAlignmentCard(projectId, query, patternQuery)?.content ?? null
}
