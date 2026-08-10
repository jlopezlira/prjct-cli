/**
 * `prjct team` — turn this repo into a prjct-shared project.
 *
 * What it does (v1):
 *   1. Writes `.prjct/team.json` with `{required, minVersion}`. Tracked
 *      in git so teammates pick up the same expectations.
 *   2. Ensures `.claude/CLAUDE.md` (per-project) has a "prjct context"
 *      section pointing at `prjct sync`. If the file exists, the section
 *      is upserted between markers; otherwise the file is created.
 *   3. Stages both files for the next commit. Does NOT commit — the
 *      user controls when to ship the change.
 *
 * What it deliberately does NOT do (v1):
 *   - Install a pre-commit hook in the repo. Doing that requires a
 *     framework choice (husky, lefthook, simple-git-hooks) and is too
 *     opinionated for a first cut. The `required` flag is documentary
 *     today; an enforcement layer can read it later.
 *   - Touch `.gitignore` or any other repo config. Surface area must
 *     stay small.
 *
 * Anti-harness contract (mem_899): no automatic git commits, no
 * background pushes, no LLM-mediated decisions. A user-invoked command
 * with deterministic file writes only.
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import configManager from '../infrastructure/config-manager'
import { projectMemory } from '../memory/project-memory'
import {
  serializeCanonical,
  type TeamEnrollment,
  teamEnrollmentStorage,
} from '../storage/team-enrollment-storage'
import type { CommandResult } from '../types/commands'
import { getErrorMessage } from '../types/fs'
import { execAsync } from '../utils/exec'
import { writeFileAtomic } from '../utils/file-helper'
import { failHard, failWith } from '../utils/md-aware'
import { mdOutput, mdSection } from '../utils/md-formatter'
import out from '../utils/output'
import { VERSION } from '../utils/version'
import { PrjctCommandsBase } from './base'

const CLAUDE_MD_START = '<!-- prjct-team:start - DO NOT REMOVE THIS MARKER -->'
const CLAUDE_MD_END = '<!-- prjct-team:end - DO NOT REMOVE THIS MARKER -->'

interface TeamOptions {
  md?: boolean
  required?: boolean
  minVersion?: string
  /** Install .githooks/pre-commit + set core.hooksPath. Default: false. */
  enforce?: boolean
}

interface TeamConfig {
  required: boolean
  minVersion: string
  enrolledAt: string
}

/**
 * Render the enrollment as `.prjct/team.json` mirror content. The
 * pre-commit hook (PRE_COMMIT_HOOK_BODY) does a string grep against
 * this file, so the human-readable indented form is preferred.
 */
function renderTeamMirror(enrollment: TeamEnrollment): string {
  // Strip enrolledBy=null from the on-disk shape — older readers (and
  // the pre-commit hook's grep) only need {required, minVersion,
  // enrolledAt}. Keep enrolledBy in the DB but skip it from the mirror
  // when absent.
  const mirror: Record<string, unknown> = {
    required: enrollment.required,
    minVersion: enrollment.minVersion,
    enrolledAt: enrollment.enrolledAt,
  }
  if (enrollment.enrolledBy !== null) mirror.enrolledBy = enrollment.enrolledBy
  return `${JSON.stringify(mirror, null, 2)}\n`
}

