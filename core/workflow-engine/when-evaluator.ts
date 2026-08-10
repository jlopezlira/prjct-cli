/**
 * `when_expr` evaluator for conditional workflow rules.
 *
 * Tiny DSL — deliberately small so it's readable at a glance:
 *
 *   tags:type=bug           — active work tag equals
 *   tags:domain~frontend    — active work tag contains (case-insensitive)
 *   branch=main             — current branch equals
 *   branch~feat/            — current branch contains
 *   files:*.ts              — any changed file matches glob
 *   files:core/**           — nested glob
 *
 * Multiple conditions separated by whitespace AND together. An empty
 * expression matches everything (default workflow behavior).
 */

export interface WhenContext {
  /** Active work tags, `{ type: 'bug', domain: 'auth' }` style */
  tags: Record<string, string>
  /** Git branch name (shortened, e.g. `feat/login`) */
  branch: string
  /** File paths modified since task start (or recent diff) */
  filesChanged: string[]
}

interface Condition {
  kind: 'tags' | 'branch' | 'files'
  key?: string
  op: '=' | '~'
  value: string
}

/**
 * Parse a `when_expr` into AND'd conditions. Invalid tokens are dropped
 * silently — a rule with garbage should still run (fail-open), since the
 * alternative is an undebuggable skip.
 */
function parseWhen(expr: string): Condition[] {
  const tokens = expr
    .split(/\s+/)
    .map((t) => t.trim())
    .filter(Boolean)
  const conditions: Condition[] = []

  for (const token of tokens) {
    // tags:key=value or tags:key~value
    const tagsMatch = token.match(/^tags:([a-zA-Z0-9_\-.]+)([=~])(.+)$/)
    if (tagsMatch) {
      conditions.push({
        kind: 'tags',
        key: tagsMatch[1],
        op: tagsMatch[2] as '=' | '~',
        value: tagsMatch[3],
      })
      continue
    }

    // branch=value or branch~value
    const branchMatch = token.match(/^branch([=~])(.+)$/)
    if (branchMatch) {
      conditions.push({ kind: 'branch', op: branchMatch[1] as '=' | '~', value: branchMatch[2] })
      continue
    }

    // files:glob  (implicit ~ / contains-glob match)
    const filesMatch = token.match(/^files:(.+)$/)
    if (filesMatch) {
      conditions.push({ kind: 'files', op: '~', value: filesMatch[1] })
    }
    // Silently ignore unknown tokens — rule still runs.
  }

  return conditions
}

// Cache of compiled glob → RegExp. The same condition is often evaluated
// against N files and reused across workflow invocations, so compiling
// once pays off immediately.
const globCache = new Map<string, RegExp>()

function globToRegex(glob: string): RegExp {
  const cached = globCache.get(glob)
  if (cached) return cached

  // Minimal glob → regex. Walk the string once to avoid the `**`/`*`
  // ordering hazard a replace chain has (and any unicode-placeholder
  // tricks that break on exotic inputs).
  const translate = (index: number): string => {
    if (index >= glob.length) return ''
    const c = glob[index]
    if (c === '*') {
      return glob[index + 1] === '*' ? `.*${translate(index + 2)}` : `[^/]*${translate(index + 1)}`
    }
    const translated = /[.+^${}()|[\]\\]/.test(c) ? `\\${c}` : c
    return `${translated}${translate(index + 1)}`
  }
  const out = translate(0)
  const re = new RegExp(`^${out}$`)
  globCache.set(glob, re)
  return re
}

function matchCondition(cond: Condition, ctx: WhenContext): boolean {
  if (cond.kind === 'tags') {
    const actual = ctx.tags[cond.key ?? ''] ?? ''
    return cond.op === '='
      ? actual === cond.value
      : actual.toLowerCase().includes(cond.value.toLowerCase())
  }
  if (cond.kind === 'branch') {
    return cond.op === '='
      ? ctx.branch === cond.value
      : ctx.branch.toLowerCase().includes(cond.value.toLowerCase())
  }
  if (cond.kind === 'files') {
    const re = globToRegex(cond.value)
    return ctx.filesChanged.some((f) => re.test(f))
  }
  return true
}

/**
 * True if the expression matches the context, OR the expression is empty
 * (unconditional rule). Fail-open on parse failure.
 */
export function evaluateWhen(expr: string | null | undefined, ctx: WhenContext): boolean {
  if (!expr || !expr.trim()) return true
  const conditions = parseWhen(expr)
  if (conditions.length === 0) return true
  return conditions.every((c) => matchCondition(c, ctx))
}
