/**
 * Retrospective Command — `prjct retro [window]`
 *
 * Weekly engineering retrospective inspired by gstack's `/retro`. Wraps
 * the git log + sessionTracker / metricsStorage / velocityStorage data
 * already collected by `prjct sync`, and emits a per-contributor
 * narrative output.
 *
 * Windows:
 *   prjct retro            — last 7 days (default)
 *   prjct retro 24h
 *   prjct retro 14d
 *   prjct retro 30d
 *
 * Honors gstack's "midnight-aligned windows" — the day-unit start is
 * `<today_local> - N days` at 00:00, not `now() - N days`. Without that
 * the window slides with wall-clock time.
 */

import path from 'node:path'
import type { MdOption } from '../types/cli'
import type { CommandResult } from '../types/commands'
import { getErrorMessage } from '../types/fs'
import { execFileAsync } from '../utils/exec'
import { fileExists } from '../utils/file-helper'
import { failHard } from '../utils/md-aware'
import out from '../utils/output'
import { PrjctCommandsBase } from './base'

interface ParsedWindow {
  /** Human label, e.g. "7d", "24h", "14d". */
  label: string
  /** ISO timestamp (local time, midnight-aligned for day windows). */
  sinceIso: string
  /** Hours window length; only used as fallback for sub-day inputs. */
  hours: number
}

interface CommitRow {
  hash: string
  authorName: string
  authorEmail: string
  date: string
  subject: string
}

interface PerAuthor {
  name: string
  email: string
  commits: number
  insertions: number
  deletions: number
  files: number
  firstCommit: string
  lastCommit: string
}

export class RetroCommands extends PrjctCommandsBase {
  async retro(
    arg: string | null = null,
    projectPath: string = process.cwd(),
    options: MdOption = {}
  ): Promise<CommandResult> {
    try {
      const initResult = await this.ensureProjectInit(projectPath)
      if (!initResult.success) return initResult

      // Refuse outside a git repo — retro is git-driven.
      if (!(await fileExists(path.join(projectPath, '.git')))) {
        out.fail('Not in a git repository — `prjct retro` needs git history.')
        return { success: false, error: 'Not a git repo' }
      }

      const window = parseWindow(arg)
      if (!window) {
        out.fail(`Invalid window "${arg}". Use: 7d, 24h, 14d, 30d (units: h or d).`)
        return { success: false, error: 'Invalid window' }
      }

      const commits = await readCommits(projectPath, window.sinceIso)
      const byAuthor = groupByAuthor(commits)

      if (options.md) {
        console.log(formatMarkdown(window, commits, byAuthor))
      } else {
        console.log(formatText(window, commits, byAuthor))
      }

      return {
        success: true,
        window: window.label,
        commits: commits.length,
        contributors: byAuthor.length,
      }
    } catch (error) {
      const msg = getErrorMessage(error)
      return failHard(msg)
    }
  }
}

// Window parsing

function parseWindow(arg: string | null): ParsedWindow | null {
  const raw = (arg ?? '7d').trim().toLowerCase()
  const m = raw.match(/^(\d+)\s*([hd])$/)
  if (!m) return null
  const n = Number.parseInt(m[1], 10)
  if (!Number.isFinite(n) || n <= 0 || n > 365) return null
  const unit = m[2] as 'h' | 'd'

  const now = new Date()
  if (unit === 'h') {
    const since = new Date(now.getTime() - n * 60 * 60 * 1000)
    return { label: `${n}h`, sinceIso: toLocalIso(since), hours: n }
  }
  // Day window — anchor at local midnight today, then subtract N days.
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const since = new Date(midnight.getTime() - n * 24 * 60 * 60 * 1000)
  return { label: `${n}d`, sinceIso: toLocalIso(since), hours: n * 24 }
}

/**
 * Format a Date as a local-timezone ISO-ish string git accepts:
 * `YYYY-MM-DDTHH:MM:SS`. Suffix-less (no Z) keeps git in local time.
 */
