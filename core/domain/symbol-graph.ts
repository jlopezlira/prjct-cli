/**
 * Symbol Graph — structural code intelligence (file → symbol layer).
 *
 * P0 quality:
 *   - Extract from noise-stripped source (no symbols/calls inside strings/comments)
 *   - CALLS edges from enclosing function/method/class (by line), not only file:
 *   - Import resolution: relative, @/, tsconfig paths, RESOLVE_EXTENSIONS
 *   - call sites keep line numbers for enclosing-symbol attribution
 *
 * Languages: TypeScript / JavaScript / TSX / JSX (full CALLS path),
 * plus lightweight Python / Go / Rust / Java definition extraction.
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import { RESOLVE_EXTENSIONS } from '../constants/file-patterns'
import { replaceCodeGraph } from '../storage/code-graph-storage'
import prjctDb from '../storage/database'
import type {
  CodeSymbol,
  CodeSymbolEdge,
  SymbolEdgeType,
  SymbolGraphMeta,
  SymbolKind,
  SymbolScore,
  TraceHop,
  TraceResult,
} from '../types/domain.js'
import { batchProcess, walkDir } from '../utils/file-helper'

const META_KEY = 'symbol-graph'
const SYMBOL_EXTS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.py',
  '.go',
  '.rs',
  '.java',
])

const CALL_KEYWORDS = new Set([
  'if',
  'for',
  'while',
  'switch',
  'catch',
  'function',
  'class',
  'return',
  'typeof',
  'new',
  'throw',
  'await',
  'void',
  'super',
  'this',
  'import',
  'require',
  'console',
  'Math',
  'JSON',
  'Object',
  'Array',
  'Promise',
  'Map',
  'Set',
  'Date',
  'Error',
  'Buffer',
  'process',
  'describe',
  'it',
  'test',
  'expect',
  'beforeEach',
  'afterEach',
  'beforeAll',
  'afterAll',
])

const DECL_KEYWORDS = new Set([
  'if',
  'for',
  'while',
  'switch',
  'catch',
  'return',
  'await',
  'typeof',
  'new',
  'throw',
  'else',
  'case',
  'from',
  'import',
  'export',
  'class',
  'function',
  'const',
  'let',
  'var',
  'get',
  'set',
  'constructor',
  'async',
  'static',
  'public',
  'private',
  'protected',
  'readonly',
  'abstract',
  'extends',
  'implements',
  'interface',
  'type',
  'enum',
  'default',
  'as',
  'of',
  'in',
  'do',
  'try',
  'finally',
  'yield',
  'with',
])

// Extraction types

interface RawSymbol {
  kind: SymbolKind
  name: string
  startLine: number
  endLine: number | null
  exported: boolean
}

interface CallSite {
  name: string
  line: number
}

export interface FileExtract {
  filePath: string
  symbols: RawSymbol[]
  /** Unique call names (compat + scoring). */
  callNames: string[]
  /** Call sites with line for enclosing-symbol attribution. */
  calls: CallSite[]
  /** Named import local → specifier as written in source. */
  importBindings: Map<string, string>
  /** local → resolved project-relative file path (filled during extractProject). */
  resolvedImports: Map<string, string>
}

function lineOf(content: string, index: number): number {
  return content.slice(0, Math.min(index, content.length)).split('\n').length
}

function symbolId(file: string, kind: string, name: string, startLine: number): string {
  return `${file}#${kind}:${name}@${startLine}`
}

function qnameOf(file: string, name: string): string {
  const base = file.replace(/\.[^.]+$/, '').replace(/[/\\]/g, '.')
  return `${base}.${name}`
}

function isSourceFile(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase()
  return SYMBOL_EXTS.has(ext)
}

/**
 * Strip comments + string/template literals while preserving newlines so
 * line numbers stay aligned with the original source.
 * Linear scan (no catastrophic regex backtracking on large files).
 */
export function stripNoise(content: string): string {
  const noise =
    /\/\/[^\n]*(?:\n|$)|\/\*(?:[^*]|\*(?!\/))*(?:\*\/|$)|'(?:\\[\s\S]|[^'\\])*(?:'|$)|"(?:\\[\s\S]|[^"\\])*(?:"|$)|`(?:\\[\s\S]|[^`\\])*(?:`|$)/g
  return content.replace(noise, (match) => match.replace(/[^\n]/g, ' '))
}

function emptyExtract(filePath: string): FileExtract {
  return {
    filePath,
    symbols: [],
    callNames: [],
    calls: [],
    importBindings: new Map(),
    resolvedImports: new Map(),
  }
}

function finalizeCalls(calls: CallSite[]): { calls: CallSite[]; callNames: string[] } {
  const names = [...new Set(calls.map((c) => c.name))]
  return { calls, callNames: names }
}

