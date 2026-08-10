/**
 * Optional codebase-memory-mcp (CBM) bridge.
 *
 * prjct owns harness + authored memory + native symbol graph. When the
 * CBM binary is on PATH, we surface it as a polyglot upgrade path without
 * making it a hard dependency.
 */

import path from 'node:path'
import { execFileAsync } from '../utils/exec'

export interface CbmStatus {
  available: boolean
  path: string | null
  version: string | null
  note: string
}

async function which(cmd: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      process.platform === 'win32' ? 'where' : 'which',
      [cmd],
      { timeout: 2000 }
    )
    const first = stdout.trim().split(/\r?\n/)[0]
    return first || null
  } catch {
    return null
  }
}

export async function detectCbm(): Promise<CbmStatus> {
  const bin = await which('codebase-memory-mcp')
  if (!bin) {
    return {
      available: false,
      path: null,
      version: null,
      note: 'CBM not on PATH. Native prjct symbol graph is active. Install: https://github.com/DeusData/codebase-memory-mcp',
    }
  }
  const version = await execFileAsync(bin, ['--version'], { timeout: 3000 })
    .catch(() => execFileAsync(bin, ['version'], { timeout: 3000 }))
    .then(({ stdout, stderr }) => (stdout || stderr).trim().split(/\r?\n/)[0] || null)
    .catch(() => 'unknown')
  return {
    available: true,
    path: bin,
    version,
    note: 'CBM available. prjct native graph remains default; use CBM for polyglot Hybrid-LSP depth when needed.',
  }
}

export function formatCbmStatus(s: CbmStatus): string {
  if (!s.available) return `CBM: not installed — ${s.note}`
  return `CBM: ${s.path}${s.version ? ` (${s.version})` : ''} — ${s.note}`
}

export interface CbmCliResult {
  ok: boolean
  stdout: string
  stderr: string
  error?: string
}

/**
 * Optional execute bridge: run a CBM CLI tool if installed.
 * Never a hard dependency — fails soft when missing.
 *
 * Example: cbmCli('search_graph', { project: 'x', name_pattern: '.*Handler.*' })
 */
export async function cbmCli(
  tool: string,
  args: Record<string, unknown>,
  opts: { timeoutMs?: number } = {}
): Promise<CbmCliResult> {
  const bin = await which('codebase-memory-mcp')
  if (!bin) {
    return {
      ok: false,
      stdout: '',
      stderr: '',
      error: 'codebase-memory-mcp not on PATH',
    }
  }
  try {
    const { stdout, stderr } = await execFileAsync(bin, ['cli', tool, JSON.stringify(args)], {
      timeout: opts.timeoutMs ?? 30_000,
      maxBuffer: 4 * 1024 * 1024,
    })
    return { ok: true, stdout: stdout.trim(), stderr: stderr.trim() }
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; message?: string }
    return {
      ok: false,
      stdout: (err.stdout ?? '').toString(),
      stderr: (err.stderr ?? '').toString(),
      error: err.message ?? String(e),
    }
  }
}

/**
 * Resolve CBM project name for a repo path (list_projects → match by path).
 * Returns null if CBM missing or project not indexed.
 */
export async function cbmProjectName(projectPath: string): Promise<string | null> {
  const abs = path.resolve(projectPath)
  const listed = await cbmCli('list_projects', {})
  if (!listed.ok || !listed.stdout) return null
  try {
    const data = JSON.parse(listed.stdout) as unknown
    const projects = extractProjectsList(data)
    for (const p of projects) {
      const pPath = typeof p.path === 'string' ? path.resolve(p.path) : ''
      const pName =
        typeof p.name === 'string' ? p.name : typeof p.project === 'string' ? p.project : null
      if (pName && pPath && (pPath === abs || abs.startsWith(pPath + path.sep))) return pName
      if (pName && typeof p.repo_path === 'string' && path.resolve(p.repo_path) === abs)
        return pName
    }
    // Single-project install: use the only name
    if (projects.length === 1) {
      const only = projects[0]!
      return (
        (typeof only.name === 'string' && only.name) ||
        (typeof only.project === 'string' && only.project) ||
        null
      )
    }
  } catch {
    /* non-JSON — ignore */
  }
  return null
}

function extractProjectsList(data: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(data)) return data as Array<Record<string, unknown>>
  if (data && typeof data === 'object') {
    const o = data as Record<string, unknown>
    if (Array.isArray(o.projects)) return o.projects as Array<Record<string, unknown>>
    if (Array.isArray(o.results)) return o.results as Array<Record<string, unknown>>
  }
  return []
}

export type CbmFallbackKind = 'trace' | 'architecture' | 'search'

/**
 * Best-effort polyglot fallback when native graph is empty/weak.
 * Never throws; returns null if CBM unavailable or call fails.
 */
export async function cbmFallback(
  kind: CbmFallbackKind,
  projectPath: string,
  opts: { name?: string; pattern?: string } = {}
): Promise<{ text: string; source: 'cbm' } | null> {
  const status = await detectCbm()
  if (!status.available) return null

  const project = await cbmProjectName(projectPath)
  // If unknown, still try tools that accept repo_path / omit project
  const base: Record<string, unknown> = project ? { project } : {}

  if (kind === 'trace' && !opts.name) return null
  const [tool, args]: [string, Record<string, unknown>] =
    kind === 'trace'
      ? ['trace_path', { ...base, function_name: opts.name, direction: 'both' }]
      : kind === 'architecture'
        ? ['get_architecture', { ...base }]
        : [
            'search_graph',
            {
              ...base,
              name_pattern: opts.pattern ? `.*${escapeRegex(opts.pattern)}.*` : '.*',
              limit: 30,
            },
          ]

  const r = await cbmCli(tool, args, { timeoutMs: 20_000 })
  if (!r.ok) return null
  const body = r.stdout || r.stderr
  if (!body || body.length < 2) return null
  const header =
    kind === 'trace'
      ? `## Trace (CBM fallback): \`${opts.name}\``
      : kind === 'architecture'
        ? '## Architecture (CBM fallback)'
        : `## Symbols (CBM fallback)${opts.pattern ? `: \`${opts.pattern}\`` : ''}`
  return {
    source: 'cbm',
    text: [
      header,
      '',
      '_Native prjct graph had no/weak hit — results from codebase-memory-mcp (Hybrid LSP / polyglot)._',
      '',
      '```',
      body.slice(0, 12_000),
      body.length > 12_000 ? '…(truncated)…' : '',
      '```',
    ]
      .filter(Boolean)
      .join('\n'),
  }
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
