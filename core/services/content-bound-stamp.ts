/**
 * Content-bound judgment stamp — path + blob hash, tree aggregate.
 *
 * Residual vs gentle-ai v2.0 (mem_9396): approve/ship bind to the *content*
 * that was reviewed. Post-approve edits → treeHash drift → re-approve required.
 *
 * Pure core + thin FS/git helpers. No new CLI verb.
 */

import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { GitInfraError, gitStdout } from '../utils/exec'
import { resolveReviewPayloadBase, resolveReviewPayloadPaths } from './delivery-geometry'

/** Missing / deleted path sentinel — still contributes to treeHash. */
export const BLOB_MISSING = 'missing' as const

export const CONTENT_BOUND_VERSION = 2 as const

/** Cap path stamps so ledger docs stay small (large monorepo diffs). */
export const CONTENT_BOUND_MAX_PATHS = 200

export interface ContentBoundPathStamp {
  path: string
  /** sha256 hex of file bytes, or {@link BLOB_MISSING}. */
  blobHash: string
}

export interface ContentBoundStamp {
  /** v1 hashed bytes only; v2 also binds file kind/mode, symlink target, and gitlink SHA. */
  version: 1 | typeof CONTENT_BOUND_VERSION
  /** sha256 of sorted `path\\0blobHash` lines — SSOT for match/drift. */
  treeHash: string
  pathCount: number
  /** First N path stamps (diagnostic); treeHash covers full set. */
  paths: ContentBoundPathStamp[]
  stampedAt: string
  headSha?: string
  baseSha?: string
  /** Stamp was created from the authoritative ship payload manifest. */
  payloadBound?: boolean
  /** True when path hashes include Git-relevant identity instead of bytes alone. */
  identityBound?: boolean
}

export interface ContentBoundDriftVerdict {
  blocked: boolean
  reason: 'match' | 'drift' | 'no-stamp' | 'unverified' | 'override' | 'empty-scope'
  message: string
  stampedTreeHash?: string
  currentTreeHash?: string
}

function sha256Hex(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex')
}

/** Blob hash of raw file bytes (or missing sentinel). */
export function hashBlobContent(content: string | Buffer | null): string {
  if (content === null) return BLOB_MISSING
  return sha256Hex(typeof content === 'string' ? Buffer.from(content, 'utf8') : content)
}

/**
 * Deterministic tree hash from path→blob pairs.
 * Sort by path; empty set hashes empty string (stable).
 */
export function buildTreeHash(entries: ReadonlyArray<{ path: string; blobHash: string }>): string {
  const lines = [...entries]
    .map((e) => ({ path: normalizeStampPath(e.path), blobHash: e.blobHash }))
    .filter((e) => e.path.length > 0)
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map((e) => `${e.path}\0${e.blobHash}`)
  return sha256Hex(lines.join('\n'))
}

export function normalizeStampPath(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\//, '').trim()
}

/**
 * Pure stamp from in-memory path contents (tests + callers that already read FS).
 */