function extractTsJs(content: string, filePath: string): FileExtract {
  const symbols: RawSymbol[] = []
  const calls: CallSite[] = []
  const importBindings = new Map<string, string>()
  // Extract from cleaned source so string literals don't mint fake symbols/calls
  const clean = stripNoise(content)

  const declPatterns: Array<{
    re: RegExp
    kind: SymbolKind
    nameIdx: number
    exported?: boolean
  }> = [
    {
      re: /export\s+(?:async\s+)?function\s+(\w+)/g,
      kind: 'function',
      nameIdx: 1,
      exported: true,
    },
    { re: /(?:^|[^\w.])(?:async\s+)?function\s+(\w+)/g, kind: 'function', nameIdx: 1 },
    {
      re: /export\s+(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_]\w*)\s*=>/g,
      kind: 'function',
      nameIdx: 1,
      exported: true,
    },
    {
      re: /(?:^|[\n;])(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_]\w*)\s*=>/g,
      kind: 'function',
      nameIdx: 1,
    },
    {
      re: /export\s+(?:abstract\s+)?class\s+(\w+)/g,
      kind: 'class',
      nameIdx: 1,
      exported: true,
    },
    { re: /(?:^|[^\w.])(?:abstract\s+)?class\s+(\w+)/g, kind: 'class', nameIdx: 1 },
    { re: /export\s+interface\s+(\w+)/g, kind: 'interface', nameIdx: 1, exported: true },
    { re: /(?:^|[^\w.])interface\s+(\w+)/g, kind: 'interface', nameIdx: 1 },
    { re: /export\s+type\s+(\w+)\s*[=<]/g, kind: 'type', nameIdx: 1, exported: true },
    { re: /(?:^|[^\w.])type\s+(\w+)\s*[=<]/g, kind: 'type', nameIdx: 1 },
    { re: /export\s+enum\s+(\w+)/g, kind: 'enum', nameIdx: 1, exported: true },
    { re: /(?:^|[^\w.])enum\s+(\w+)/g, kind: 'enum', nameIdx: 1 },
    {
      re: /export\s+(?:const|let|var)\s+(\w+)\s*[:=]/g,
      kind: 'const',
      nameIdx: 1,
      exported: true,
    },
    // Methods: keep the param span bounded to avoid catastrophic backtracking
    {
      re: /(?:^|\n)[ \t]+(?:(?:public|private|protected|static|async|readonly)\s+)*(\w+)\s*\([^)]{0,200}\)\s*[:{]/g,
      kind: 'method',
      nameIdx: 1,
    },
  ]

  const seen = new Set<string>()
  for (const { re, kind, nameIdx, exported } of declPatterns) {
    re.lastIndex = 0
    for (const m of clean.matchAll(re)) {
      const name = m[nameIdx]
      if (!name || name.length < 2 || DECL_KEYWORDS.has(name)) continue
      const startLine = lineOf(clean, m.index)
      const key = `${kind}:${name}@${startLine}`
      if (seen.has(key)) continue
      seen.add(key)
      symbols.push({
        kind,
        name,
        startLine,
        endLine: null,
        exported: exported === true,
      })
    }
  }

  // Imports MUST read original source — stripNoise blanks string literals.
  const importRe =
    /import\s+(?:type\s+)?(?:\{([^}]+)\}|(\w+)(?:\s*,\s*\{([^}]+)\})?|\*\s+as\s+(\w+))\s+from\s+['"]([^'"]+)['"]/g
  for (const im of content.matchAll(importRe)) {
    const source = im[5]!
    const bindNamed = (chunk: string | undefined) => {
      if (!chunk) return
      for (const part of chunk.split(',')) {
        const bits = part
          .trim()
          .replace(/^type\s+/, '')
          .split(/\s+as\s+/)
        const local = (bits[1] ?? bits[0])?.trim()
        if (local && /^[A-Za-z_][\w]*$/.test(local)) importBindings.set(local, source)
      }
    }
    bindNamed(im[1])
    bindNamed(im[3])
    if (im[2]) importBindings.set(im[2], source)
    if (im[4]) importBindings.set(im[4], source)
  }

  // require('...') — also from original
  const reqRe = /(?:const|let|var)\s+(\w+)\s*=\s*require\s*\(\s*['"]([^'"]+)['"]\s*\)/g
  for (const im2 of content.matchAll(reqRe)) {
    importBindings.set(im2[1]!, im2[2]!)
  }

  // Call sites with lines — cap to avoid edge explosion on huge files
  const callRe = /\b([A-Za-z_][\w]*)\s*\(/g
  const MAX_CALLS = 400
  for (const cm of clean.matchAll(callRe)) {
    const name = cm[1]!
    if (CALL_KEYWORDS.has(name) || name.length < 2) continue
    const line = lineOf(clean, cm.index)
    calls.push({ name, line })
    if (calls.length >= MAX_CALLS) break
  }

  // Routes — original source (paths live in strings)
  // Express/Hono/Fastify: app.get('/path'
  const routeRe = /\.(?:get|post|put|patch|delete|options|head|all)\s*\(\s*['"`](\/[^'"`]*)['"`]/gi
  for (const rm of content.matchAll(routeRe)) {
    const routePath = rm[1]!
    const name = routePath.replace(/[^\w/.-]/g, '').slice(0, 64) || 'route'
    symbols.push({
      kind: 'route',
      name,
      startLine: lineOf(content, rm.index),
      endLine: null,
      exported: true,
    })
  }
  // FastAPI / Flask decorators
  const decoRe =
    /@(?:app|router|api|bp)\.(?:get|post|put|patch|delete|options|head|api_route)\s*\(\s*['"`](\/[^'"`]*)['"`]/gi
  for (const rm2 of content.matchAll(decoRe)) {
    const routePath = rm2[1]!
    const name = routePath.replace(/[^\w/.-]/g, '').slice(0, 64) || 'route'
    symbols.push({
      kind: 'route',
      name,
      startLine: lineOf(content, rm2.index),
      endLine: null,
      exported: true,
    })
  }
  // Next.js App Router route.ts handlers
  if (/(?:^|\/)route\.(ts|js|tsx|jsx)$/.test(filePath.replace(/\\/g, '/'))) {
    const nextHandlers =
      /\bexport\s+(?:async\s+)?function\s+(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/g
    for (const rm3 of content.matchAll(nextHandlers)) {
      symbols.push({
        kind: 'route',
        name: `${rm3[1]} ${filePath.replace(/\\/g, '/')}`,
        startLine: lineOf(content, rm3.index),
        endLine: null,
        exported: true,
      })
    }
  }

  const fin = finalizeCalls(calls)
  return {
    filePath,
    symbols,
    callNames: fin.callNames,
    calls: fin.calls,
    importBindings,
    resolvedImports: new Map(),
  }
}

function extractPython(content: string, filePath: string): FileExtract {
  const symbols: RawSymbol[] = []
  const calls: CallSite[] = []
  const clean = stripNoise(content)
  const reFn = /^(?:async\s+)?def\s+(\w+)\s*\(/gm
  const reClass = /^class\s+(\w+)/gm
  for (const m of clean.matchAll(reFn)) {
    symbols.push({
      kind: 'function',
      name: m[1]!,
      startLine: lineOf(clean, m.index),
      endLine: null,
      exported: !m[1]!.startsWith('_'),
    })
  }
  for (const m2 of clean.matchAll(reClass)) {
    symbols.push({
      kind: 'class',
      name: m2[1]!,
      startLine: lineOf(clean, m2.index),
      endLine: null,
      exported: !m2[1]!.startsWith('_'),
    })
  }
  const callRe = /\b([A-Za-z_][\w]*)\s*\(/g
  for (const m3 of clean.matchAll(callRe)) {
    const name = m3[1]!
    if (/^(if|for|while|return|print|len|range|str|int|list|dict|set|super|self)$/.test(name))
      continue
    calls.push({ name, line: lineOf(clean, m3.index) })
  }
  const fin = finalizeCalls(calls)
  return {
    filePath,
    symbols,
    callNames: fin.callNames,
    calls: fin.calls,
    importBindings: new Map(),
    resolvedImports: new Map(),
  }
}

function extractGo(content: string, filePath: string): FileExtract {
  const symbols: RawSymbol[] = []
  const clean = stripNoise(content)
  const reFn = /^func\s+(?:\([^)]+\)\s+)?(\w+)\s*\(/gm
  const reType = /^type\s+(\w+)\s+(?:struct|interface)/gm
  for (const m of clean.matchAll(reFn)) {
    const name = m[1]!
    symbols.push({
      kind: 'function',
      name,
      startLine: lineOf(clean, m.index),
      endLine: null,
      exported: name[0] === name[0]!.toUpperCase(),
    })
  }
  for (const m2 of clean.matchAll(reType)) {
    symbols.push({
      kind: 'type',
      name: m2[1]!,
      startLine: lineOf(clean, m2.index),
      endLine: null,
      exported: m2[1]![0] === m2[1]![0]!.toUpperCase(),
    })
  }
  return {
    filePath,
    symbols,
    callNames: [],
    calls: [],
    importBindings: new Map(),
    resolvedImports: new Map(),
  }
}

function extractRust(content: string, filePath: string): FileExtract {
  const symbols: RawSymbol[] = []
  const clean = stripNoise(content)
  const reFn = /^(?:pub\s+)?(?:async\s+)?fn\s+(\w+)/gm
  const reStruct = /^(?:pub\s+)?struct\s+(\w+)/gm
  const reTrait = /^(?:pub\s+)?trait\s+(\w+)/gm
  const reEnum = /^(?:pub\s+)?enum\s+(\w+)/gm
  for (const [re, kind] of [
    [reFn, 'function'],
    [reStruct, 'class'],
    [reTrait, 'interface'],
    [reEnum, 'enum'],
  ] as const) {
    for (const m of clean.matchAll(re)) {
      symbols.push({
        kind: kind as SymbolKind,
        name: m[1]!,
        startLine: lineOf(clean, m.index),
        endLine: null,
        exported: /^pub\b/.test(m[0]!),
      })
    }
  }
  return {
    filePath,
    symbols,
    callNames: [],
    calls: [],
    importBindings: new Map(),
    resolvedImports: new Map(),
  }
}

function extractJava(content: string, filePath: string): FileExtract {
  const symbols: RawSymbol[] = []
  const clean = stripNoise(content)
  const reClass = /(?:public\s+|private\s+|protected\s+)?(?:abstract\s+|final\s+)?class\s+(\w+)/g
  const reIface = /(?:public\s+)?interface\s+(\w+)/g
  const reMethod =
    /(?:public|private|protected)\s+(?:static\s+)?(?:final\s+)?[\w.<>,[\]\s]+\s+(\w+)\s*\(/g
  for (const m of clean.matchAll(reClass)) {
    symbols.push({
      kind: 'class',
      name: m[1]!,
      startLine: lineOf(clean, m.index),
      endLine: null,
      exported: true,
    })
  }
  for (const m2 of clean.matchAll(reIface)) {
    symbols.push({
      kind: 'interface',
      name: m2[1]!,
      startLine: lineOf(clean, m2.index),
      endLine: null,
      exported: true,
    })
  }
  for (const m3 of clean.matchAll(reMethod)) {
    if (/^(if|for|while|switch|catch|return|new)$/.test(m3[1]!)) continue
    symbols.push({
      kind: 'method',
      name: m3[1]!,
      startLine: lineOf(clean, m3.index),
      endLine: null,
      exported: true,
    })
  }
  return {
    filePath,
    symbols,
    callNames: [],
    calls: [],
    importBindings: new Map(),
    resolvedImports: new Map(),
  }
}

export function extractFile(content: string, filePath: string): FileExtract {
  const ext = path.extname(filePath).toLowerCase()
  if (['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'].includes(ext)) {
    return extractTsJs(content, filePath)
  }
  if (ext === '.py') return extractPython(content, filePath)
  if (ext === '.go') return extractGo(content, filePath)
  if (ext === '.rs') return extractRust(content, filePath)
  if (ext === '.java') return extractJava(content, filePath)
  return emptyExtract(filePath)
}

// Import resolution

type TsPathMap = Array<{ pattern: string; targets: string[] }>

async function loadTsPathMap(projectPath: string): Promise<TsPathMap> {
  const map: TsPathMap = []
  for (const conf of ['tsconfig.json', 'jsconfig.json']) {
    try {
      const raw = await fs.readFile(path.join(projectPath, conf), 'utf-8')
      // Strip comments (tsconfig often has them)
      const json = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
      const parsed = JSON.parse(json) as {
        compilerOptions?: { paths?: Record<string, string[]>; baseUrl?: string }
      }
      const paths = parsed.compilerOptions?.paths
      const baseUrl = parsed.compilerOptions?.baseUrl ?? '.'
      if (!paths) continue
      for (const [pattern, targets] of Object.entries(paths)) {
        map.push({
          pattern,
          targets: targets.map((t) => path.posix.join(baseUrl.replace(/\\/g, '/'), t)),
        })
      }
      break
    } catch {
      /* try next */
    }
  }
  return map
}

function applyTsPath(specifier: string, tsPaths: TsPathMap): string[] {
  const out: string[] = []
  for (const { pattern, targets } of tsPaths) {
    if (pattern.endsWith('/*')) {
      const prefix = pattern.slice(0, -1) // keep trailing path start
      const pre = pattern.slice(0, -2)
      if (specifier === pre || specifier.startsWith(`${pre}/`)) {
        const rest = specifier.slice(pre.length).replace(/^\//, '')
        for (const t of targets) {
          const base = t.endsWith('/*') ? t.slice(0, -1) : t
          out.push(path.posix.join(base.replace(/\*$/, ''), rest).replace(/\\/g, '/'))
        }
      }
      void prefix
    } else if (specifier === pattern) {
      for (const t2 of targets) out.push(t2.replace(/\*$/, ''))
    }
  }
  return out
}

async function resolveSpecifierToFile(
  projectPath: string,
  fromFile: string,
  specifier: string,
  tsPaths: TsPathMap
): Promise<string | null> {
  const candidates: string[] = []

  if (specifier.startsWith('.')) {
    const fromDir = path.dirname(path.join(projectPath, fromFile))
    candidates.push(path.resolve(fromDir, specifier))
  } else if (specifier.startsWith('@/')) {
    candidates.push(path.join(projectPath, 'src', specifier.slice(2)))
    candidates.push(path.join(projectPath, specifier.slice(2)))
  } else {
    // tsconfig paths / bare alias
    for (const mapped of applyTsPath(specifier, tsPaths)) {
      candidates.push(path.join(projectPath, mapped))
    }
    // monorepo-ish packages/* fallback
    candidates.push(path.join(projectPath, 'packages', specifier))
    candidates.push(path.join(projectPath, 'src', specifier))
  }

  for (const base of candidates) {
    for (const ext of RESOLVE_EXTENSIONS) {
      const full = base + ext
      try {
        const st = await fs.stat(full)
        if (st.isFile()) {
          return path.relative(projectPath, full).replace(/\\/g, '/')
        }
      } catch {
        /* next */
      }
    }
    // directory index already covered by RESOLVE_EXTENSIONS entries like /index.ts
  }
  return null
}

async function resolveImportsForExtract(
  projectPath: string,
  ex: FileExtract,
  tsPaths: TsPathMap
): Promise<void> {
  for (const [local, spec] of ex.importBindings) {
    const resolved = await resolveSpecifierToFile(projectPath, ex.filePath, spec, tsPaths)
    if (resolved) ex.resolvedImports.set(local, resolved)
  }
}

// Graph build

interface BuiltGraph {
  symbols: CodeSymbol[]
  edges: CodeSymbolEdge[]
  fileCount: number
}

function matchFileToMod(file: string, mod: string): boolean {
  const norm = file.replace(/\\/g, '/')
  const m = mod.replace(/\\/g, '/').replace(/\.(ts|tsx|js|jsx|mjs|cjs)$/, '')
  return (
    norm === mod ||
    norm.replace(/\.(ts|tsx|js|jsx|mjs|cjs)$/, '') === m ||
    norm === `${m}.ts` ||
    norm === `${m}.tsx` ||
    norm === `${m}.js` ||
    norm === `${m}.jsx` ||
    norm === `${m}/index.ts` ||
    norm === `${m}/index.tsx` ||
    norm === `${m}/index.js`
  )
}

/** Enclosing callable for a call line: nearest prior function/method/class. */
function enclosingSymbol(fileSyms: CodeSymbol[], callLine: number): CodeSymbol | null {
  const callables = fileSyms.filter(
    (s) => s.kind === 'function' || s.kind === 'method' || s.kind === 'class'
  )
  return callables.reduce<CodeSymbol | null>(
    (best, symbol) =>
      symbol.startLine <= callLine && (!best || symbol.startLine > best.startLine) ? symbol : best,
    null
  )
}

function resolveCallTargets(
  callName: string,
  ex: FileExtract,
  fileSyms: CodeSymbol[],
  byName: Map<string, CodeSymbol[]>
): { targets: CodeSymbol[]; confidence: number } {
  // 1) same-file definition (not the call site itself)
  const local = fileSyms.filter((s) => s.name === callName)
  if (local.length === 1) return { targets: local, confidence: 0.95 }
  if (local.length > 1) {
    const exported = local.filter((s) => s.exported)
    if (exported.length === 1) return { targets: exported, confidence: 0.9 }
  }

  // 2) import binding → resolved file
  const resolvedFile = ex.resolvedImports.get(callName)
  if (resolvedFile) {
    const candidates = (byName.get(callName) ?? []).filter((s) =>
      matchFileToMod(s.file, resolvedFile)
    )
    if (candidates.length > 0) return { targets: candidates, confidence: 0.9 }
    // default import: use primary export of that file
    const fileSymsOf = [...byName.values()]
      .flat()
      .filter((s) => matchFileToMod(s.file, resolvedFile) && s.exported)
    const primary =
      fileSymsOf.find((s) => s.kind === 'function' || s.kind === 'class') ?? fileSymsOf[0]
    if (primary) return { targets: [primary], confidence: 0.65 }
  }

  // 3) unique project-wide name
  const all = byName.get(callName) ?? []
  if (all.length === 1) return { targets: all, confidence: 0.75 }
  if (all.length > 1) {
    const exported = all.filter((s) => s.exported)
    if (exported.length === 1) return { targets: exported, confidence: 0.7 }
  }

  return { targets: [], confidence: 0 }
}

function buildFromExtracts(extracts: FileExtract[]): BuiltGraph {
  const symbols: CodeSymbol[] = []
  const edges: CodeSymbolEdge[] = []
  const byName = new Map<string, CodeSymbol[]>()
  const byFile = new Map<string, CodeSymbol[]>()

  for (const ex of extracts) {
    const fileSyms: CodeSymbol[] = []
    for (const raw of ex.symbols) {
      const id = symbolId(ex.filePath, raw.kind, raw.name, raw.startLine)
      const sym: CodeSymbol = {
        id,
        file: ex.filePath,
        kind: raw.kind,
        name: raw.name,
        qname: qnameOf(ex.filePath, raw.name),
        startLine: raw.startLine,
        endLine: raw.endLine,
        exported: raw.exported,
      }
      symbols.push(sym)
      fileSyms.push(sym)
      const list = byName.get(raw.name) ?? []
      list.push(sym)
      byName.set(raw.name, list)
      edges.push({
        src: `file:${ex.filePath}`,
        dst: id,
        edgeType: 'DEFINES',
        confidence: 1,
      })
    }
    byFile.set(ex.filePath, fileSyms)
  }

  for (const ex2 of extracts) {
    const fileSyms = byFile.get(ex2.filePath) ?? []
    const seenCall = new Set<string>() // src|dst per file to limit fan-out

    for (const call of ex2.calls) {
      // Skip call that is the declaration line of a same-name symbol
      if (fileSyms.some((s) => s.name === call.name && s.startLine === call.line)) continue

      const { targets, confidence } = resolveCallTargets(call.name, ex2, fileSyms, byName)
      if (targets.length === 0) continue

      const enc = enclosingSymbol(fileSyms, call.line)
      const srcId = enc?.id ?? `file:${ex2.filePath}`

      for (const t of targets) {
        if (t.id === srcId) continue
        const key = `${srcId}|${t.id}`
        if (seenCall.has(key)) continue
        seenCall.add(key)
        edges.push({
          src: srcId,
          dst: t.id,
          edgeType: 'CALLS',
          confidence,
        })
      }
    }
  }

  const edgeKey = new Set<string>()
  const uniqEdges: CodeSymbolEdge[] = []
  for (const e3 of edges) {
    const k = `${e3.src}|${e3.dst}|${e3.edgeType}`
    if (edgeKey.has(k)) continue
    edgeKey.add(k)
    uniqEdges.push(e3)
  }

  return {
    symbols,
    edges: uniqEdges,
    fileCount: extracts.length,
  }
}

async function extractProject(projectPath: string, onlyFiles?: string[]): Promise<FileExtract[]> {
  const files =
    onlyFiles ?? (await walkDir(projectPath)).filter((f) => isSourceFile(f) && !f.includes('.d.ts'))
  const sourceFiles = files.filter((f) => isSourceFile(f) && !f.endsWith('.d.ts'))
  const tsPaths = await loadTsPathMap(projectPath)

  const extracts = await batchProcess(sourceFiles, 40, async (filePath) => {
    try {
      const content = await fs.readFile(path.join(projectPath, filePath), 'utf-8')
      const sliced = content.length > 400_000 ? content.slice(0, 400_000) : content
      return extractFile(sliced, filePath)
    } catch {
      return emptyExtract(filePath)
    }
  })

  // Resolve imports (bounded parallelism via batch)
  await batchProcess(extracts, 40, async (ex) => {
    await resolveImportsForExtract(projectPath, ex, tsPaths)
    return ex
  })

  return extracts
}

function persistGraph(projectId: string, graph: BuiltGraph): void {
  replaceCodeGraph(projectId, graph)

  const meta: SymbolGraphMeta = {
    symbolCount: graph.symbols.length,
    edgeCount: graph.edges.length,
    fileCount: graph.fileCount,
    builtAt: new Date().toISOString(),
  }
  prjctDb.setDoc(projectId, META_KEY, meta)
}

function patchGraph(
  projectId: string,
  extracts: FileExtract[],
  deletedFiles: string[]
): SymbolGraphMeta | null {
  const touched = new Set([...extracts.map((e) => e.filePath), ...deletedFiles])
  if (touched.size === 0) return loadMeta(projectId)

  const existing = listAllSymbols(projectId).filter((s) => !touched.has(s.file))
  // Merge extracts with a synthetic full extract set for call resolution:
  // build only from changed extracts, then re-link CALLS using existing+new names.
  const rebuilt = buildFromExtracts(extracts)

  prjctDb.transaction(projectId, (db) => {
    const delSym = db.prepare('DELETE FROM code_symbols WHERE file = ?')
    for (const file of touched) {
      db.prepare(
        `DELETE FROM code_symbol_edges WHERE src LIKE ? OR dst LIKE ? OR src = ? OR dst = ?`
      ).run(`${file}#%`, `${file}#%`, `file:${file}`, `file:${file}`)
      delSym.run(file)
    }

    const insSym = db.prepare(
      `INSERT INTO code_symbols (id, file, kind, name, qname, start_line, end_line, exported)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    const insEdge = db.prepare(
      `INSERT OR IGNORE INTO code_symbol_edges (src, dst, edge_type, confidence)
       VALUES (?, ?, ?, ?)`
    )
    for (const s of rebuilt.symbols) {
      insSym.run(s.id, s.file, s.kind, s.name, s.qname, s.startLine, s.endLine, s.exported ? 1 : 0)
    }

    const byName = new Map<string, CodeSymbol[]>()
    for (const s2 of [...existing, ...rebuilt.symbols]) {
      const list = byName.get(s2.name) ?? []
      list.push(s2)
      byName.set(s2.name, list)
    }
    const byFile = new Map<string, CodeSymbol[]>()
    for (const s3 of [...existing, ...rebuilt.symbols]) {
      if (!byFile.has(s3.file)) byFile.set(s3.file, [])
      byFile.get(s3.file)!.push(s3)
    }

    for (const ex of extracts) {
      const fileSyms = byFile.get(ex.filePath) ?? []
      for (const s4 of fileSyms.filter((x) => x.file === ex.filePath)) {
        insEdge.run(`file:${ex.filePath}`, s4.id, 'DEFINES', 1)
      }
      const seen = new Set<string>()
      for (const call of ex.calls) {
        if (fileSyms.some((s) => s.name === call.name && s.startLine === call.line)) continue
        const { targets, confidence } = resolveCallTargets(call.name, ex, fileSyms, byName)
        if (targets.length === 0) continue
        const enc = enclosingSymbol(fileSyms, call.line)
        const srcId = enc?.id ?? `file:${ex.filePath}`
        for (const t of targets) {
          if (t.id === srcId) continue
          const key = `${srcId}|${t.id}`
          if (seen.has(key)) continue
          seen.add(key)
          insEdge.run(srcId, t.id, 'CALLS', confidence)
        }
      }
    }
  })

  const counts = prjctDb.get<{ sc: number; ec: number; fc: number }>(
    projectId,
    `SELECT
       (SELECT COUNT(*) FROM code_symbols) AS sc,
       (SELECT COUNT(*) FROM code_symbol_edges) AS ec,
       (SELECT COUNT(DISTINCT file) FROM code_symbols) AS fc`
  )
  const meta: SymbolGraphMeta = {
    symbolCount: counts?.sc ?? 0,
    edgeCount: counts?.ec ?? 0,
    fileCount: counts?.fc ?? 0,
    builtAt: new Date().toISOString(),
  }
  prjctDb.setDoc(projectId, META_KEY, meta)
  return meta
}

// Public API

export async function indexSymbols(
  projectPath: string,
  projectId: string
): Promise<SymbolGraphMeta> {
  const extracts = await extractProject(projectPath)
  const graph = buildFromExtracts(extracts)
  persistGraph(projectId, graph)
  return {
    symbolCount: graph.symbols.length,
    edgeCount: graph.edges.length,
    fileCount: graph.fileCount,
    builtAt: new Date().toISOString(),
  }
}

export async function updateSymbols(
  projectPath: string,
  projectId: string,
  changedFiles: string[],
  deletedFiles: string[] = []
): Promise<SymbolGraphMeta> {
  if (!hasSymbolIndex(projectId)) {
    return indexSymbols(projectPath, projectId)
  }
  const sourceChanged = changedFiles.filter((f) => isSourceFile(f) && !f.endsWith('.d.ts'))
  const sourceDeleted = deletedFiles.filter((f) => isSourceFile(f))
  if (sourceChanged.length === 0 && sourceDeleted.length === 0) {
    return (
      loadMeta(projectId) ?? {
        symbolCount: 0,
        edgeCount: 0,
        fileCount: 0,
        builtAt: new Date().toISOString(),
      }
    )
  }
  const extracts = await extractProject(projectPath, sourceChanged)
  return (
    patchGraph(projectId, extracts, sourceDeleted) ?? {
      symbolCount: 0,
      edgeCount: 0,
      fileCount: 0,
      builtAt: new Date().toISOString(),
    }
  )
}

export function hasSymbolIndex(projectId: string): boolean {
  try {
    const row = prjctDb.get<{ n: number }>(projectId, 'SELECT COUNT(*) AS n FROM code_symbols')
    return (row?.n ?? 0) > 0
  } catch {
    return false
  }
}

export function loadMeta(projectId: string): SymbolGraphMeta | null {
  return prjctDb.getDoc<SymbolGraphMeta>(projectId, META_KEY)
}

function rowToSymbol(r: {
  id: string
  file: string
  kind: string
  name: string
  qname: string | null
  start_line: number
  end_line: number | null
  exported: number
}): CodeSymbol {
  return {
    id: r.id,
    file: r.file,
    kind: r.kind as SymbolKind,
    name: r.name,
    qname: r.qname ?? qnameOf(r.file, r.name),
    startLine: r.start_line,
    endLine: r.end_line,
    exported: r.exported === 1,
  }
}

export function listAllSymbols(projectId: string): CodeSymbol[] {
  try {
    const rows = prjctDb.query<{
      id: string
      file: string
      kind: string
      name: string
      qname: string | null
      start_line: number
      end_line: number | null
      exported: number
    }>(projectId, 'SELECT * FROM code_symbols ORDER BY file, start_line')
    return rows.map(rowToSymbol)
  } catch {
    return []
  }
}

export function searchSymbols(
  projectId: string,
  pattern: string,
  opts: { limit?: number; kind?: SymbolKind } = {}
): CodeSymbol[] {
  const limit = opts.limit ?? 30
  const like = `%${pattern.replace(/[%_]/g, '')}%`
  try {
    if (opts.kind) {
      return prjctDb
        .query<{
          id: string
          file: string
          kind: string
          name: string
          qname: string | null
          start_line: number
          end_line: number | null
          exported: number
        }>(
          projectId,
          `SELECT * FROM code_symbols
           WHERE name LIKE ? COLLATE NOCASE AND kind = ?
           ORDER BY exported DESC, name
           LIMIT ?`,
          like,
          opts.kind,
          limit
        )
        .map(rowToSymbol)
    }
    return prjctDb
      .query<{
        id: string
        file: string
        kind: string
        name: string
        qname: string | null
        start_line: number
        end_line: number | null
        exported: number
      }>(
        projectId,
        `SELECT * FROM code_symbols
         WHERE name LIKE ? COLLATE NOCASE OR qname LIKE ? COLLATE NOCASE
         ORDER BY exported DESC, name
         LIMIT ?`,
        like,
        like,
        limit
      )
      .map(rowToSymbol)
  } catch {
    return []
  }
}

/** Query indexer: files that define symbols matching query tokens. */
export function scoreFilesFromQuery(projectId: string, query: string, topN = 20): SymbolScore[] {
  const tokens = query
    .split(/[^A-Za-z0-9_]+/)
    .flatMap((t) => t.replace(/([a-z])([A-Z])/g, '$1 $2').split(/\s+/))
    .map((t) => t.trim())
    .filter((t) => t.length > 2)

  if (tokens.length === 0 || !hasSymbolIndex(projectId)) return []

  const fileScores = new Map<string, { score: number; names: Set<string> }>()

  for (const token of tokens) {
    const hits = searchSymbols(projectId, token, { limit: 40 })
    for (const h of hits) {
      const exact = h.name.toLowerCase() === token.toLowerCase() ? 1 : 0.55
      const exp = h.exported ? 1.15 : 1
      const kindBoost = h.kind === 'function' || h.kind === 'class' || h.kind === 'route' ? 1.1 : 1
      const add = exact * exp * kindBoost
      const cur = fileScores.get(h.file) ?? { score: 0, names: new Set<string>() }
      cur.score += add
      cur.names.add(h.name)
      fileScores.set(h.file, cur)
    }
  }

  return Array.from(fileScores.entries())
    .map(([p, v]) => ({
      path: p,
      score: v.score,
      matchedNames: [...v.names],
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topN)
}

export function symbolsInFile(projectId: string, filePath: string): CodeSymbol[] {
  try {
    return prjctDb
      .query<{
        id: string
        file: string
        kind: string
        name: string
        qname: string | null
        start_line: number
        end_line: number | null
        exported: number
      }>(projectId, 'SELECT * FROM code_symbols WHERE file = ? ORDER BY start_line', filePath)
      .map(rowToSymbol)
  } catch {
    return []
  }
}

function loadEdges(
  projectId: string,
  edgeType: SymbolEdgeType = 'CALLS'
): { forward: Map<string, string[]>; reverse: Map<string, string[]> } {
  const forward = new Map<string, string[]>()
  const reverse = new Map<string, string[]>()
  try {
    const rows = prjctDb.query<{ src: string; dst: string }>(
      projectId,
      'SELECT src, dst FROM code_symbol_edges WHERE edge_type = ?',
      edgeType
    )
    for (const r of rows) {
      if (!forward.has(r.src)) forward.set(r.src, [])
      forward.get(r.src)!.push(r.dst)
      if (!reverse.has(r.dst)) reverse.set(r.dst, [])
      reverse.get(r.dst)!.push(r.src)
    }
  } catch {
    /* empty */
  }
  return { forward, reverse }
}

function symbolById(projectId: string, id: string): CodeSymbol | null {
  try {
    const r = prjctDb.get<{
      id: string
      file: string
      kind: string
      name: string
      qname: string | null
      start_line: number
      end_line: number | null
      exported: number
    }>(projectId, 'SELECT * FROM code_symbols WHERE id = ?', id)
    return r ? rowToSymbol(r) : null
  } catch {
    return null
  }
}

/**
 * BFS call-path trace for a symbol name.
 * Prefers symbol→symbol CALLS; still expands residual file: nodes.
 */
export function tracePath(
  projectId: string,
  functionName: string,
  opts: { direction?: 'inbound' | 'outbound' | 'both'; depth?: number } = {}
): TraceResult | null {
  const direction = opts.direction ?? 'both'
  const maxDepth = Math.min(Math.max(opts.depth ?? 3, 1), 5)
  const roots = searchSymbols(projectId, functionName, { limit: 10 }).filter(
    (s) => s.name.toLowerCase() === functionName.toLowerCase()
  )
  const rootList = roots.length > 0 ? roots : searchSymbols(projectId, functionName, { limit: 5 })
  if (rootList.length === 0) return null

  const { forward, reverse } = loadEdges(projectId, 'CALLS')
  const inbound: TraceHop[] = []
  const outbound: TraceHop[] = []

  const bfs = (startIds: string[], adj: Map<string, string[]>, out: TraceHop[], maxD: number) => {
    const visited = new Set<string>(startIds)
    const queue: Array<{ id: string; depth: number }> = startIds.map((id) => ({
      id,
      depth: 0,
    }))
    for (const { id, depth } of queue) {
      if (depth >= maxD) continue
      for (const next of adj.get(id) ?? []) {
        if (visited.has(next)) continue
        visited.add(next)
        if (next.startsWith('file:')) {
          const filePath = next.slice('file:'.length)
          const fileSyms = symbolsInFile(projectId, filePath)
          const primary =
            fileSyms.find((s) => s.exported && (s.kind === 'function' || s.kind === 'class')) ??
            fileSyms.find((s) => s.kind === 'function' || s.kind === 'class') ??
            fileSyms[0]
          if (primary && !visited.has(primary.id)) {
            visited.add(primary.id)
            out.push({ symbol: primary, depth: depth + 1, via: 'CALLS' })
            queue.push({ id: primary.id, depth: depth + 1 })
          }
          queue.push({ id: next, depth: depth + 1 })
          continue
        }
        const sym = symbolById(projectId, next)
        if (!sym) continue
        out.push({ symbol: sym, depth: depth + 1, via: 'CALLS' })
        queue.push({ id: next, depth: depth + 1 })
      }
    }
  }

  const startIds = rootList.map((r) => r.id)
  if (direction === 'inbound' || direction === 'both') {
    bfs(startIds, reverse, inbound, maxDepth)
  }
  if (direction === 'outbound' || direction === 'both') {
    bfs(startIds, forward, outbound, maxDepth)
  }

  return { root: rootList, inbound, outbound }
}

/** Fan-in (callers) count for symbols in a file. */
export function fileFanIn(projectId: string, filePath: string): number {
  const syms = symbolsInFile(projectId, filePath)
  if (syms.length === 0) return 0
  const { reverse } = loadEdges(projectId, 'CALLS')
  const callers = new Set<string>()
  for (const s of syms) {
    for (const c of reverse.get(s.id) ?? []) {
      callers.add(c)
    }
  }
  return callers.size
}

/**
 * Fan-in for every target file in one indexed aggregate.
 *
 * Architecture summaries used to call fileFanIn() for up to 400 files. Each
 * call reloaded the complete CALLS edge set, turning a single report into
 * hundreds of full-table reads. The grouped query preserves the exact
 * semantics (distinct caller symbol/file ids across all symbols in a target
 * file) while scanning the edge table once.
 */
export function fileFanInByFile(projectId: string): Map<string, number> {
  try {
    const rows = prjctDb.query<{ file: string; caller_count: number }>(
      projectId,
      `SELECT target.file AS file, COUNT(DISTINCT edge.src) AS caller_count
       FROM code_symbol_edges AS edge
       JOIN code_symbols AS target ON target.id = edge.dst
       WHERE edge.edge_type = 'CALLS'
       GROUP BY target.file`
    )
    return new Map(rows.map((row) => [row.file, row.caller_count]))
  } catch {
    return new Map()
  }
}

/** Files that call into symbols defined in seed files (call-graph expand). */
export function filesCallingInto(projectId: string, seedFiles: string[], maxDepth = 2): string[] {
  const seedSet = new Set(seedFiles)
  const { reverse } = loadEdges(projectId, 'CALLS')
  const seedSymIds = new Set<string>()
  for (const f of seedFiles) {
    for (const s of symbolsInFile(projectId, f)) seedSymIds.add(s.id)
  }
  const files = new Set<string>()
  const visited = new Set<string>(seedSymIds)
  Array.from({ length: maxDepth }).reduce<string[]>(
    (frontier) => {
      const next: string[] = []
      for (const id of frontier) {
        for (const caller of reverse.get(id) ?? []) {
          if (visited.has(caller)) continue
          visited.add(caller)
          next.push(caller)
          if (caller.startsWith('file:')) {
            const fp = caller.slice('file:'.length)
            if (!seedSet.has(fp)) files.add(fp)
          } else {
            const sym = symbolById(projectId, caller)
            if (sym && !seedSet.has(sym.file)) files.add(sym.file)
          }
        }
      }
      return next
    },
    [...seedSymIds]
  )
  return [...files]
}

export type { SymbolEdgeType }
