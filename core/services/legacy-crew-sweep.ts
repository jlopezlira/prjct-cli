/**
 * Legacy-disk sweep for crew persistence + client-tree hygiene.
 *
 * Runs on every `prjct sync` (SessionStart). Best-effort, never throws to
 * the caller — errors are collected on the result.
 *
 * ## HARD LAW (customer worktree)
 * The ONLY allowed file under `.prjct/` in a client repo is
 * `prjct.config.json`. Everything else is product state and MUST live in
 * project SQLite (`~/.prjct-cli/projects/<id>/prjct.db`). Physical dumps
 * are not traceable.
 *
 * Every sync:
 *   1. **Migrate then DELETE** known leftovers:
 *        CHECKPOINTS.md → kv `crew:checkpoints` then unlink
 *        team.json      → kv `team:enrollment` then unlink (no disk mirror)
 *   2. **Ingest then DELETE** ghost dirs `sessions/`, `audits/`, `deploy/`
 *        (text → `prjct remember` context, topic worktree-ghost-ingest)
 *   3. **Belt**: delete ANY remaining entry under `.prjct/` except
 *        `prjct.config.json` (ingest text first when possible)
 *   4. **Repair** crew agent files that still instruct disk writes
 *
 * See product invariant "SQLite only / nothing in client repo".
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import { getTemplateContent } from '../agentic/template-loader'
import type { AgentRole } from '../schemas/model'
import checkpointsStorage from '../storage/checkpoints-storage'
import prjctDb from '../storage/database'
import teamEnrollmentStorage, { type TeamEnrollment } from '../storage/team-enrollment-storage'
import log from '../utils/logger'
import { CREW_ROLES } from './agent-dispatch'

const LEGACY_CHECKPOINTS_PATH = '.prjct/CHECKPOINTS.md'
const LEGACY_TEAM_PATH = '.prjct/team.json'

const FLAG_CHECKPOINTS = 'migration:v2.19.8:last-flagged-checkpoints'
const FLAG_TEAM = 'migration:v2.19.8:last-flagged-team'
/** One-shot inbox warn after a worktree ghost purge (avoids SessionStart spam). */
const FLAG_GHOST_PURGE_WARN = 'migration:v3.77:last-ghost-purge-warn'
/** One-shot inbox warn after repairing agent files that instructed disk writes. */
const FLAG_AGENT_REPAIR_WARN = 'migration:v3.77:last-agent-repair-warn'

/**
 * Subdirectories of `.prjct/` that must NEVER exist in a customer worktree.
 * Agents historically dumped plan/impl/review/audit notes here.
 */
export const WORKTREE_GHOST_DIRS = ['sessions', 'audits', 'deploy'] as const

/**
 * Affirmative "write here" patterns from pre-fix crew templates.
 * Mentions that only *ban* the path (e.g. "Never write `.prjct/sessions/`")
 * must NOT trigger a force-refresh — only instructions that tell agents to
 * dump plan/impl/review files into the customer worktree.
 */