export class TeamCommands extends PrjctCommandsBase {
  async team(
    input: string | null = null,
    projectPath: string = process.cwd(),
    options: TeamOptions = {}
  ): Promise<CommandResult> {
    // Subverb dispatch. `prjct team check` runs the drift detector.
    if (input === 'check') {
      return this.check(projectPath, options)
    }

    try {
      const teamConfig: TeamEnrollment = {
        required: options.required === true,
        minVersion: options.minVersion ?? VERSION ?? '0.0.0',
        enrolledAt: new Date().toISOString(),
        enrolledBy: null,
      }

      const teamPath = path.join(projectPath, '.prjct', 'team.json')
      const claudeMdPath = path.join(projectPath, '.claude', 'CLAUDE.md')

      // 1. Resolve projectId and write to SQLite (authoritative).
      const initResult = await this.ensureProjectInit(projectPath)
      if (!initResult.success) return initResult
      const projectId = await configManager.getProjectId(projectPath)
      if (!projectId) {
        return failHard('No prjct project. Run `prjct init` first.', options)
      }
      teamEnrollmentStorage.set(projectId, teamConfig)

      // 2. Regenerate .prjct/team.json from DB as a derived mirror. Atomic
      // tmp+rename — the pre-commit hook must never read a half-written
      // file. On mirror failure: log + inbox capture; DB stays ahead.
      try {
        await writeFileAtomic(teamPath, renderTeamMirror(teamConfig))
      } catch (mirrorError) {
        const msg = getErrorMessage(mirrorError)
        await projectMemory
          .remember(projectPath, {
            type: 'inbox',
            content: `team.json mirror write failed: ${msg}`,
            tags: { 'mirror-drift': '1' },
            provenance: 'declared',
          })
          .catch(() => {})
        // Fall through — the DB row is authoritative; user can heal via
        // `prjct team check` later.
      }

      // 3. Upsert .claude/CLAUDE.md (per-project)
      await fs.mkdir(path.dirname(claudeMdPath), { recursive: true })
      const block = teamClaudeMdBlock(teamConfig)
      const existing = await fs.readFile(claudeMdPath, 'utf-8').catch(() => '')
      const next = upsertBetweenMarkers(existing, block, CLAUDE_MD_START, CLAUDE_MD_END)
      await fs.writeFile(claudeMdPath, next, 'utf-8')

      // 4. Stage both files. Don't fail the command if git isn't
      // present or the user is outside a repo — print a hint instead.
      const stagedPaths = [teamPath, claudeMdPath]
      const staged = await (async () => {
        try {
          await execAsync('git rev-parse --show-toplevel', { cwd: projectPath })

          // 4a. Optional: install pre-commit hook that blocks commits
          // when team.json says required:true and prjct isn't on PATH.
          // Lives at .githooks/pre-commit (committed) and we point
          // core.hooksPath at it for THIS clone. Teammates run the same
          // command to wire their own clone.
          const hookPath =
            options.enforce === true ? path.join(projectPath, '.githooks', 'pre-commit') : null
          if (options.enforce === true) {
            if (!hookPath) return false
            await fs.mkdir(path.dirname(hookPath), { recursive: true })
            await fs.writeFile(hookPath, PRE_COMMIT_HOOK_BODY, 'utf-8')
            await fs.chmod(hookPath, 0o755)
            await execAsync('git config core.hooksPath .githooks', { cwd: projectPath })
            stagedPaths.push(hookPath)
          }

          await execAsync(`git add ${stagedPaths.map((p) => JSON.stringify(p)).join(' ')}`, {
            cwd: projectPath,
          })
          return true
        } catch {
          // not in a git repo, or git missing — fall through
          return false
        }
      })()

      const enforceLabel = options.enforce ? ' + pre-commit enforce' : ''
      const summary = `${teamConfig.required ? '✓ team mode (required)' : '✓ team mode (optional)'}${enforceLabel} — minVersion ${teamConfig.minVersion}`
      const stagedHint = staged
        ? `Staged: ${stagedPaths.map((p) => p.replace(`${projectPath}/`, '')).join(', ')}`
        : 'Files written but not staged (no git repo or git missing).'
      const nextSteps = [
        '1. Review the diff: `git diff --staged`',
        '2. Commit: `git commit -m "chore: enroll repo in prjct team mode"`',
        '3. Push: `git push`',
        '4. Teammates run `curl -sSL https://raw.githubusercontent.com/prjct-app/cli/main/scripts/install-standalone.sh | bash` (or `npm install -g prjct-cli@latest`).',
        ...(options.enforce
          ? [
              '5. **Each teammate** runs `git config core.hooksPath .githooks` once (or `prjct team --enforce` to do it automatically).',
            ]
          : []),
      ].join('\n')

      if (options.md) {
        console.log(
          mdOutput(
            mdSection('Team mode enrolled', summary),
            mdSection('Files', stagedHint),
            mdSection('Next', nextSteps)
          )
        )
      } else {
        out.done(summary)
        console.log(stagedHint)
        console.log('\nNext steps:')
        console.log(nextSteps)
      }

      return {
        success: true,
        teamConfig,
        staged,
        teamPath,
        claudeMdPath,
      }
    } catch (error) {
      const msg = getErrorMessage(error)
      return failHard(msg)
    }
  }

