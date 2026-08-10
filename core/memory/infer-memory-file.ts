/**
 * Infer `tags.file` for remember captures so guard / pre-edit / work risks
 * fire without requiring the agent to pass `--tags file:…` manually.
 *
 * Source of truth for the column is still `tags.file` (SQL trigger extracts it).
 * Explicit `tags.file` always wins. Inference is best-effort and conservative.
 */

import fs from 'node:fs'
import path from 'node:path'

/** Source-ish extensions we will bind for anticipation. */
const FILE_EXT =
  'ts|tsx|js|jsx|mjs|cjs|mts|cts|py|go|rs|vue|svelte|css|scss|less|json|md|sql|yml|yaml|toml|swift|kt|java|rb|php|sh'

/**
 * Repo-relative path candidates in free text.
 * Requires at least one directory segment (avoids bare `index.ts` false positives).
 */
const PATH_RE = new RegExp(
  String.raw`(?:^|[\s\`"'(:=\[])((?:\.\.?\/)?(?:[\w.@+-]+\/)+[\w.@+-]+\.(?:${FILE_EXT}))\b`,
  'gi'
)

const BLOCKED_SEGMENT =
  /(?:^|\/)(?:node_modules|dist|\.git|build|coverage|vendor|\.next|\.turbo)(?:\/|$)/i

/** Prefer real app/source trees over noise. */
const STRONG_PREFIX =
  /^(?:src|core|app|apps|lib|packages|components|hooks|routes|server|services|domain|bin|scripts|tests?|__tests__)\//

/**
 * Strong roots for stripping absolute paths. Intentionally excludes `app`/`apps`
 * — on macOS home paths contain `/Apps/` which would steal the suffix.
 * (Relative paths can still score via STRONG_PREFIX including app/.)
 */
const ABS_STRIP_ROOTS = [
  'src',
  'core',
  'packages',
  'components',
  'hooks',
  'routes',
  'server',
  'services',
  'domain',
  'bin',
  'scripts',
  'lib',
  'test',
  'tests',
  '__tests__',
] as const

export type InferMemoryFileInput = {
  content: string
  tags?: Record<string, string>
  /** Project root — when set, prefer paths that exist on disk. */
  projectPath?: string | null
  /**
   * Optional work-scope / likely-file paths from the active cycle.
   * Basename hits in content promote those full paths.
   */
  cycleFiles?: string[] | null
}

/**
 * Resolve the file tag to store (or null if nothing confident).
 * Never invents paths without a textual or cycle signal.
 */
export function inferMemoryFileTag(input: InferMemoryFileInput): string | null {
  const explicit = cleanPath(input.tags?.file)
  if (explicit) return explicit

  // Context-style multi-file tag: first usable path becomes the preventive anchor.
  const fromFilesTag = firstFromCommaList(input.tags?.files)
  if (fromFilesTag) return fromFilesTag

  const content = input.content ?? ''
  if (!content.trim()) return null

  const extracted = extractRepoRelativePaths(content)
  const cycle = (input.cycleFiles ?? []).map(cleanPath).filter((p): p is string => Boolean(p))

  // Promote cycle paths whose basename is mentioned in the content.
  for (const cf of cycle) {
    const base = path.basename(cf)
    if (base.length >= 3 && contentIncludesBasename(content, base)) {
      extracted.unshift(cf)
    }
  }

  if (extracted.length === 0) return null

  const unique = dedupePaths(extracted)
  const ranked = unique
    .map((p) => ({ path: p, score: scoreCandidate(p, input.projectPath, content) }))
    .filter((c) => c.score > 0)
    .sort((a, b) => b.score - a.score || b.path.length - a.path.length)

  return ranked[0]?.path ?? null
}

/**
 * Absolute filesystem paths — cleaned via leftmost strong-root strip
 * (`/Users/…/repo/src/lib/api.ts` → `src/lib/api.ts`).
 */
