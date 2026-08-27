/**
 * Source-first edit gate.
 *
 * Prompt guidance can be ignored. This ledger records concrete inspection of
 * a repo file (Read/PostToolUse or `prjct guard <file>`) and lets PreToolUse
 * Edit|Write prove that inspection happened before mutation.
 */

import { createHash } from 'node:crypto'
import { realpathSync } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { symbolsInFile } from '../domain/symbol-graph'
import { scanForSecrets } from '../utils/secret-scanner'
import { rankLikelyFiles } from './file-cue'
import { formatRelevantProjectPatterns, relevantProjectPatterns } from './project-pattern-context'
import { gateDelivery } from './session-context-cache'

const INSPECTION_MARKER = 'source-inspected:v1'
// Some hosts do not expose a stable session id. Their inspection stamp is
// durable but intentionally short-lived, so a separate long-running agent
// cannot inherit stale permission indefinitely.
const SESSIONLESS_INSPECTION_TTL_MS = 30 * 60 * 1000
const SOURCE_SHAPE_READ_BYTES = 16 * 1024
const SOURCE_SHAPE_CHARS = 1200

/**
 * Resolve filesystem aliases for both existing files and not-yet-created edit
 * targets. macOS exposes the same temp tree as `/var/...` and
 * `/private/var/...`; lexical comparison alone treated an in-repo file as
 * external and silently bypassed the gate.
 */
function canonicalPath(value: string): string {
  const resolved = path.resolve(value)
  try {
    return realpathSync.native(resolved)
  } catch {
    const suffix: string[] = []
    let cursor = resolved
    for (;;) {
      const parent = path.dirname(cursor)
      if (parent === cursor) return resolved
      suffix.unshift(path.basename(cursor))
      cursor = parent
      try {
        return path.join(realpathSync.native(cursor), ...suffix)
      } catch {
        // Walk to the nearest existing ancestor, preserving the missing tail.
      }
    }
  }
}

export function repoRelativeFile(projectPath: string, filePath: string): string | null {
  const root = canonicalPath(projectPath)
  const absolute = canonicalPath(
    path.isAbsolute(filePath) ? filePath : path.resolve(projectPath, filePath)
  )
  const relative = path.relative(root, absolute)
  if (
    !relative ||
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    return null
  }
  return relative.split(path.sep).join('/')
}

function markerFor(file: string): string {
  return `${INSPECTION_MARKER}:${file}`
}

export function sourceInspectionToken(input: {
  projectId: string
  projectPath: string
  sessionId?: string
  filePath: string
}): string | null {
  if (!input.sessionId) return null
  const file = repoRelativeFile(input.projectPath, input.filePath)
  if (!file) return null
  return createHash('sha256')
    .update(`${input.projectId}\0${path.resolve(input.projectPath)}\0${input.sessionId}\0${file}`)
    .digest('hex')
    .slice(0, 24)
}

async function stampInspection(input: {
  projectId: string
  projectPath: string
  sessionId?: string
  file: string
}): Promise<void> {
  await gateDelivery({
    projectId: input.projectId,
    projectPath: input.projectPath,
    sessionId: input.sessionId,
    surface: 'source-inspection',
    key: input.file,
    content: markerFor(input.file),
    full: true,
    noSession: { mode: 'static', ttlMs: SESSIONLESS_INSPECTION_TTL_MS },
  })
}

export async function markSourceInspected(input: {
  projectId: string
  projectPath: string
  sessionId?: string
  filePath: string
}): Promise<boolean> {
  const file = repoRelativeFile(input.projectPath, input.filePath)
  if (!file) return false
  await stampInspection({ ...input, file })
  return true
}

export async function markSourceInspectionToken(input: {
  projectId: string
  projectPath: string
  token: string
  filePath: string
}): Promise<boolean> {
  if (!/^[a-f0-9]{24}$/.test(input.token)) return false
  const file = repoRelativeFile(input.projectPath, input.filePath)
  if (!file) return false
  await stampInspection({
    projectId: input.projectId,
    projectPath: input.projectPath,
    sessionId: `source-token:${input.token}`,
    file,
  })
  return true
}

async function hasInspectionStamp(input: {
  projectId: string
  projectPath: string
  sessionId?: string
  file: string
}): Promise<boolean> {
  const gate = await gateDelivery({
    projectId: input.projectId,
    projectPath: input.projectPath,
    sessionId: input.sessionId,
    surface: 'source-inspection',
    key: input.file,
    content: markerFor(input.file),
    probe: true,
    noSession: { mode: 'static', ttlMs: SESSIONLESS_INSPECTION_TTL_MS },
  })
  return gate.suppressed
}

export async function wasSourceInspected(input: {
  projectId: string
  projectPath: string
  sessionId?: string
  filePath: string
}): Promise<boolean> {
  const file = repoRelativeFile(input.projectPath, input.filePath)
  if (!file) return true
  const direct = await hasInspectionStamp({ ...input, file })
  if (direct) return true
  const token = sourceInspectionToken(input)
  if (!token) return false
  return hasInspectionStamp({
    projectId: input.projectId,
    projectPath: input.projectPath,
    sessionId: `source-token:${token}`,
    file,
  })
}

