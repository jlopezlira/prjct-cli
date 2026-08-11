/**
 * PreToolUse hook (matcher: Bash, if: git commit). Surfaces anti-pattern
 * memories tagged to files touched by the upcoming commit so Claude can
 * decide whether to abort or proceed. Nudge, never block.
 *
 * The hook only emits when:
 *   1. There's a project config.
 *   2. `git diff --cached --name-only` returns at least one file.
 *   3. Project memory has `anti-pattern` (or `gotcha`) entries whose
 *      tags mention a touched file path fragment.
 *
 * Otherwise emits `{}` — no harness, no noise.
 */

import { execSync } from 'node:child_process'
import configManager from '../infrastructure/config-manager'
import type { MemoryEntry } from '../memory/entries'
import { formatMemoryMd } from '../memory/format'
import { projectMemory } from '../memory/project-memory'
import { type HookIo, runHook } from './_runner'
import { safeTruncate } from './_shared'

const MAX_CHARS = 1200
const MAX_ENTRIES = 3

export interface CommitHookInput {
  tool_name?: string
  tool_input?: { command?: string }
}

function stagedFiles(projectPath: string): string[] {
  try {
    return execSync('git diff --cached --name-only', {
      cwd: projectPath,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    })
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
  } catch {
    return []
  }
}

/**
 * Find memory entries whose content OR tag values mention any file path
 * fragment. We match on path basename plus top directory — gives signal
 * without needing heavy text search.
 */
function pathFragments(files: string[]): string[] {
  const frags = new Set<string>()
  for (const f of files) {
    const parts = f.split('/').filter(Boolean)
    for (const p of parts) {
      // Drop extensions for substring match stability.
      const bare = p.replace(/\.[^.]+$/, '').toLowerCase()
      if (bare.length >= 3) frags.add(bare)
    }
  }
  return [...frags]
}

function mentionsFragment(entry: MemoryEntry, fragments: string[]): boolean {
  const content = entry.content.toLowerCase()
  if (fragments.some((f) => content.includes(f))) return true
  for (const v of Object.values(entry.tags)) {
    const lower = v.toLowerCase()
    if (fragments.some((f) => lower.includes(f))) return true
  }
  return false
}

export async function buildPreCommitContext(projectPath: string): Promise<string | null> {
  const config = await configManager.readConfig(projectPath)
  if (!config?.projectId) return null

  const files = stagedFiles(projectPath)
  if (files.length === 0) return null

  const fragments = pathFragments(files)
  if (fragments.length === 0) return null

  const candidates = (() => {
    try {
      return projectMemory.recall(config.projectId, {
        types: ['anti-pattern', 'gotcha'],
        limit: 50,
      })
    } catch {
      return null
    }
  })()
  if (!candidates) return null

  const relevant = candidates.filter((e) => mentionsFragment(e, fragments)).slice(0, MAX_ENTRIES)
  if (relevant.length === 0) return null

  const lines = ['# prjct: heads-up for this commit', '']
  lines.push(
    `${relevant.length} anti-pattern/gotcha entr${relevant.length === 1 ? 'y' : 'ies'} match the staged files.`
  )
  lines.push('')
  lines.push(formatMemoryMd(relevant))
  lines.push('')
  lines.push('> Nudge, not block. Proceed if you think it still applies.')
  const body = lines.join('\n')
  return safeTruncate(body, MAX_CHARS)
}

export function runPreCommitHook(projectPath: string = process.cwd(), io?: HookIo): Promise<void> {
  return runHook<CommitHookInput>(
    {
      event: 'PreToolUse',
      projectPath,
      build: async (input, p) => {
        // Only fire for `git commit` invocations — the matcher in
        // settings.json already narrows to Bash, but the `if:` clause
        // is pattern-based and the host may pass us other Bash calls.
        if (!isCommitInput(input)) return null
        return buildPreCommitContext(p)
      },
    },
    io
  )
}

export function isCommitInput(input: CommitHookInput): boolean {
  return /\bgit\s+commit\b/.test(input.tool_input?.command ?? '')
}
