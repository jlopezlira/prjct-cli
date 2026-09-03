/**
 * Project file inventory — dynamic, language-agnostic discovery of which
 * extensions (and inferred languages) this project actually contains.
 *
 * Built on first analysis / every `prjct sync`. Work-scope path extraction
 * and filters read this inventory instead of hard-coded language lists.
 */

import path from 'node:path'
import { prjctDb } from '../storage/database'
import { walkDir } from '../utils/file-helper'

export const FILE_INVENTORY_DOC_KEY = 'file-inventory'

/** Extension → count. Keys include the leading dot, e.g. `.ts`, `.vue`. */
export type ExtensionCounts = Record<string, number>

export interface ProjectFileInventory {
  /** Extensions observed in the tree (dot-prefixed), sorted by count desc. */
  extensions: ExtensionCounts
  /** Inferred language labels from extension map (best-effort, not a gate). */
  languages: string[]
  /** Total files walked (after SKIP_DIRS). */
  fileCount: number
  /** ISO timestamp when inventory was built. */
  builtAt: string
  /** Project path fingerprint (basename) for debugging. */
  projectHint?: string
}

/** Pure noise basenames / paths — never used as language gates. */
const NOISE_BASENAME_RE =
  /^(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|composer\.lock|Cargo\.lock|poetry\.lock|CHANGELOG(\.md)?|LICENSE(\.md)?|\.DS_Store)$/i
const NOISE_PATH_RE = /(^|\/)(node_modules|dist|build|\.git|coverage|\.next|target|vendor)(\/|$)/i
const BINARY_EXT = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.ico',
  '.woff',
  '.woff2',
  '.ttf',
  '.eot',
  '.mp4',
  '.mp3',
  '.zip',
  '.gz',
  '.tar',
  '.wasm',
  '.exe',
  '.dll',
  '.so',
  '.dylib',
  '.bin',
  '.pdf',
  '.ico',
])

/** Soft map ext → language label for UX only (inventory languages list). */
const EXT_LANGUAGE_HINT: Record<string, string> = {
  '.ts': 'TypeScript',
  '.tsx': 'TypeScript',
  '.js': 'JavaScript',
  '.jsx': 'JavaScript',
  '.mjs': 'JavaScript',
  '.cjs': 'JavaScript',
  '.vue': 'Vue',
  '.svelte': 'Svelte',
  '.py': 'Python',
  '.go': 'Go',
  '.rs': 'Rust',
  '.java': 'Java',
  '.kt': 'Kotlin',
  '.kts': 'Kotlin',
  '.swift': 'Swift',
  '.rb': 'Ruby',
  '.php': 'PHP',
  '.cs': 'C#',
  '.fs': 'F#',
  '.cpp': 'C++',
  '.cc': 'C++',
  '.c': 'C',
  '.h': 'C/C++',
  '.hpp': 'C++',
  '.m': 'Objective-C',
  '.mm': 'Objective-C++',
  '.scala': 'Scala',
  '.clj': 'Clojure',
  '.ex': 'Elixir',
  '.exs': 'Elixir',
  '.erl': 'Erlang',
  '.hs': 'Haskell',
  '.lua': 'Lua',
  '.r': 'R',
  '.dart': 'Dart',
  '.sql': 'SQL',
  '.graphql': 'GraphQL',
  '.gql': 'GraphQL',
  '.proto': 'Protobuf',
  '.md': 'Markdown',
  '.mdx': 'MDX',
  '.json': 'JSON',
  '.yml': 'YAML',
  '.yaml': 'YAML',
  '.toml': 'TOML',
  '.css': 'CSS',
  '.scss': 'SCSS',
  '.sass': 'Sass',
  '.less': 'Less',
  '.html': 'HTML',
  '.htm': 'HTML',
  '.sh': 'Shell',
  '.bash': 'Shell',
  '.zsh': 'Shell',
  '.ps1': 'PowerShell',
  '.swiftui': 'Swift',
}

/**
 * Walk the project and count extensions. Pure discovery — no language gate.
 */
