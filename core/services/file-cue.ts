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