export const FORBIDDEN_WORKTREE_WRITE_PATTERNS: readonly RegExp[] = [
  // Classic crew anti-broken-telephone contract (customer worktree)
  /\.prjct\/sessions\/<task/i,
  /\.prjct\/sessions\/\$\{/i,
  /->\s*`?\.prjct\/sessions\//i,
  /write(?:s|n)?\s+(?:a\s+)?(?:plan|report|results?|verdict|findings?)[^\n]{0,120}\.prjct\/sessions\//i,
  /write(?:s|n)?\s+its\s+results[^\n]{0,80}\.prjct\/sessions\//i,
  /Session artifacts at `?\.prjct\/sessions\//i,
  /Implementer report at `?\.prjct\/sessions\//i,
  /Reviewer verdict at `?\.prjct\/sessions\//i,
  // Other historically-polluting dumps
  /\.prjct\/audits\//i,
  /\.prjct\/deploy\//i,
  // "Hide it under ~/.prjct-cli/…/sessions/" — still a physical file, still
  // not traceable. Plans/data must go to SQLite only.
  /SESSION_ROOT\s*=/i,
  /Write under `?SESSION_ROOT/i,
  /~\/\.prjct-cli\/projects\/[^\s`]+\/sessions\//i,
  /sessions\/<task-slug>\/\{?plan/i,
]

/** @deprecated Use FORBIDDEN_WORKTREE_WRITE_PATTERNS — kept for external importers/tests. */
export const FORBIDDEN_WORKTREE_WRITE_NEEDLES = [
  '.prjct/sessions/<task',
  '.prjct/audits/',
  '.prjct/deploy/',
] as const

const CREW_AGENT_FILES: Array<{ destRelative: string; templateKey: string }> = CREW_ROLES.map(
  (r) => ({
    destRelative: `.claude/agents/${r.name}.md`,
    templateKey: `crew/roles/${r.name}.md`,
  })
)

const CLAUDE_FILE = 'CLAUDE.md'
const CREW_MD_FILE = 'CREW.md'
const CLAUDE_SNIPPET_TEMPLATE = 'crew/leader-mode.md'
const SNIPPET_START = '<!-- prjct:crew:start - DO NOT REMOVE THIS MARKER -->'
/** Canonical end marker (current templates). */
const SNIPPET_END = '<!-- prjct:crew:end - DO NOT REMOVE THIS MARKER -->'
/** Older installs used a short end marker without the DO-NOT-REMOVE suffix. */
const SNIPPET_END_SHORT = '<!-- prjct:crew:end -->'
const CHECKPOINTS_START =
  '<!-- prjct:checkpoints:start - DO NOT EDIT (managed by `prjct crew checkpoints set|reset`) -->'
const CHECKPOINTS_END = '<!-- prjct:checkpoints:end -->'

interface FlagRow {
  mtime_ms: number
  migrated_at: string
}

export interface LegacySweepResult {
  checkpointsMigrated: boolean
  /** @deprecated hand-edits are re-adopted into SQL then deleted — kept for log compat */
  checkpointsHandEditWarned: boolean
  teamMigrated: boolean
  /** @deprecated same as checkpoints — re-adopt + delete */
  teamHandEditWarned: boolean
  /** Ghost dirs purged from the customer worktree this run (e.g. `sessions`). */
  ghostDirsPurged: string[]
  /** Relative paths of crew agent / CLAUDE files force-refreshed this run. */
  agentFilesRepaired: string[]
  /** Number of ghost text files ingested into SQLite before purge. */
  ghostFilesIngested: number
  /**
   * Names under `.prjct/` removed this run after migrate/ingest
   * (e.g. `CHECKPOINTS.md`, `team.json`, `sessions`).
   */
  clientPrjctJunkPurged: string[]
  errors: Array<{ file: string; reason: string }>
}

/**
 * Entries allowed under client `.prjct/`. `prjct.config.json` is the only
 * hand-editable file; `memory-export/` is a legitimate product feature
 * (`prjct memory export|import`, memory-export.ts) — a git-shareable,
 * intentionally-committed directory, not ghost/leftover state. Excluding it
 * here previously meant the very next `prjct sync` after an export silently
 * ingested it as generic ghost text then deleted it.
 */
export const CLIENT_PRJCT_ALLOWLIST = ['prjct.config.json', 'memory-export'] as const

async function statMtimeMs(filePath: string): Promise<number | null> {
  try {
    const stat = await fs.stat(filePath)
    return stat.mtimeMs
  } catch {
    return null
  }
}

async function tryReadFile(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, 'utf-8')
  } catch {
    return null
  }
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath)
    return true
  } catch {
    return false
  }
}

function readFlag(projectId: string, key: string): FlagRow | null {
  return prjctDb.getDoc<FlagRow>(projectId, key)
}

function writeFlag(projectId: string, key: string, mtimeMs: number): void {
  prjctDb.setDoc<FlagRow>(projectId, key, {
    mtime_ms: mtimeMs,
    migrated_at: new Date().toISOString(),
  })
}