export function stampFromContents(
  entries: ReadonlyArray<{ path: string; content: string | Buffer | null }>,
  opts: {
    stampedAt: string
    headSha?: string
    baseSha?: string
    maxPaths?: number
    payloadBound?: boolean
  }
): ContentBoundStamp {
  const max = opts.maxPaths ?? CONTENT_BOUND_MAX_PATHS
  const full: ContentBoundPathStamp[] = entries
    .map((e) => ({
      path: normalizeStampPath(e.path),
      blobHash: hashBlobContent(e.content),
    }))
    .filter((e) => e.path.length > 0)
  // Dedup by path (last write wins)
  const byPath = new Map<string, string>()
  for (const e of full) byPath.set(e.path, e.blobHash)
  const all = [...byPath.entries()]
    .map(([p, blobHash]) => ({ path: p, blobHash }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  const treeHash = buildTreeHash(all)
  return {
    version: CONTENT_BOUND_VERSION,
    treeHash,
    pathCount: all.length,
    paths: all.slice(0, max),
    stampedAt: opts.stampedAt,
    headSha: opts.headSha,
    baseSha: opts.baseSha,
    payloadBound: opts.payloadBound,
    identityBound: false,
  }
}

/**
 * Drift check — pure. `currentTreeHash === null` means verify could not run
 * (no git / IO error): do not hard-block (unverified advisory).
 */
export function contentBoundDriftVerdict(input: {
  stamp: ContentBoundStamp | null | undefined
  currentTreeHash: string | null
  /** When true, drift hard-blocks ship (code-strict / quality required). */
  hard: boolean
  override?: boolean
}): ContentBoundDriftVerdict {
  if (input.override) {
    return { blocked: false, reason: 'override', message: '' }
  }
  if (!input.stamp?.treeHash) {
    // A1 (gentle-ai v2.2 steal): under hard/code-strict, approved authority
    // without a content stamp is fail-closed — not silent pass.
    if (input.hard) {
      return {
        blocked: true,
        reason: 'no-stamp',
        message:
          'Content-bound stamp missing: re-run `prjct judgment approve` so ship binds to the reviewed tree. ' +
          'Override only with consent: `prjct ship --no-judgment-gate`.',
      }
    }
    return { blocked: false, reason: 'no-stamp', message: '' }
  }
  if (input.stamp.pathCount === 0) {
    return {
      blocked: false,
      reason: 'empty-scope',
      message: 'Content-bound stamp empty (no scoped paths) — advisory only.',
      stampedTreeHash: input.stamp.treeHash,
    }
  }
  if (input.currentTreeHash === null) {
    return {
      blocked: false,
      reason: 'unverified',
      message: `⚖️  Content-bound stamp ${shortHash(input.stamp.treeHash)} not re-verified (IO).`,
      stampedTreeHash: input.stamp.treeHash,
    }
  }
  if (input.currentTreeHash === input.stamp.treeHash) {
    return {
      blocked: false,
      reason: 'match',
      message: `⚖️  Content-bound match tree=${shortHash(input.stamp.treeHash)} (${input.stamp.pathCount} paths)`,
      stampedTreeHash: input.stamp.treeHash,
      currentTreeHash: input.currentTreeHash,
    }
  }
  const msg =
    `Content-bound drift: approved tree=${shortHash(input.stamp.treeHash)} ` +
    `now=${shortHash(input.currentTreeHash)} (${input.stamp.pathCount} paths). ` +
    `Re-run \`prjct judgment approve\` after re-review. ` +
    `Override only with consent: \`prjct ship --no-judgment-gate\`.`
  return {
    blocked: input.hard,
    reason: 'drift',
    message: input.hard ? msg : `⚖️  ${msg}`,
    stampedTreeHash: input.stamp.treeHash,
    currentTreeHash: input.currentTreeHash,
  }
}

export function shortHash(h: string): string {
  return h.slice(0, 12)
}

/**
 * Git for stamp path resolution. Typed exit → null (domain: no paths / no
 * HEAD). Infra (timeout/spawn) throws GitInfraError — never collapse to null,
 * or ship would treat an unevaluable tree as "unverified → pass".
 */
async function safeGit(projectPath: string, args: string[]): Promise<string | null> {
  return gitStdout(projectPath, args, { timeoutMs: 5_000 })
}

/**
 * Resolve paths to stamp: prefer frozen scopePaths; else git working/committed names.
 */
export async function resolveStampPaths(
  projectPath: string,
  scopePaths?: readonly string[] | null
): Promise<string[]> {
  if (scopePaths && scopePaths.length > 0) {
    return [
      ...new Set(
        scopePaths.map(normalizeStampPath).filter((p) => p.length > 0 && !p.endsWith('/'))
      ),
    ]
  }
  return resolveReviewPayloadPaths(projectPath)
}

function hashIdentity(kind: string, mode: string, value: string | Buffer): string {
  return sha256Hex(
    Buffer.concat([
      Buffer.from(`${kind}\0${mode}\0`, 'utf8'),
      typeof value === 'string' ? Buffer.from(value, 'utf8') : value,
    ])
  )
}

async function hashProjectPath(projectPath: string, relativePath: string): Promise<string> {
  const root = path.resolve(projectPath)
  const abs = path.resolve(root, relativePath)
  if (abs === root || !abs.startsWith(`${root}${path.sep}`)) return BLOB_MISSING
  try {
    const stat = await fs.lstat(abs)
    if (stat.isSymbolicLink()) {
      return hashIdentity('symlink', '120000', await fs.readlink(abs))
    }
    if (stat.isDirectory()) {
      const staged = await safeGit(projectPath, ['ls-files', '--stage', '--', relativePath])
      if (!staged?.startsWith('160000 ')) return hashIdentity('directory', '040000', '')
      const checkedOutSha = await safeGit(abs, ['rev-parse', 'HEAD'])
      return hashIdentity('gitlink', '160000', checkedOutSha ?? BLOB_MISSING)
    }
    if (!stat.isFile()) return hashIdentity('special', '000000', '')
    const mode = (stat.mode & 0o111) !== 0 ? '100755' : '100644'
    return hashIdentity('blob', mode, await fs.readFile(abs))
  } catch (error) {
    if (error instanceof GitInfraError) throw error
    return BLOB_MISSING
  }
}

/** Stamp live workspace paths (async FS). */
export async function stampProjectPaths(
  projectPath: string,
  paths: readonly string[],
  opts: { stampedAt: string; headSha?: string; baseSha?: string; payloadBound?: boolean }
): Promise<ContentBoundStamp> {
  const entries: ContentBoundPathStamp[] = []
  for (const p of paths) {
    const norm = normalizeStampPath(p)
    if (!norm) continue
    entries.push({ path: norm, blobHash: await hashProjectPath(projectPath, norm) })
  }
  const byPath = new Map(entries.map((entry) => [entry.path, entry.blobHash]))
  const all = [...byPath.entries()]
    .map(([entryPath, blobHash]) => ({ path: entryPath, blobHash }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  return {
    version: CONTENT_BOUND_VERSION,
    treeHash: buildTreeHash(all),
    pathCount: all.length,
    paths: all.slice(0, CONTENT_BOUND_MAX_PATHS),
    stampedAt: opts.stampedAt,
    headSha: opts.headSha,
    baseSha: opts.baseSha,
    payloadBound: opts.payloadBound,
    identityBound: true,
  }
}

/** Full approve-time stamp: resolve paths + hash + optional HEAD. */
export async function stampForApprove(
  projectPath: string,
  scopePaths: readonly string[] | undefined,
  stampedAt: string
): Promise<ContentBoundStamp> {
  const paths = await resolveStampPaths(projectPath, scopePaths)
  const [headSha, baseSha] = await Promise.all([
    safeGit(projectPath, ['rev-parse', 'HEAD']),
    resolveReviewPayloadBase(projectPath),
  ])
  return stampProjectPaths(projectPath, paths, {
    stampedAt,
    headSha: headSha ?? undefined,
    baseSha: baseSha ?? undefined,
    payloadBound: true,
  })
}

/** Recompute treeHash for drift check at ship. */
export async function currentTreeHashForStamp(
  projectPath: string,
  stamp: ContentBoundStamp
): Promise<string | null> {
  try {
    const [currentHead, currentBase] = await Promise.all([
      safeGit(projectPath, ['rev-parse', 'HEAD']),
      resolveReviewPayloadBase(projectPath),
    ])
    if (
      (stamp.headSha && currentHead !== stamp.headSha) ||
      (stamp.baseSha && currentBase !== stamp.baseSha)
    ) {
      return sha256Hex(
        `identity-drift\0${currentHead ?? BLOB_MISSING}\0${currentBase ?? BLOB_MISSING}`
      )
    }
    // Prefer paths recorded on stamp; fall back to re-resolve if empty
    const paths = stamp.payloadBound
      ? await resolveReviewPayloadPaths(projectPath)
      : stamp.paths.length > 0
        ? stamp.paths.map((p) => p.path)
        : await resolveStampPaths(projectPath, null)
    // If pathCount > paths.length we only stamped a sample — still hash the sample
    // consistently (same set as approve). Full tree uses pathCount === paths.length when under cap.
    const next = await stampProjectPaths(projectPath, paths, {
      stampedAt: stamp.stampedAt,
      headSha: stamp.headSha,
      baseSha: stamp.baseSha,
    })
    return next.treeHash
  } catch (err) {
    // IO / parse failures → null (unverified advisory). Git infra must
    // propagate so code-strict ship can refuse instead of fail-open.
    if (err instanceof GitInfraError) throw err
    return null
  }
}
