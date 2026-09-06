/**
 * Turn-level task classifier — the router that lets the harness decide, per
 * prompt, whether to stay silent, inject knowledge, hand over a ranked set, or
 * take the verify loop. Pure and cheap (regex + optional in-memory symbol
 * lookup, no SQLite, target <5ms) so it can run inside the prompt hook.
 *
 * Classes (priority order VERIFY > PROJECT_KNOWLEDGE > SELF_CONTAINED >
 * EXPLORATION > UNKNOWN):
 *   SELF_CONTAINED    — the prompt names the file/symbol to touch; the agent
 *                       alone is fastest, so the harness should be silent.
 *   PROJECT_KNOWLEDGE — a decision/why question; inject memory with provenance.
 *   EXPLORATION       — a cross-file bug / "find where"; hand over a ranked set.
 *   VERIFY            — implement / fix / make-pass; take the verify loop.
 *   UNKNOWN           — none of the above; fall back to current behaviour.
 */

import type { TaskClass } from '../eval/ab-tasks'

export type { TaskClass }

export interface TurnClassification {
  cls: TaskClass | 'UNKNOWN'
  confidence: number
  signals: string[]
}

/** Optional context: a symbol-existence probe (injected so this stays pure). */
export interface TurnClassContext {
  /** True when the token names a symbol the project index knows. */
  hasSymbol?: (token: string) => boolean
  /** True when the string is a path that exists in the project. */
  pathExists?: (candidate: string) => boolean
}

const VERIFY_RE =
  /\b(make .{0,30}pass|get .{0,20}(test|ci|build|gauntlet|suite).{0,20}(green|passing)|(green|passing) again|fix the (failing|broken|red)|failing test|test(s)? (fail|are failing|is failing)|reproduce (the )?(bug|failure|crash)|red[\s-]*green|turn .{0,20}green|why (is|are) .{0,30}failing)\b/i

const IMPLEMENT_RE =
  /\b(implement|add (a |the )?(feature|endpoint|command|flag|option|migration)|build (a|the)|wire up|make it (work|do)|write (a|the) (function|test|migration))\b/i

// No trailing \b: Spanish endings like "qué" are non-word chars, so a closing
// \b would fail right after them and drop the whole match.
const DECISION_RE =
  /\b(why (did|do|does|is|are|should|would)|por\s?qué|porque|should (we|i|it)|which (approach|option|way|one)|what('| i)?s the (right|best|correct) (way|approach|place)|where (should|must|do we) .{0,40}(live|go|be (persisted|stored|defined))|decided|decision|trade[\s-]?off|rationale|convention|do we (use|have|store))/i

const EXPLORATION_RE =
  /\b(where (is|are|does)|find (all|every|the|where)|all callers|every (place|caller|usage)|across (the )?(codebase|repo|code|files)|trace (through|the|how)|how (does|do) .{0,50}(work|flow)|flows? through|what (calls|uses|depends on)|refactor|rename .{0,30}(everywhere|across))/i

/** Candidate path-shaped tokens; `isPathLike` decides which ones count. */
const PATH_TOKEN_RE = /[\w.@-]+(?:\/[\w.@-]+)+|\b[\w-]+\.[a-z]{1,5}\b/g
const CODE_EXT_RE = /\.(ts|tsx|js|mjs|cjs|json|md|c|h|py|go|rs|yml|yaml|sh|sql|css|html|toml)$/i
// Unanchored on the left so `./core/x` and `/home/u/proj/core/x` count too.
const SOURCE_DIR_RE =
  /(?:^|\/)(?:core|src|lib|app|scripts|native|bin|evals|docs|test|tests|__tests__|\.github|assets|templates|packages|apps)\/[\w.@-]/
/**
 * A real path names a source dir (at any depth) or ends in a code extension.
 * Bare `a/b` prose ("and/or", "A/B", "with/without") has neither and must NOT
 * read as "the prompt names the file" — that would silence the harness.
 */
function isPathLike(token: string): boolean {
  return CODE_EXT_RE.test(token) || SOURCE_DIR_RE.test(token)
}
/** A token that looks like a code identifier worth checking against the index. */
const SYMBOL_TOKEN_RE = /\b([A-Z][a-zA-Z0-9]{3,}|[a-z][a-zA-Z0-9]*[A-Z][a-zA-Z0-9]*)\b/g

function pathTokens(prompt: string): string[] {
  return [...new Set(prompt.match(PATH_TOKEN_RE) ?? [])].filter(isPathLike)
}

function symbolTokens(prompt: string): string[] {
  return [...new Set(prompt.match(SYMBOL_TOKEN_RE) ?? [])].slice(0, 12)
}

/**
 * Classify a single turn. Deterministic; the optional context sharpens
 * SELF_CONTAINED (a named path/symbol that actually exists) but is never
 * required — without it, a path-shaped token still counts.
 */
export function classifyTurn(prompt: string, ctx: TurnClassContext = {}): TurnClassification {
  const text = (prompt ?? '').trim()
  if (!text) return { cls: 'UNKNOWN', confidence: 0, signals: [] }
  const signals: string[] = []

  const verify = VERIFY_RE.test(text) || (IMPLEMENT_RE.test(text) && /\btest|spec\b/i.test(text))
  if (VERIFY_RE.test(text)) signals.push('verify-phrase')
  if (IMPLEMENT_RE.test(text)) signals.push('implement-phrase')

  const decision = DECISION_RE.test(text)
  if (decision) signals.push('decision-phrase')

  const paths = pathTokens(text)
  const existingPaths = ctx.pathExists ? paths.filter((p) => ctx.pathExists!(p)) : paths
  if (paths.length) signals.push(`paths:${paths.length}`)

  const symbols = symbolTokens(text)
  const knownSymbols = ctx.hasSymbol ? symbols.filter((s) => ctx.hasSymbol!(s)) : []
  if (knownSymbols.length) signals.push(`symbols:${knownSymbols.length}`)

  const exploration = EXPLORATION_RE.test(text)
  if (exploration) signals.push('exploration-phrase')

  // Priority order. VERIFY first: a failing-test/implement-with-tests turn is
  // about execution regardless of what else it mentions.
  if (verify) return { cls: 'VERIFY', confidence: 0.9, signals }
  // A decision/why question is knowledge even when it names a file.
  if (decision) return { cls: 'PROJECT_KNOWLEDGE', confidence: 0.8, signals }
  // Named, existing target and no cross-file spread → the agent alone is best.
  if ((existingPaths.length > 0 || knownSymbols.length > 0) && !exploration) {
    return { cls: 'SELF_CONTAINED', confidence: knownSymbols.length ? 0.8 : 0.7, signals }
  }
  if (exploration) return { cls: 'EXPLORATION', confidence: 0.7, signals }
  // A bare path with no other signal still reads as self-contained.
  if (paths.length > 0) return { cls: 'SELF_CONTAINED', confidence: 0.55, signals }
  return { cls: 'UNKNOWN', confidence: 0.3, signals }
}
