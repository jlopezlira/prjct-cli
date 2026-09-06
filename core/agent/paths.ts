/**
 * Path safety for owned-agent tools — stay inside project root.
 */

import fs from 'node:fs'
import path from 'node:path'
import { resolveInsideProject } from '../utils/path-jail'

const DENY_BASENAME =
  /^(?:\.env(?:\..+)?|.*\.(?:pem|key|p12|pfx)|id_rsa|id_ed25519|credentials\.json|auth\.json)$/i

const DENY_SEGMENT = /(?:^|\/)(?:\.ssh|\.gnupg|\.aws|\.config\/gcloud)(?:\/|$)/i

/**
 * True for paths that look like credential material by name — `.env*`,
 * key files, and anything under `.ssh`/`.aws`-style directories. Shared by
 * the owned agent's path jail and the ship commit's staging filter.
 */
export function isSecretLikePath(candidate: string): boolean {
  const posix = candidate.split(path.sep).join('/')
  return DENY_BASENAME.test(path.posix.basename(posix)) || DENY_SEGMENT.test(posix)
}

export class PathDeniedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PathDeniedError'
  }
}

/** Resolve user path under root; throws if escapes or hits deny list. */
export function resolveSafePath(root: string, userPath: string): string {
  if (!userPath || typeof userPath !== 'string') {
    throw new PathDeniedError('path is required')
  }
  // Canonical on both sides: a symlink inside root that points outside it
  // must not pass as an in-root path.
  const candidate = resolveInsideProject(root, userPath)
  if (candidate === null) {
    throw new PathDeniedError(`path escapes project root: ${userPath}`)
  }

  const base = path.basename(candidate)
  if (DENY_BASENAME.test(base)) {
    throw new PathDeniedError(`path blocked (secret-like name): ${base}`)
  }
  const posix = candidate.split(path.sep).join('/')
  if (DENY_SEGMENT.test(posix)) {
    throw new PathDeniedError(`path blocked (sensitive directory): ${userPath}`)
  }

  return candidate
}

export function ensureParentDir(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
}

export function fileExists(p: string): boolean {
  try {
    fs.accessSync(p)
    return true
  } catch {
    return false
  }
}