export function sourceFirstDenyMessage(
  projectId: string,
  projectPath: string,
  filePath: string,
  token?: string | null,
  options: { includeSyncedPatterns?: boolean } = {}
): string | null {
  const file = repoRelativeFile(projectPath, filePath)
  if (!file) return null
  // Navigation and pattern evidence make the denial useful, but they are not
  // prerequisites for enforcement. A stale/cold auxiliary index must never
  // turn an uninspected edit into an implicit allow.
  const symbols = (() => {
    try {
      return symbolsInFile(projectId, file)
        .slice(0, 6)
        .map((symbol) => `${symbol.kind} ${symbol.name}`)
    } catch {
      return []
    }
  })()
  const related = (() => {
    try {
      return rankLikelyFiles(projectId, file, 4)
        .map((hit) => hit.path)
        .filter((candidate) => candidate !== file)
        .slice(0, 3)
    } catch {
      return []
    }
  })()
  const syncedPatterns =
    options.includeSyncedPatterns === false
      ? null
      : (() => {
          try {
            return formatRelevantProjectPatterns(
              relevantProjectPatterns(projectId, file, {
                targetFiles: [file],
                // The edit denial needs one canonical MATCH plus the most relevant
                // AVOID; additional patterns belong in the prompt/work surfaces.
                maxPatterns: 1,
                maxConventions: 1,
                maxAntiPatterns: 1,
              }),
              { maxChars: 420, header: 'Synced house patterns for this file:' }
            )
          } catch {
            return null
          }
        })()
  return [
    '# prjct: source-first gate — edit blocked',
    `No source inspection is recorded for \`${file}\` in this session.`,
    symbols.length > 0 ? `Existing symbols: ${symbols.join(', ')}.` : null,
    related.length > 0
      ? `Related implementations: ${related.map((p) => `\`${p}\``).join(', ')}.`
      : null,
    syncedPatterns,
    token
      ? `Read the existing implementation or run \`PRJCT_SOURCE_INSPECTION=${token} prjct guard "${file}" --md\`, reuse its abstractions/patterns, then retry the edit.`
      : `Read the existing implementation or run \`prjct guard "${file}" --md\`, reuse its abstractions/patterns, then retry the edit.`,
  ]
    .filter(Boolean)
    .join('\n')
}

/**
 * Bounded actual-source evidence for the shell-first `prjct guard` handshake.
 * Shows imports/declarations (or a short prefix when the language is unknown),
 * never a whole file, and withholds the excerpt if secret scanning fires.
 */
export async function buildSourceInspectionBrief(
  projectId: string,
  projectPath: string,
  filePath: string
): Promise<string | null> {
  const file = repoRelativeFile(projectPath, filePath)
  if (!file) return null
  const syncedPatterns = formatRelevantProjectPatterns(
    relevantProjectPatterns(projectId, file, {
      targetFiles: [file],
      maxPatterns: 2,
      maxConventions: 1,
      maxAntiPatterns: 1,
    }),
    { maxChars: 420, header: '## Synced house patterns for this file' }
  )
  const absolute = path.join(projectPath, file)
  const source = await (async () => {
    try {
      const handle = await fs.open(absolute, 'r')
      try {
        const buffer = Buffer.alloc(SOURCE_SHAPE_READ_BYTES)
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
        return buffer.toString('utf8', 0, bytesRead)
      } finally {
        await handle.close()
      }
    } catch {
      return null
    }
  })()
  if (!source) return syncedPatterns

  const nonEmpty = source
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0)
  const structural = nonEmpty.filter((line) =>
    /^\s*(?:import\b|export\b|class\b|interface\b|type\b|function\b|async\s+function\b|def\b|struct\b|enum\b|protocol\b|extension\b|func\b|public\b|private\b|protected\b)/.test(
      line
    )
  )
  const picked = (structural.length > 0 ? structural : nonEmpty).slice(0, 14)
  const excerpt = picked.join('\n').slice(0, SOURCE_SHAPE_CHARS)
  const symbols = symbolsInFile(projectId, file)
    .slice(0, 8)
    .map((symbol) => `${symbol.kind} ${symbol.name}`)
  if (!excerpt && symbols.length === 0) return syncedPatterns
  if (scanForSecrets(excerpt).length > 0) {
    return [
      `## Source inspection — \`${file}\``,
      '',
      '_Excerpt withheld because credential-like content was detected._',
      symbols.length > 0 ? `Indexed shape: ${symbols.join(', ')}.` : null,
      syncedPatterns,
    ]
      .filter(Boolean)
      .join('\n')
  }
  const language = path.extname(file).slice(1)
  return [
    `## Source inspection — \`${file}\``,
    '',
    symbols.length > 0 ? `Indexed shape: ${symbols.join(', ')}.` : null,
    'Bounded imports/declarations from the actual file:',
    `\`\`\`${language}`,
    excerpt,
    '```',
    syncedPatterns,
  ]
    .filter(Boolean)
    .join('\n')
}
