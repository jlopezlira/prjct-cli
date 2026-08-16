/**
 * Kimi Code CLI session transcript resolution.
 *
 * Kimi's Stop hook payload carries no `transcript_path` (Claude-only field).
 * The on-disk layout (verified against live `~/.kimi-code/sessions/`):
 *
 *   sessions/<wd_<workspace>_<hash>>/session_<uuid>/agents/<agent>/wire.jsonl
 *
 * `wire.jsonl` is the session's event log; the main agent's file holds the
 * user-facing turn usage (`{"type":"usage.record","model":…,"usage":{…}}`
 * lines). Given the payload's `session_id`, we locate the main agent's wire
 * under the matching `session_<id>/` directory, across every workspace dir.
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import { resolveUserPath } from '../infrastructure/user-home'
import { fileExists } from './file-helper'

export function getKimiSessionsRoot(): string {
  if (process.env.PRJCT_TEST_MODE === '1') {
    return path.join(resolveUserPath('.prjct-tests'), 'kimi-code', 'sessions')
  }
  return resolveUserPath('.kimi-code', 'sessions')
}

/**
 * Resolve the main agent's wire.jsonl for a Kimi session id. The payload's
 * `session_id` may (`session_abc`) or may not (`abc`) carry the directory's
 * `session_` prefix — both shapes are tried. Returns undefined when the
 * session (or its wire file) can't be found; callers stay fail-soft.
 */
export async function resolveKimiTranscriptPath(
  sessionId: string,
  sessionsRoot = getKimiSessionsRoot()
): Promise<string | undefined> {
  // Sanitize against path traversal — session_id comes from the host payload.
  const safeId = sessionId.replace(/[^a-zA-Z0-9_-]/g, '')
  if (!safeId) return undefined
  const dirNames = safeId.startsWith('session_') ? [safeId] : [safeId, `session_${safeId}`]

  const workspaces = await fs
    .readdir(sessionsRoot, { withFileTypes: true })
    .catch(() => [] as import('node:fs').Dirent[])
  for (const wd of workspaces) {
    if (!wd.isDirectory()) continue
    for (const dirName of dirNames) {
      const candidate = path.join(sessionsRoot, wd.name, dirName, 'agents', 'main', 'wire.jsonl')
      if (await fileExists(candidate)) return candidate
    }
  }
  return undefined
}
