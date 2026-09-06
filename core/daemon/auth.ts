/**
 * Daemon request authentication.
 *
 * Node cannot read SO_PEERCRED, and a Windows named pipe has no file mode
 * at all, so socket permissions alone cannot prove who connected. The
 * daemon issues a random token into its owner-only run dir at startup;
 * a peer that can present it has read the same user's private files,
 * which is the property peer credentials would have established.
 *
 * Every request except the liveness ping carries the token. A request
 * without a valid one is answered with `retry` + `unauthenticated`: nothing
 * executed, and every client already knows to run the command directly.
 */

import { randomBytes, timingSafeEqual } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { DaemonResponse } from '../types/daemon'
import { DAEMON_PATHS } from './protocol'

const TOKEN_BYTES = 32
const TOKEN_SHAPE = /^[0-9a-f]{64}$/

/** Commands served without a token: liveness only, no state, no side effects. */
const UNAUTHENTICATED_COMMANDS: ReadonlySet<string> = new Set(['__ping'])

/**
 * Mint a fresh token and publish it atomically (temp file + rename) with
 * owner-only mode, so a reader never sees a partial token and a peer that
 * cannot read the run dir never sees any.
 */
export function issueDaemonToken(tokenPath: string = DAEMON_PATHS.token()): string {
  const token = randomBytes(TOKEN_BYTES).toString('hex')
  const dir = path.dirname(tokenPath)
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  const tmp = path.join(dir, `.daemon.token.${process.pid}.tmp`)
  fs.writeFileSync(tmp, `${token}\n`, { encoding: 'utf-8', mode: 0o600 })
  fs.chmodSync(tmp, 0o600)
  fs.renameSync(tmp, tokenPath)
  return token
}

/** The published token, or null when it is missing or malformed. */
export function readDaemonToken(tokenPath: string = DAEMON_PATHS.token()): string | null {
  try {
    const token = fs.readFileSync(tokenPath, 'utf-8').trim()
    return TOKEN_SHAPE.test(token) ? token : null
  } catch {
    return null
  }
}

export function removeDaemonToken(tokenPath: string = DAEMON_PATHS.token()): void {
  try {
    fs.unlinkSync(tokenPath)
  } catch {
    // already gone — nothing to revoke
  }
}

/** Constant-time comparison of the presented token against the issued one. */
export function requestAuthorized(
  request: { command: string; auth?: unknown },
  issued: string | null
): boolean {
  if (UNAUTHENTICATED_COMMANDS.has(request.command)) return true
  if (!issued || typeof request.auth !== 'string') return false
  const presented = Buffer.from(request.auth, 'utf-8')
  const expected = Buffer.from(issued, 'utf-8')
  return presented.length === expected.length && timingSafeEqual(presented, expected)
}

/** The refusal every client already handles: nothing ran, run it directly. */
export function unauthenticatedResponse(id: string): DaemonResponse {
  return {
    id,
    success: false,
    exitCode: 1,
    retry: true,
    unauthenticated: true,
    stderr: 'daemon request carried no valid token — running directly',
  }
}