/**
 * Capture a one-shot inbox warning. The flag mtime guards against
 * repeated noise — `prjct sync` runs on every SessionStart hook, so a
 * persistent legacy file would otherwise re-fire on every session.
 */
async function captureInboxWarning(
  projectPath: string,
  text: string,
  tags: Record<string, string>
): Promise<void> {
  try {
    const { projectMemory } = await import('../memory/project-memory')
    await projectMemory.remember(projectPath, {
      type: 'inbox',
      content: text,
      tags,
      provenance: 'declared',
    })
  } catch (error) {
    log.debug('Legacy sweep inbox capture failed (non-critical)', {
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

export function containsForbiddenWriteInstruction(content: string): boolean {
  return FORBIDDEN_WORKTREE_WRITE_PATTERNS.some((re) => re.test(content))
}

/**
 * Strip a legacy `model:` pin from an installed crew agent so it inherits the
 * user's model. Old installs stamped opus/sonnet/haiku per role; that policy
 * is gone (see `core/schemas/model.ts`) and the sweep un-stamps it.
 */
function stripCrewModelPin(content: string, destRelative: string): string {
  const roleName = CREW_ROLES.find((r) => `.claude/agents/${r.name}.md` === destRelative)?.role as
    | AgentRole
    | undefined
  if (!roleName) return content
  return content.replace(/^model:[ \t].*(?:\r?\n)?/m, '')
}

function spliceCheckpoints(reviewerTemplate: string, checkpointsContent: string): string {
  const startIdx = reviewerTemplate.indexOf(CHECKPOINTS_START)
  const endIdx = reviewerTemplate.indexOf(CHECKPOINTS_END)
  if (startIdx < 0 || endIdx < 0 || endIdx < startIdx) {
    // Template without markers (older bundle) — return as-is.
    return reviewerTemplate
  }
  const before = reviewerTemplate.slice(0, startIdx + CHECKPOINTS_START.length)
  const after = reviewerTemplate.slice(endIdx)
  return `${before}\n${checkpointsContent.trimEnd()}\n${after}`
}

/**
 * Strip EVERY crew marker block (handles short end markers + duplicates from
 * partial repairs), then append exactly one fresh snippet.
 */
function replaceCrewSnippet(claudeContent: string, snippet: string): string {
  // Loop: remove start→end pairs until none remain (covers duplicate blocks).
  // Prefer the long end marker; fall back to the short historical form.
  const stripMarkerBlocks = (body: string): string => {
    const startIdx = body.indexOf(SNIPPET_START)
    if (startIdx < 0) return body
    const afterStart = body.slice(startIdx + SNIPPET_START.length)
    const longEndRel = afterStart.indexOf(SNIPPET_END)
    const shortEndRel = afterStart.indexOf(SNIPPET_END_SHORT)
    const ending =
      longEndRel >= 0 && (shortEndRel < 0 || longEndRel <= shortEndRel)
        ? { relative: longEndRel, length: SNIPPET_END.length }
        : shortEndRel >= 0
          ? { relative: shortEndRel, length: SNIPPET_END_SHORT.length }
          : null
    if (!ending) {
      // Orphan start marker — drop from start to EOF and stop.
      return body.slice(0, startIdx)
    }
    const endAbs = startIdx + SNIPPET_START.length + ending.relative
    return stripMarkerBlocks(`${body.slice(0, startIdx)}${body.slice(endAbs + ending.length)}`)
  }
  const body = stripMarkerBlocks(claudeContent)
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd()
  const sep = body.length > 0 ? '\n\n' : ''
  return `${body}${sep}${snippet.trimEnd()}\n`
}

/**
 * Custom checkpoints that still list session artifact paths re-inject the
 * forbidden instruction into reviewer.md on every splice. Strip those lines
 * (and any other affirmative worktree-write paths) before splicing / storing.
 */
function sanitizeCheckpointsContent(content: string): string {
  if (!containsForbiddenWriteInstruction(content)) return content
  const cleaned = content
    .split('\n')
    .filter((line) => !containsForbiddenWriteInstruction(line))
    .join('\n')
    // Collapse runs of blank lines left by removals.
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd()
  return `${cleaned}\n`
}

async function sweepCheckpoints(
  projectPath: string,
  projectId: string,
  out: LegacySweepResult
): Promise<void> {
  const filePath = path.join(projectPath, LEGACY_CHECKPOINTS_PATH)
  const mtimeMs = await statMtimeMs(filePath)
  if (mtimeMs === null) return // file doesn't exist — nothing to do

  const flag = readFlag(projectId, FLAG_CHECKPOINTS)
  const content = await tryReadFile(filePath)

  // Migrate into SQLite first (never leave client as source of truth).
  if (content !== null) {
    try {
      if (flag === null) {
        checkpointsStorage.set(projectId, content, 'migrated')
        writeFlag(projectId, FLAG_CHECKPOINTS, mtimeMs)
        out.checkpointsMigrated = true
        await captureInboxWarning(
          projectPath,
          `Legacy .prjct/CHECKPOINTS.md migrated into kv_store crew:checkpoints and DELETED from the client worktree. Manage with 'prjct crew checkpoints show|set|reset|export'. Product law: nothing but prjct.config.json under client .prjct/.`,
          { 'migration:v3.79': '1', topic: 'crew-checkpoints' }
        )
      } else if (mtimeMs > flag.mtime_ms) {
        // Hand-edit after prior migrate — re-adopt then delete.
        checkpointsStorage.set(projectId, content, 'migrated')
        writeFlag(projectId, FLAG_CHECKPOINTS, mtimeMs)
        out.checkpointsHandEditWarned = true
        await captureInboxWarning(
          projectPath,
          `Legacy .prjct/CHECKPOINTS.md hand-edited after migration — content re-adopted into kv_store and file DELETED. Prefer 'prjct crew checkpoints set' going forward.`,
          { 'migration:v3.79': '1', topic: 'crew-checkpoints', state: 're-adopted' }
        )
      }
    } catch (error) {
      out.errors.push({
        file: LEGACY_CHECKPOINTS_PATH,
        reason: error instanceof Error ? error.message : String(error),
      })
      // Still attempt delete below — config-only law.
    }
  }

  try {
    await fs.rm(filePath, { force: true })
    out.clientPrjctJunkPurged.push('CHECKPOINTS.md')
  } catch (error) {
    out.errors.push({
      file: LEGACY_CHECKPOINTS_PATH,
      reason: error instanceof Error ? error.message : String(error),
    })
  }
}

/** Build a `TeamEnrollment` row from a parsed legacy `team.json` blob. */
function parseTeamEnrollment(parsed: Record<string, unknown>): TeamEnrollment {
  return {
    required: parsed.required === true,
    minVersion: typeof parsed.minVersion === 'string' ? parsed.minVersion : '0.0.0',
    enrolledAt:
      typeof parsed.enrolledAt === 'string' ? parsed.enrolledAt : new Date().toISOString(),
    enrolledBy: typeof parsed.enrolledBy === 'string' ? parsed.enrolledBy : null,
  }
}

async function sweepTeamJson(
  projectPath: string,
  projectId: string,
  out: LegacySweepResult
): Promise<void> {
  const filePath = path.join(projectPath, LEGACY_TEAM_PATH)
  const mtimeMs = await statMtimeMs(filePath)
  if (mtimeMs === null) return

  const flag = readFlag(projectId, FLAG_TEAM)
  const dbRow = teamEnrollmentStorage.get(projectId)
  const content = await tryReadFile(filePath)

  if (content !== null) {
    try {
      if (flag === null || dbRow === null) {
        if (dbRow === null) {
          const parsed = JSON.parse(content) as Record<string, unknown>
          const enrollment: TeamEnrollment = parseTeamEnrollment(parsed)
          teamEnrollmentStorage.set(projectId, enrollment)
          out.teamMigrated = true
          await captureInboxWarning(
            projectPath,
            `Legacy .prjct/team.json adopted into kv_store team:enrollment and DELETED from the client worktree. Team state is SQL-only; manage with 'prjct team'.`,
            { 'migration:v3.79': '1', topic: 'team-enrollment' }
          )
        }
        writeFlag(projectId, FLAG_TEAM, mtimeMs)
      } else if (mtimeMs > flag.mtime_ms) {
        // Hand-edit: re-adopt into DB then delete (disk is never SoT).
        try {
          const parsed = JSON.parse(content) as Record<string, unknown>
          const enrollment: TeamEnrollment = parseTeamEnrollment(parsed)
          teamEnrollmentStorage.set(projectId, enrollment)
        } catch {
          /* keep existing DB row if disk JSON is garbage */
        }
        writeFlag(projectId, FLAG_TEAM, mtimeMs)
        out.teamHandEditWarned = true
      }
    } catch (error) {
      out.errors.push({
        file: LEGACY_TEAM_PATH,
        reason: error instanceof Error ? error.message : String(error),
      })
    }
  }

  // NEVER leave team.json in the client tree (no derived mirror).
  try {
    await fs.rm(filePath, { force: true })
    out.clientPrjctJunkPurged.push('team.json')
  } catch (error) {
    out.errors.push({
      file: LEGACY_TEAM_PATH,
      reason: error instanceof Error ? error.message : String(error),
    })
  }
}

/**
 * Walk a directory tree and yield absolute paths of regular files.
 */
async function listFilesRecursive(dir: string): Promise<string[]> {
  const out: string[] = []
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      out.push(...(await listFilesRecursive(full)))
    } else if (entry.isFile()) {
      out.push(full)
    }
  }
  return out
}

/**
 * Ingest a ghost text file into SQLite (memories) so content stays traceable,
 * then the caller deletes the physical path. Caps body size to avoid dumping
 * huge accidental binaries into memory.
 */
async function ingestGhostFileToSql(
  projectPath: string,
  projectId: string,
  absPath: string,
  relFromProject: string
): Promise<boolean> {
  const TEXT_EXT = new Set(['.md', '.txt', '.json', '.yml', '.yaml', '.toml', '.csv', '.log'])
  const ext = path.extname(absPath).toLowerCase()
  if (!TEXT_EXT.has(ext) && ext !== '') return false

  const body = await fs
    .readFile(absPath)
    .then((buf) => {
      // Skip obvious binaries / huge dumps
      if (buf.byteLength > 200_000) return null
      const text = buf.toString('utf-8')
      return text.includes('\u0000') ? null : text
    })
    .catch(() => null)
  if (body === null) return false
  if (!body.trim()) return false

  const cap = 12_000
  const clipped =
    body.length > cap ? `${body.slice(0, cap)}\n\n…[truncated ${body.length - cap} chars]` : body
  const content = [
    `Rescued worktree ghost (physical files are not traceable — ingested to SQLite, disk deleted).`,
    `source: ${relFromProject}`,
    '',
    clipped,
  ].join('\n')

  try {
    const { projectMemory } = await import('../memory/project-memory')
    await projectMemory.remember(projectPath, {
      type: 'context',
      content,
      tags: {
        topic: 'worktree-ghost-ingest',
        source_path: relFromProject,
        'migration:v3.77': '1',
      },
      provenance: 'declared',
      projectId,
      force: true,
    })
    return true
  } catch (error) {
    log.debug('Ghost file SQL ingest failed (non-critical)', {
      file: relFromProject,
      error: error instanceof Error ? error.message : String(error),
    })
    return false
  }
}

/**
 * HARD LAW: delete ghost dirs under the customer's `.prjct/`.
 * Text content is ingested into SQLite first (traceable); physical files
 * are then removed. Never re-homes content onto another disk path.
 * Runs on EVERY sync — agents can re-create these between sessions.
 */
async function purgeWorktreeGhostDirs(
  projectPath: string,
  projectId: string,
  out: LegacySweepResult
): Promise<void> {
  const prjctDir = path.join(projectPath, '.prjct')
  if (!(await pathExists(prjctDir))) return

  for (const name of WORKTREE_GHOST_DIRS) {
    const ghostPath = path.join(prjctDir, name)
    if (!(await pathExists(ghostPath))) continue

    try {
      const files = await listFilesRecursive(ghostPath)
      for (const abs of files) {
        const rel = path.relative(projectPath, abs)
        const ok = await ingestGhostFileToSql(projectPath, projectId, abs, rel)
        if (ok) out.ghostFilesIngested += 1
      }
      await fs.rm(ghostPath, { recursive: true, force: true })
      out.ghostDirsPurged.push(name)
    } catch (error) {
      out.errors.push({
        file: `.prjct/${name}/`,
        reason: error instanceof Error ? error.message : String(error),
      })
    }
  }

  if (out.ghostDirsPurged.length === 0) return

  // One-shot inbox so SessionStart doesn't spam every subsequent clean sync.
  const flag = readFlag(projectId, FLAG_GHOST_PURGE_WARN)
  if (flag === null) {
    const ingested =
      out.ghostFilesIngested > 0
        ? ` ${out.ghostFilesIngested} text file(s) ingested into SQLite (topic:worktree-ghost-ingest) for traceability.`
        : ''
    await captureInboxWarning(
      projectPath,
      `Purged forbidden prjct ghost dir(s) from the customer worktree: ${out.ghostDirsPurged.map((d) => `.prjct/${d}/`).join(', ')}.${ingested} Product law: plans and work data live ONLY in project SQLite (prjct plan / prjct spec / prjct remember / prjct crew record-run) — never as physical files in the repo or under ~/.prjct-cli. The only hand-editable file under .prjct/ is prjct.config.json.`,
      { 'migration:v3.77': '1', topic: 'worktree-ghost-purge' }
    )
    writeFlag(projectId, FLAG_GHOST_PURGE_WARN, Date.now())
  }
}

/**
 * If installed crew agent files (or CLAUDE.md / CREW.md) still instruct
 * writing into `.prjct/sessions|audits|deploy/`, force-refresh them from the
 * current templates. This is the only way to stop agents from re-creating
 * the ghost dirs we just purged — stale customized agents keep the bug alive.
 */
async function repairCrewDiskWriteInstructions(
  projectPath: string,
  projectId: string,
  out: LegacySweepResult
): Promise<void> {
  // 0. Sanitize kv_store checkpoints if they still list session-artifact paths.
  //    Otherwise every reviewer.md splice re-injects the forbidden instruction.
  try {
    const row = checkpointsStorage.get(projectId)
    const sanitized = sanitizeCheckpointsContent(row.content)
    if (sanitized !== row.content) {
      // Persist sanitized text. 'default' rows aren't on disk — writing
      // 'migrated' is correct (we adopted+cleaned the content). User rows
      // keep 'user' so hand-customization provenance is preserved.
      const source = row.source === 'user' ? 'user' : 'migrated'
      checkpointsStorage.set(projectId, sanitized, source)
      out.agentFilesRepaired.push('kv_store[crew:checkpoints]')
    }
  } catch (error) {
    out.errors.push({
      file: 'kv_store[crew:checkpoints]',
      reason: error instanceof Error ? error.message : String(error),
    })
  }

  // 1. Native crew agents under .claude/agents/
  for (const agent of CREW_AGENT_FILES) {
    const abs = path.join(projectPath, agent.destRelative)
    const existing = await tryReadFile(abs)
    if (existing === null) continue
    if (!containsForbiddenWriteInstruction(existing)) continue

    const template = getTemplateContent(agent.templateKey)
    if (!template) {
      out.errors.push({ file: agent.destRelative, reason: 'template missing' })
      continue
    }
    try {
      const next = stripCrewModelPin(
        agent.destRelative === '.claude/agents/reviewer.md'
          ? spliceCheckpoints(
              template,
              sanitizeCheckpointsContent(checkpointsStorage.get(projectId).content)
            )
          : template,
        agent.destRelative
      )
      await fs.mkdir(path.dirname(abs), { recursive: true })
      await fs.writeFile(abs, next, 'utf-8')
      out.agentFilesRepaired.push(agent.destRelative)
    } catch (error) {
      out.errors.push({
        file: agent.destRelative,
        reason: error instanceof Error ? error.message : String(error),
      })
    }
  }

  // 2. CLAUDE.md crew block (leader-mode snippet). Also collapse duplicates
  //    left by partial historical repairs (short end-marker + append).
  const claudePath = path.join(projectPath, CLAUDE_FILE)
  const claude = await tryReadFile(claudePath)
  if (claude !== null) {
    const startCount = (claude.match(/prjct:crew:start/g) ?? []).length
    const needsRepair =
      containsForbiddenWriteInstruction(claude) ||
      startCount > 1 ||
      claude.includes(SNIPPET_END_SHORT)
    if (needsRepair) {
      const snippet = getTemplateContent(CLAUDE_SNIPPET_TEMPLATE)?.trim()
      if (!snippet) {
        out.errors.push({ file: CLAUDE_FILE, reason: 'leader-mode template missing' })
      } else {
        try {
          const next = replaceCrewSnippet(claude, snippet)
          await fs.writeFile(claudePath, next, 'utf-8')
          out.agentFilesRepaired.push(CLAUDE_FILE)
        } catch (error) {
          out.errors.push({
            file: CLAUDE_FILE,
            reason: error instanceof Error ? error.message : String(error),
          })
        }
      }
    }
  }

  // 3. Emulated CREW.md (non-Claude providers)
  const crewMdPath = path.join(projectPath, CREW_MD_FILE)
  const crewMd = await tryReadFile(crewMdPath)
  if (crewMd !== null && containsForbiddenWriteInstruction(crewMd)) {
    // Emulated protocol is rebuilt on next `prjct crew install`. For sync we
    // only strip the forbidden paths so agents stop following them: replace
    // the whole file with a short ban pointing operators at reinstall.
    try {
      const ban = [
        '# CREW.md — reinstall required',
        '',
        'This file previously instructed agents to write plans/reports under',
        '`.prjct/sessions/` (or other worktree paths). That is forbidden.',
        '',
        'Run `prjct crew install` to regenerate the emulated crew protocol.',
        'Durable state goes through `prjct` CLI verbs only (SQLite).',
        '',
      ].join('\n')
      await fs.writeFile(crewMdPath, ban, 'utf-8')
      out.agentFilesRepaired.push(CREW_MD_FILE)
    } catch (error) {
      out.errors.push({
        file: CREW_MD_FILE,
        reason: error instanceof Error ? error.message : String(error),
      })
    }
  }

  if (out.agentFilesRepaired.length === 0) return

  const flag = readFlag(projectId, FLAG_AGENT_REPAIR_WARN)
  if (flag === null) {
    await captureInboxWarning(
      projectPath,
      `Repaired crew instruction files that still told agents to write plans/reports to disk (${out.agentFilesRepaired.join(', ')}). Refreshed from current prjct templates. Product law: plans + work data ONLY in project SQLite via prjct plan / prjct spec / prjct remember / prjct crew record-run — physical files are not traceable.`,
      { 'migration:v3.77': '1', topic: 'crew-disk-write-repair' }
    )
    writeFlag(projectId, FLAG_AGENT_REPAIR_WARN, Date.now())
  }
}

/**
 * Final belt: `.prjct/` may contain ONLY `prjct.config.json`.
 * Any leftover file/dir is ingested (text) then deleted.
 */
async function enforcePrjctConfigOnly(
  projectPath: string,
  projectId: string,
  out: LegacySweepResult
): Promise<void> {
  const prjctDir = path.join(projectPath, '.prjct')
  if (!(await pathExists(prjctDir))) return

  const entries = await fs.readdir(prjctDir).catch(() => [])

  for (const name of entries) {
    if ((CLIENT_PRJCT_ALLOWLIST as readonly string[]).includes(name)) continue
    const abs = path.join(prjctDir, name)
    try {
      const st = await fs.stat(abs)
      if (st.isDirectory()) {
        const files = await listFilesRecursive(abs)
        for (const f of files) {
          const rel = path.relative(projectPath, f)
          const ok = await ingestGhostFileToSql(projectPath, projectId, f, rel)
          if (ok) out.ghostFilesIngested += 1
        }
      } else if (st.isFile()) {
        const rel = path.relative(projectPath, abs)
        // CHECKPOINTS / team already migrated above; still ingest unknown text.
        if (name !== 'CHECKPOINTS.md' && name !== 'team.json') {
          const ok = await ingestGhostFileToSql(projectPath, projectId, abs, rel)
          if (ok) out.ghostFilesIngested += 1
        }
      }
      await fs.rm(abs, { recursive: true, force: true })
      if (!out.clientPrjctJunkPurged.includes(name)) {
        out.clientPrjctJunkPurged.push(name)
      }
    } catch (error) {
      out.errors.push({
        file: `.prjct/${name}`,
        reason: error instanceof Error ? error.message : String(error),
      })
    }
  }

  if (out.clientPrjctJunkPurged.length === 0) return
  const flag = readFlag(projectId, FLAG_GHOST_PURGE_WARN)
  // Reuse ghost purge warn only when we also purged dirs; else one-shot config-only warn
  if (flag === null && out.ghostDirsPurged.length === 0) {
    await captureInboxWarning(
      projectPath,
      `Client .prjct/ cleaned to config-only. Removed: ${out.clientPrjctJunkPurged.join(', ')}. Durable state is SQLite only (prjct crew checkpoints / prjct team / prjct remember).`,
      { 'migration:v3.79': '1', topic: 'client-prjct-config-only' }
    )
    writeFlag(projectId, FLAG_GHOST_PURGE_WARN, Date.now())
  }
}

/**
 * Run the legacy sweep. Best-effort: errors are collected and returned
 * but never thrown (sync must not fail on this — it runs every session
 * start and should be a quiet no-op once the client tree is clean).
 */
export async function legacyCrewSweep(
  projectPath: string,
  projectId: string
): Promise<LegacySweepResult> {
  const out: LegacySweepResult = {
    checkpointsMigrated: false,
    checkpointsHandEditWarned: false,
    teamMigrated: false,
    teamHandEditWarned: false,
    ghostDirsPurged: [],
    agentFilesRepaired: [],
    ghostFilesIngested: 0,
    clientPrjctJunkPurged: [],
    errors: [],
  }
  // Migrate-then-delete known files first so we never lose content.
  await sweepCheckpoints(projectPath, projectId, out).catch((error) => {
    out.errors.push({
      file: LEGACY_CHECKPOINTS_PATH,
      reason: error instanceof Error ? error.message : String(error),
    })
  })
  await sweepTeamJson(projectPath, projectId, out).catch((error) => {
    out.errors.push({
      file: LEGACY_TEAM_PATH,
      reason: error instanceof Error ? error.message : String(error),
    })
  })
  await purgeWorktreeGhostDirs(projectPath, projectId, out).catch((error) => {
    out.errors.push({
      file: '.prjct/*/',
      reason: error instanceof Error ? error.message : String(error),
    })
  })
  // Final belt: only prjct.config.json may remain.
  await enforcePrjctConfigOnly(projectPath, projectId, out).catch((error) => {
    out.errors.push({
      file: '.prjct/',
      reason: error instanceof Error ? error.message : String(error),
    })
  })
  await repairCrewDiskWriteInstructions(projectPath, projectId, out).catch((error) => {
    out.errors.push({
      file: '.claude/agents/*',
      reason: error instanceof Error ? error.message : String(error),
    })
  })
  return out
}
