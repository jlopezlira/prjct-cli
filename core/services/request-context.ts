/**
 * Per-request caller context for the daemon.
 *
 * The daemon's own env is frozen at spawn time (client.ts passes
 * `env: process.env` once), so anything session-scoped MUST travel on the
 * wire per request — never be read from the daemon's process env. The
 * client resolves the caller's identity (it inherits the agent's env) and
 * sends it as `DaemonRequest.callerSession`; dispatch wraps command
 * execution in `runWithCallerSession` so any depth of the command stack
 * can read it via `currentCallerSession()` without parameter drilling.
 *
 * In the non-daemon path (PRJCT_NO_DAEMON / direct CLI) the store is simply
 * never entered and callers fall back to their own env resolution.
 */

import { AsyncLocalStorage } from 'node:async_hooks'

export interface CallerSession {
  sessionId?: string
  agent?: string
  identity?: string
}

const store = new AsyncLocalStorage<CallerSession>()

export function runWithCallerSession<T>(session: CallerSession, fn: () => T): T {
  return store.run(session, fn)
}

export function currentCallerSession(): CallerSession | undefined {
  return store.getStore()
}
