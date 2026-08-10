/**
 * Deterministic project identity.
 *
 * A project's cloud id must be the SAME on every machine that works the same
 * repository — otherwise linking the repo from two machines creates duplicate
 * cloud projects. We derive a stable UUIDv5 from the normalized git remote
 * (`<provider>:<org/repo>`), so the id is reproducible from the repo alone and
 * never depends on a random value committed to `.prjct/prjct.config.json`.
 *
 * Repos with NO remote (purely local) can't be deduplicated across machines,
 * so the caller falls back to a random UUID for those.
 */

import crypto from 'node:crypto'
import { execFileAsync } from '../../utils/exec'
import { parseRemote } from './project-meta'

// Fixed namespace for prjct project ids (a constant random UUID). Changing this
// would re-key every derived id, so it must stay stable forever.
const PRJCT_NAMESPACE = '6f9b2c1a-3d4e-5f60-8a7b-1c2d3e4f5a6b'

/** RFC 4122 v5 (SHA-1, name-based) UUID — deterministic for a given name. */
export function uuidv5(name: string, namespace = PRJCT_NAMESPACE): string {
  const ns = Buffer.from(namespace.replace(/-/g, ''), 'hex')
  const hash = crypto.createHash('sha1').update(ns).update(name, 'utf8').digest()
  const b = hash.subarray(0, 16)
  b[6] = (b[6] & 0x0f) | 0x50 // version 5
  b[8] = (b[8] & 0x3f) | 0x80 // RFC 4122 variant
  const h = b.toString('hex')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`
}

/** The stable, machine-independent key for a repo, or null if it has no remote. */
export async function repoKey(projectPath: string): Promise<string | null> {
  const url = await execFileAsync('git', ['remote', 'get-url', 'origin'], { cwd: projectPath })
    .then(({ stdout }) => stdout.trim() || null)
    .catch(() => null)
  if (!url) return null
  const { provider, repoSlug } = parseRemote(url)
  if (!provider || !repoSlug) return null
  return `${provider}:${repoSlug}`.toLowerCase()
}

/**
 * The deterministic cloud project id for a repo, or null when the repo has no
 * usable remote (caller should fall back to a random id). The same repo yields
 * the same id on every machine.
 */
export async function deriveProjectId(projectPath: string): Promise<string | null> {
  const key = await repoKey(projectPath)
  return key ? uuidv5(key) : null
}