  /**
   * `prjct team check` — drift detector + self-heal for the mirror.
   *
   * Compares the on-disk `.prjct/team.json` against the DB row via
   * canonical JSON byte-equality (sorted keys, no extra whitespace).
   * If they differ, rewrites the mirror atomically from the DB row.
   * If the DB row is empty but the disk file exists (mid-migration
   * state from a pre-v2.19.7 install), populates the DB from the disk
   * then rewrites the mirror — a no-op churn that proves the round-trip.
   *
   * Placement is under `prjct team`, not `prjct doctor` — this is a
   * team-config-specific drift check; the only consumer is the
   * pre-commit hook, and folding into doctor would conflate concerns.
   *
   * See spec a50b32d1 AC #2.
   */
  async check(
    projectPath: string = process.cwd(),
    options: TeamOptions = {}
  ): Promise<CommandResult> {
    try {
      const initResult = await this.ensureProjectInit(projectPath)
      if (!initResult.success) return initResult
      const projectId = await configManager.getProjectId(projectPath)
      if (!projectId) {
        return failHard('No prjct project. Run `prjct init` first.', options)
      }

      const teamPath = path.join(projectPath, '.prjct', 'team.json')
      const dbRow = teamEnrollmentStorage.get(projectId)

      const diskRaw = await fs.readFile(teamPath, 'utf-8').catch(() => null)

      // Case A: DB empty, disk has content → migration. Adopt disk into DB.
      if (dbRow === null && diskRaw !== null) {
        const parsed: unknown = (() => {
          try {
            return JSON.parse(diskRaw)
          } catch {
            return null
          }
        })()
        if (parsed === null) {
          return failWith(
            `cannot parse ${teamPath} — fix or delete the file before running team check again`,
            options
          )
        }
        const enrollment: TeamEnrollment = {
          required:
            typeof (parsed as { required?: unknown }).required === 'boolean'
              ? (parsed as { required: boolean }).required
              : false,
          minVersion:
            typeof (parsed as { minVersion?: unknown }).minVersion === 'string'
              ? (parsed as { minVersion: string }).minVersion
              : (VERSION ?? '0.0.0'),
          enrolledAt:
            typeof (parsed as { enrolledAt?: unknown }).enrolledAt === 'string'
              ? (parsed as { enrolledAt: string }).enrolledAt
              : new Date().toISOString(),
          enrolledBy:
            typeof (parsed as { enrolledBy?: unknown }).enrolledBy === 'string'
              ? (parsed as { enrolledBy: string }).enrolledBy
              : null,
        }
        teamEnrollmentStorage.set(projectId, enrollment)
        await writeFileAtomic(teamPath, renderTeamMirror(enrollment))
        const msg = '✓ team check: migrated disk → DB; mirror rewritten'
        if (options.md) console.log(`> ${msg}`)
        else out.done(msg)
        return { success: true, healed: true, migrated: true }
      }

      // Case B: DB has a row. Compare canonical-serialized DB vs disk.
      if (dbRow !== null) {
        const dbCanonical = serializeCanonical(dbRow)
        const diskCanonical = diskRaw === null ? null : canonicalizeDiskTeamJson(diskRaw, dbRow)

        if (diskCanonical === dbCanonical) {
          const msg = '✓ team check: mirror in sync'
          if (options.md) console.log(`> ${msg}`)
          else out.done(msg)
          return { success: true, healed: false }
        }

        // Drift — rewrite mirror from DB.
        await writeFileAtomic(teamPath, renderTeamMirror(dbRow))
        const msg = '✓ team check: drift detected; mirror rewritten from DB'
        if (options.md) console.log(`> ${msg}`)
        else out.done(msg)
        return { success: true, healed: true }
      }

      // Case C: both empty. Nothing to check.
      const msg = '✓ team check: no enrollment configured'
      if (options.md) console.log(`> ${msg}`)
      else out.done(msg)
      return { success: true, healed: false, empty: true }
    } catch (error) {
      return failHard(getErrorMessage(error), options)
    }
  }
}

/**
 * Canonicalize disk team.json to compare against DB. We parse, fill
 * missing `enrolledBy` from the DB row (mirror omits null), and
 * re-serialize with sorted keys.
 */