export async function buildFileInventory(
  projectPath: string,
  opts: { maxFiles?: number } = {}
): Promise<ProjectFileInventory> {
  const files = await walkDir(projectPath, {
    skipDotfiles: true,
    maxFiles: opts.maxFiles ?? 50_000,
  })
  const sourceFiles = files.filter((rel) => {
    if (NOISE_PATH_RE.test(rel)) return false
    const base = path.basename(rel)
    if (NOISE_BASENAME_RE.test(base)) return false
    const ext = path.extname(base).toLowerCase()
    return Boolean(ext && ext !== '.' && !BINARY_EXT.has(ext))
  })
  const extensions = sourceFiles.reduce<ExtensionCounts>((counts, rel) => {
    const ext = path.extname(path.basename(rel)).toLowerCase()
    counts[ext] = (counts[ext] ?? 0) + 1
    return counts
  }, Object.create(null) as ExtensionCounts)

  const languages = languagesFromExtensions(extensions)
  return {
    extensions,
    languages,
    fileCount: sourceFiles.length,
    builtAt: new Date().toISOString(),
    projectHint: path.basename(projectPath),
  }
}

export function languagesFromExtensions(extensions: ExtensionCounts): string[] {
  const langs = new Set<string>()
  const sorted = Object.entries(extensions).sort((a, b) => b[1] - a[1])
  for (const [ext] of sorted) {
    const hint = EXT_LANGUAGE_HINT[ext]
    if (hint) langs.add(hint)
  }
  return [...langs]
}

export function saveFileInventory(projectId: string, inv: ProjectFileInventory): void {
  prjctDb.setDoc(projectId, FILE_INVENTORY_DOC_KEY, inv)
}

export function loadFileInventory(projectId: string): ProjectFileInventory | null {
  try {
    return prjctDb.getDoc<ProjectFileInventory>(projectId, FILE_INVENTORY_DOC_KEY)
  } catch {
    return null
  }
}

/**
 * Build + persist. Called from sync (and lazy warm path).
 */
export async function refreshFileInventory(
  projectId: string,
  projectPath: string
): Promise<ProjectFileInventory> {
  const inv = await buildFileInventory(projectPath)
  saveFileInventory(projectId, inv)
  return inv
}

/**
 * Extensions this project actually uses (dot-prefixed, lowercase).
 * Empty inventory → empty set (caller falls back to inventory-agnostic accept).
 */
export function inventoryExtensions(projectId: string): Set<string> {
  const inv = loadFileInventory(projectId)
  if (!inv?.extensions) return new Set()
  return new Set(Object.keys(inv.extensions).map((e) => e.toLowerCase()))
}

/**
 * Hard filter: noise/binary only. Unknown extensions are NEVER dropped once
 * inventory exists — monorepos add langs mid-session; next sync refreshes
 * weights, but scope must not go dark (P0-4: downrank, don't drop).
 */
export function pathMatchesInventory(
  projectId: string,
  filePath: string,
  _opts: { requireInventory?: boolean } = {}
): boolean {
  void projectId
  const n = filePath.replace(/^\.\//, '').replace(/\\/g, '/').trim()
  if (!n) return false
  if (NOISE_PATH_RE.test(n)) return false
  const base = n.split('/').pop() ?? n
  if (NOISE_BASENAME_RE.test(base)) return false
  const ext = path.extname(base).toLowerCase()
  if (!ext) return n.includes('/')
  if (BINARY_EXT.has(ext)) return false
  return true
}

/**
 * Soft score multiplier for ranking (not a gate).
 * - inventory empty → 1.0 (open)
 * - ext in inventory → 1.0
 * - ext unknown vs inventory → 0.45 (downrank until next sync)
 */
export function inventoryPathWeight(projectId: string, filePath: string): number {
  return inventoryPathWeightFor(inventoryExtensions(projectId), filePath)
}

/**
 * Same weight against an already-loaded extension set. Rankers score dozens
 * of candidates per query; loading + parsing the inventory doc once per
 * candidate (the `inventoryPathWeight` path) was the single largest
 * per-query cost in work-scope merge.
 */
export function inventoryPathWeightFor(exts: ReadonlySet<string>, filePath: string): number {
  const n = filePath.replace(/^\.\//, '').replace(/\\/g, '/').trim()
  const base = n.split('/').pop() ?? n
  const ext = path.extname(base).toLowerCase()
  if (!ext) return 0.7
  if (exts.size === 0) return 1
  return exts.has(ext) ? 1 : 0.45
}

/** Top extensions for agent/debug display. */
export function formatInventorySummary(inv: ProjectFileInventory | null): string {
  if (!inv || Object.keys(inv.extensions).length === 0) {
    return 'File inventory: empty — run `prjct sync` to discover languages/extensions.'
  }
  const top = Object.entries(inv.extensions)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map(([e, c]) => `${e}×${c}`)
    .join(' ')
  const langs = inv.languages.length > 0 ? inv.languages.join(', ') : 'unknown'
  return `File inventory: ${inv.fileCount} files · langs: ${langs} · ${top}`
}