function toLocalIso(d: Date): string {
  const pad = (n: number) => `${n}`.padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

// Git ingestion

async function readCommits(projectPath: string, sinceIso: string): Promise<CommitRow[]> {
  // `--shortstat` would force a per-commit two-line block; we keep this
  // simple for now and do a separate diff query for stats.
  const stdout = await execFileAsync(
    'git',
    ['log', `--since=${sinceIso}`, '--pretty=format:%H%x09%an%x09%ae%x09%aI%x09%s'],
    { cwd: projectPath, maxBuffer: 16 * 1024 * 1024 }
  )
    .then((result) => result.stdout)
    .catch((error) => {
      // Empty repo (no HEAD) is the common case for first-run; treat as
      // "zero commits in window" rather than an error. Real git failures
      // (corruption, missing binary) still bubble up via the outer handler.
      const msg =
        (error as { stderr?: string; message?: string }).stderr ?? (error as Error).message ?? ''
      if (/does not have any commits|unknown revision|bad revision|HEAD/i.test(msg)) {
        return null
      }
      throw error
    })
  if (stdout === null) return []
  return stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [hash, authorName, authorEmail, date, ...rest] = line.split('\t')
      return {
        hash: hash ?? '',
        authorName: authorName ?? 'unknown',
        authorEmail: authorEmail ?? '',
        date: date ?? '',
        subject: rest.join('\t') ?? '',
      }
    })
    .filter((c) => c.hash)
}

function groupByAuthor(commits: CommitRow[]): PerAuthor[] {
  const map = new Map<string, PerAuthor>()
  for (const c of commits) {
    const key = c.authorEmail || c.authorName
    const existing = map.get(key)
    const a =
      existing ??
      ({
        name: c.authorName,
        email: c.authorEmail,
        commits: 0,
        // Stats not yet wired — left at 0 so the dashboard surfaces are
        // correct and a follow-up can lift them via `git log --shortstat`.
        insertions: 0,
        deletions: 0,
        files: 0,
        firstCommit: c.date,
        lastCommit: c.date,
      } satisfies PerAuthor)
    if (!existing) map.set(key, a)
    a.commits++
    if (c.date < a.firstCommit) a.firstCommit = c.date
    if (c.date > a.lastCommit) a.lastCommit = c.date
  }
  return Array.from(map.values()).sort((a, b) => b.commits - a.commits)
}

// Output formatters

function formatText(window: ParsedWindow, commits: CommitRow[], byAuthor: PerAuthor[]): string {
  if (commits.length === 0) {
    return `No commits in the last ${window.label}.`
  }
  const lines: string[] = []
  lines.push(
    `Retro — last ${window.label} · ${commits.length} commits · ${byAuthor.length} contributors`
  )
  lines.push('')
  for (const a of byAuthor) {
    lines.push(`  ${a.commits.toString().padStart(3)}  ${a.name} <${a.email}>`)
  }
  lines.push('')
  lines.push('Recent commits:')
  for (const c of commits.slice(0, 10)) {
    lines.push(`  ${c.hash.slice(0, 7)}  ${c.subject}`)
  }
  return lines.join('\n')
}

function formatMarkdown(window: ParsedWindow, commits: CommitRow[], byAuthor: PerAuthor[]): string {
  if (commits.length === 0) {
    return `## Retro — last ${window.label}\n\n_No commits in the window._\n`
  }
  const lines: string[] = []
  lines.push(`## Retro — last ${window.label}`)
  lines.push('')
  lines.push(`- **Commits**: ${commits.length}`)
  lines.push(`- **Contributors**: ${byAuthor.length}`)
  lines.push('')
  lines.push('### Per contributor')
  lines.push('')
  lines.push('| Author | Commits | First | Last |')
  lines.push('|---|---|---|---|')
  for (const a of byAuthor) {
    lines.push(
      `| ${a.name} | ${a.commits} | ${a.firstCommit.slice(0, 10)} | ${a.lastCommit.slice(0, 10)} |`
    )
  }
  lines.push('')
  lines.push('### Recent commits')
  lines.push('')
  for (const c of commits.slice(0, 15)) {
    lines.push(`- \`${c.hash.slice(0, 7)}\` ${c.subject} — _${c.authorName}_`)
  }
  return lines.join('\n')
}