function canonicalizeDiskTeamJson(diskRaw: string, dbRow: TeamEnrollment): string | null {
  const parsed: unknown = (() => {
    try {
      return JSON.parse(diskRaw)
    } catch {
      return null
    }
  })()
  if (parsed === null) return null
  const p = parsed as Record<string, unknown>
  const enrollment: TeamEnrollment = {
    required: p.required === true,
    minVersion: typeof p.minVersion === 'string' ? p.minVersion : '',
    enrolledAt: typeof p.enrolledAt === 'string' ? p.enrolledAt : '',
    enrolledBy:
      typeof p.enrolledBy === 'string'
        ? p.enrolledBy
        : // Mirror omits enrolledBy when DB has null — treat the
          // absence on disk as matching whatever DB has.
          dbRow.enrolledBy,
  }
  return serializeCanonical(enrollment)
}

/**
 * Pre-commit hook body. Pure POSIX sh so it runs everywhere git
 * runs. Reads .prjct/team.json — if `required:true` and `prjct` is
 * not on PATH, blocks the commit with an install instruction.
 *
 * Idempotent: if .prjct/team.json doesn't exist or is malformed, the
 * hook exits 0 (silent no-op). If `required:false`, also no-op.
 */
const PRE_COMMIT_HOOK_BODY = `#!/usr/bin/env sh
# prjct team enforce — blocks commits when team.json says required:true
# and the contributor doesn't have prjct installed locally.
# Generated by 'prjct team --enforce'. Safe to delete; safe to re-run.
set -e

TEAM_FILE=".prjct/team.json"
[ -f "$TEAM_FILE" ] || exit 0

# Cheap JSON parse — match "required": true with optional whitespace
if ! grep -qE '"required"[[:space:]]*:[[:space:]]*true' "$TEAM_FILE"; then
  exit 0
fi

if ! command -v prjct >/dev/null 2>&1; then
  printf '\\n\\033[1;31m✗ prjct is required for this repo (.prjct/team.json: required=true)\\033[0m\\n' >&2
  printf '  Install once:\\n' >&2
  printf '  \\033[36mcurl -sSL https://raw.githubusercontent.com/prjct-app/cli/main/scripts/install-standalone.sh | bash\\033[0m\\n' >&2
  printf '  Or: npm install -g prjct-cli@latest\\n' >&2
  printf '  (Bypass with --no-verify if you must, but the team agreed otherwise.)\\n\\n' >&2
  exit 1
fi

exit 0
`

function teamClaudeMdBlock(cfg: TeamConfig): string {
  return [
    CLAUDE_MD_START,
    '# prjct (team mode)',
    '',
    `This repo is enrolled in prjct team mode (required: ${cfg.required}, minVersion: ${cfg.minVersion}, enrolled: ${cfg.enrolledAt}).`,
    '',
    // One line instead of a bullet list: contributors WITH prjct installed
    // already get the full contract from the global CLAUDE.md + skill —
    // repeating it here doubled ~100 tokens in every repo session
    // (token-cache audit R7).
    'Query prjct (`prjct search`, `prjct context memory`, MCP `prjct_*`) before re-reading source; capture analysis back via `prjct remember <type> "..."` — in ENGLISH, whatever language the contributor speaks.',
    '',
    "Don't have prjct? Install once: `curl -sSL https://raw.githubusercontent.com/prjct-app/cli/main/scripts/install-standalone.sh | bash`",
    `${cfg.required ? 'This repo *requires* prjct — please install before contributing.' : ''}`,
    CLAUDE_MD_END,
  ]
    .filter((l) => l !== '')
    .join('\n')
}

function upsertBetweenMarkers(
  existing: string,
  block: string,
  startMarker: string,
  endMarker: string
): string {
  if (!existing.trim()) return `${block}\n`
  const startIdx = existing.indexOf(startMarker)
  const endIdx = existing.indexOf(endMarker)
  if (startIdx >= 0 && endIdx > startIdx) {
    const before = existing.slice(0, startIdx)
    const after = existing.slice(endIdx + endMarker.length)
    return `${`${before}${block}${after}`.replace(/\n{3,}/g, '\n\n').trim()}\n`
  }
  // No marker — append block at the end with a separator.
  const trimmed = existing.replace(/\s+$/, '')
  return `${trimmed}\n\n${block}\n`
}