const ABS_PATH_RE = new RegExp(
  String.raw`(?:^|[\s\`"'(:=\[])(\/(?:[\w.@+-]+\/)+[\w.@+-]+\.(?:${FILE_EXT}))\b`,
  'gi'
)

/** Extract unique repo-relative path strings from free text (order = first seen). */
export function extractRepoRelativePaths(content: string): string[] {
  const out: string[] = []
  PATH_RE.lastIndex = 0
  for (const m of content.matchAll(PATH_RE)) {
    const cleaned = cleanPath(m[1])
    if (cleaned) out.push(cleaned)
  }
  ABS_PATH_RE.lastIndex = 0
  for (const m2 of content.matchAll(ABS_PATH_RE)) {
    const cleaned = cleanPath(m2[1])
    if (cleaned) out.push(cleaned)
  }
  return dedupePaths(out)
}

function scoreCandidate(
  filePath: string,
  projectPath: string | null | undefined,
  content: string
): number {
  if (BLOCKED_SEGMENT.test(filePath)) return 0
  if (filePath.includes('://')) return 0

  const adjustments = [1, STRONG_PREFIX.test(filePath) ? 3 : 0]
  // Backtick / explicit citation weight: path appears in backticks in content
  if (content.includes(`\`${filePath}\``)) adjustments.push(2)
  if (projectPath) {
    try {
      const abs = path.isAbsolute(filePath) ? filePath : path.join(projectPath, filePath)
      adjustments.push(fs.existsSync(abs) && fs.statSync(abs).isFile() ? 6 : -1)
    } catch {
      /* ignore fs errors */
    }
  }
  // Prefer deeper, more specific paths slightly
  adjustments.push(Math.min(3, filePath.split('/').length - 1))
  return adjustments.reduce((total, adjustment) => total + adjustment, 0)
}

function firstFromCommaList(raw: string | undefined): string | null {
  if (!raw) return null
  for (const part of raw.split(',')) {
    const cleaned = cleanPath(part)
    if (cleaned) return cleaned
  }
  return null
}

function cleanPath(raw: string | undefined | null): string | null {
  if (!raw) return null
  const normalized = raw.trim().replace(/\\/g, '/')
  // strip wrapping quotes/backticks
  const unquoted = normalized.replace(/^['"`]+|['"`]+$/g, '')
  // drop leading ./
  const relative = unquoted.replace(/^\.\//, '')
  // absolute / home paths → leftmost strong root (src/ before nested lib/)
  const p =
    path.isAbsolute(relative) || relative.startsWith('/')
      ? stripAbsoluteToStrongRelative(relative)
      : relative
  if (!p || BLOCKED_SEGMENT.test(p)) return null
  if (!p.includes('/')) return null
  if (!new RegExp(String.raw`\.(?:${FILE_EXT})$`, 'i').test(p)) return null
  return p
}

/** `/Users/…/repo/src/lib/api.ts` → `src/lib/api.ts` (leftmost strong root). */
function stripAbsoluteToStrongRelative(absPath: string): string | null {
  const lower = absPath.toLowerCase()
  const best = ABS_STRIP_ROOTS.map((root) => lower.indexOf(`/${root}/`))
    .filter((index) => index >= 0)
    .sort((a, b) => a - b)
    .map((index) => absPath.slice(index + 1))[0]
  if (best && new RegExp(String.raw`\.(?:${FILE_EXT})$`, 'i').test(best)) return best
  return null
}

function contentIncludesBasename(content: string, base: string): boolean {
  // Word-ish boundary so "auth.ts" doesn't match "reauth.ts" naively —
  // require non-identifier char or edges around the basename.
  const re = new RegExp(`(^|[^\\w.-])${escapeRegExp(base)}([^\\w.-]|$)`, 'i')
  return re.test(content)
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function dedupePaths(paths: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const p of paths) {
    const key = p.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(p)
  }
  return out
}
