/**
 * prjct crew — install/uninstall/status the crew-mode bundle.
 *
 * Crew mode is an opinionated multi-agent setup: a leader/implementer/reviewer
 * trio in `.claude/agents/`, a project-level `CHECKPOINTS.md`, and a CLAUDE.md
 * snippet that locks the main session into leader role. Strictly opt-in.
 *
 * Inspired by https://github.com/betta-tech/ejemplo-harness-subagentes
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import { getTemplateContent } from '../agentic/template-loader'
import configManager from '../infrastructure/config-manager'
import type { AgentRole } from '../schemas/model'
import {
  buildEmulatedCrewProtocol,
  CREW_ROLES,
  resolveDispatchMechanism,
} from '../services/agent-dispatch'
import { checkpointsStorage } from '../storage/checkpoints-storage'
import crewRunStorage from '../storage/crew-run-storage'
import type { MdOption } from '../types/cli'
import type { CommandResult } from '../types/commands'
import { getErrorMessage } from '../types/fs'
import { fileExists } from '../utils/file-helper'
import { failHard, failWith } from '../utils/md-aware'
import out from '../utils/output'
import { PrjctCommandsBase } from './base'

const SNIPPET_START = '<!-- prjct:crew:start - DO NOT REMOVE THIS MARKER -->'
const SNIPPET_END = '<!-- prjct:crew:end - DO NOT REMOVE THIS MARKER -->'

const CHECKPOINTS_START =
  '<!-- prjct:checkpoints:start - DO NOT EDIT (managed by `prjct crew checkpoints set|reset`) -->'
const CHECKPOINTS_END = '<!-- prjct:checkpoints:end -->'

/**
 * Splice the current checkpoints content into the reviewer agent
 * template between the marker pair. Anchored regex — refuses to write
 * if markers are missing or duplicated (defensive against template
 * drift). Content outside the markers is preserved verbatim.
 *
 * See spec a50b32d1 AC #7.
 */
function spliceCheckpoints(reviewerTemplate: string, checkpointsContent: string): string {
  const startIdx = reviewerTemplate.indexOf(CHECKPOINTS_START)
  const endIdx = reviewerTemplate.indexOf(CHECKPOINTS_END)
  if (startIdx < 0 || endIdx < 0 || endIdx < startIdx) {
    throw new Error(
      'reviewer template is missing the prjct:checkpoints marker pair — rebuild dist/templates.json or report a bug'
    )
  }
  // Refuse if marker appears more than once — ambiguous splice.
  if (reviewerTemplate.indexOf(CHECKPOINTS_START, startIdx + 1) >= 0) {
    throw new Error('reviewer template has duplicated checkpoints start marker')
  }
  const before = reviewerTemplate.slice(0, startIdx + CHECKPOINTS_START.length)
  const after = reviewerTemplate.slice(endIdx)
  // Single newline separators keep the markdown rendering tight.
  return `${before}\n${checkpointsContent.trimEnd()}\n${after}`
}

interface CrewFile {
  /** Path inside the templates/crew/ tree */
  templateKey: string
  /** Destination relative to the project root */
  destRelative: string
}

// Native `.claude/agents/` files + their model-policy role — both DERIVED from
// the single crew roster (CREW_ROLES), so the native crew, the emulated
// protocol, and the model policy can never drift apart.
const AGENT_FILES: CrewFile[] = CREW_ROLES.map((r) => ({
  templateKey: `crew/roles/${r.name}.md`,
  destRelative: `.claude/agents/${r.name}.md`,
}))

const CREW_AGENT_ROLES: Record<string, AgentRole> = Object.fromEntries(
  CREW_ROLES.map((r) => [`.claude/agents/${r.name}.md`, r.role])
)

/**
 * Strip any `model:` frontmatter from a crew agent at install time so the
 * subagent inherits whatever model the user is driving. prjct does not pick
 * models for roles — see `core/schemas/model.ts`. No-op for files not mapped
 * to a role, or templates with no `model:` line.
 */
export function stripCrewModelPin(content: string, destRelative: string): string {
  if (!CREW_AGENT_ROLES[destRelative]) return content
  return content.replace(/^model:[ \t].*(?:\r?\n)?/m, '')
}

const CHECKPOINTS_FILE: CrewFile = {
  templateKey: 'crew/CHECKPOINTS.md',
  destRelative: '.prjct/CHECKPOINTS.md',
}

const CLAUDE_SNIPPET_TEMPLATE = 'crew/leader-mode.md'
/** Destination file name in the *user's* project (host-specific, not this repo). */
const CLAUDE_FILE = 'CLAUDE.md'

interface PieceStatus {
  path: string
  installed: boolean
}

interface CrewStatus {
  agents: PieceStatus[]
  checkpoints: PieceStatus
  claudeSnippet: PieceStatus
  complete: boolean
}

async function readSnippet(): Promise<string> {
  const content = getTemplateContent(CLAUDE_SNIPPET_TEMPLATE)
  if (!content) {
    throw new Error(`Missing crew template: ${CLAUDE_SNIPPET_TEMPLATE}`)
  }
  return content.trim()
}

async function readTemplate(key: string): Promise<string> {
  const content = getTemplateContent(key)
  if (!content) {
    throw new Error(`Missing crew template: ${key}`)
  }
  return content
}

async function writeFileEnsureDir(absPath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(absPath), { recursive: true })
  await fs.writeFile(absPath, content, 'utf-8')
}

function snippetPresent(claudeContent: string): boolean {
  return claudeContent.includes(SNIPPET_START) && claudeContent.includes(SNIPPET_END)
}

function appendSnippet(claudeContent: string, snippet: string): string {
  // Idempotent: if markers exist, replace the block; otherwise append.
  if (snippetPresent(claudeContent)) {
    const startIdx = claudeContent.indexOf(SNIPPET_START)
    const endIdx = claudeContent.indexOf(SNIPPET_END) + SNIPPET_END.length
    return `${claudeContent.slice(0, startIdx)}${snippet}${claudeContent.slice(endIdx)}`
  }
  const sep = claudeContent.length > 0 && !claudeContent.endsWith('\n') ? '\n\n' : '\n'
  return `${claudeContent}${sep}${snippet}\n`
}

function stripSnippet(claudeContent: string): string {
  if (!snippetPresent(claudeContent)) return claudeContent
  const startIdx = claudeContent.indexOf(SNIPPET_START)
  const endIdx = claudeContent.indexOf(SNIPPET_END) + SNIPPET_END.length
  // Trim leading whitespace gap left by the removal.
  const result = `${claudeContent.slice(0, startIdx)}${claudeContent.slice(endIdx)}`
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd()
  return result.length > 0 ? `${result}\n` : ''
}

async function readClaudeMd(projectPath: string): Promise<string | null> {
  const claudePath = path.join(projectPath, CLAUDE_FILE)
  try {
    return await fs.readFile(claudePath, 'utf-8')
  } catch {
    return null
  }
}

async function getStatus(projectPath: string): Promise<CrewStatus> {
  const agents = await Promise.all(
    AGENT_FILES.map(async (f) => ({
      path: f.destRelative,
      installed: await fileExists(path.join(projectPath, f.destRelative)),
    }))
  )

  // Checkpoints moved from `.prjct/CHECKPOINTS.md` to kv_store
  // `crew:checkpoints` per spec a50b32d1. "Installed" means a project
  // exists with the row present (or the bundled default is reachable —
  // which it always is, since the template is in the bundle).
  const checkpointsInstalled = await (async () => {
    try {
      const projectId = await configManager.getProjectId(projectPath)
      if (!projectId) return false
      // We always return SOMETHING from get() (bundled default fallback),
      // so installed == has-customization-OR-bundled-default-available.
      checkpointsStorage.get(projectId)
      return true
    } catch {
      return false
    }
  })()
  const checkpoints: PieceStatus = {
    path: 'kv_store[crew:checkpoints]',
    installed: checkpointsInstalled,
  }

  const claudeContent = await readClaudeMd(projectPath)
  const claudeSnippet: PieceStatus = {
    path: CLAUDE_FILE,
    installed: claudeContent !== null && snippetPresent(claudeContent),
  }

  const complete =
    agents.every((a) => a.installed) && checkpoints.installed && claudeSnippet.installed

  return { agents, checkpoints, claudeSnippet, complete }
}

export class CrewCommands extends PrjctCommandsBase {
  /**
   * `prjct crew install` — copy the trio + CHECKPOINTS into the project,
   * append the leader-mode snippet to CLAUDE.md (idempotent).
   */
  async install(
    _arg: string | null = null,
    projectPath: string = process.cwd(),
    options: MdOption = {}
  ): Promise<CommandResult> {
    try {
      const written: string[] = []
      const skipped: string[] = []

      // Resolve projectId so we can read user-customized checkpoints from
      // kv_store and splice them into the reviewer template at install
      // time. Required for the new (post-spec-a50b32d1) reviewer flow —
      // no more `.prjct/CHECKPOINTS.md` on disk.
      const initResult = await this.ensureProjectInit(projectPath)
      if (!initResult.success) return initResult
      const projectId = await configManager.getProjectId(projectPath)
      if (!projectId) {
        return failHard('No prjct project. Run `prjct init` first.', options)
      }

      const checkpointsRow = checkpointsStorage.get(projectId)

      // Provider-aware crew. Claude has a native subagent tool, so the crew is
      // real `.claude/agents/` files dispatched via the Agent tool. Every other
      // rig has no subagent tool — install the EMULATED crew protocol instead
      // (one agent plays the roles in fresh passes with the per-role model), so
      // the multi-agent architecture runs there too rather than dropping dead
      // Claude-only files into the repo.
      const mechanism = await resolveDispatchMechanism()
      if (!mechanism.native) {
        const dest = path.join(projectPath, 'CREW.md')
        const existed = await fileExists(dest)
        await writeFileEnsureDir(dest, buildEmulatedCrewProtocol(mechanism, checkpointsRow.content))
        ;(existed ? skipped : written).push('CREW.md (emulated crew protocol)')
        const note = `crew installed for ${mechanism.provider} (emulated — no native subagent tool). One agent plays the roles per CREW.md.`
        if (options.md) {
          console.log(
            [
              '# prjct crew installed (emulated)',
              '',
              note,
              '',
              `Wrote \`CREW.md\` to \`${projectPath}\`.`,
            ].join('\n')
          )
        } else {
          out.done(note)
        }
        return { success: true, written, skipped }
      }

      // 1. Agents — write each. For reviewer.md, splice the current
      // checkpoints content into the marker region.
      for (const f of AGENT_FILES) {
        const dest = path.join(projectPath, f.destRelative)
        const template = await readTemplate(f.templateKey)
        const content = stripCrewModelPin(
          f.destRelative === '.claude/agents/reviewer.md'
            ? spliceCheckpoints(template, checkpointsRow.content)
            : template,
          f.destRelative
        )
        const exists = await fileExists(dest)
        await writeFileEnsureDir(dest, content)
        if (exists) skipped.push(`${f.destRelative} (overwritten)`)
        else written.push(f.destRelative)
      }

      // 2. CLAUDE.md snippet — append/replace marker block, idempotent
      const snippet = await readSnippet()
      const claudePath = path.join(projectPath, CLAUDE_FILE)
      const existingClaude = (await readClaudeMd(projectPath)) ?? ''
      const wasPresent = snippetPresent(existingClaude)
      const nextClaude = appendSnippet(existingClaude, snippet)
      if (nextClaude !== existingClaude) {
        await fs.writeFile(claudePath, nextClaude, 'utf-8')
        written.push(`${CLAUDE_FILE} (${wasPresent ? 'snippet refreshed' : 'snippet appended'})`)
      } else {
        skipped.push(`${CLAUDE_FILE} (snippet already current)`)
      }

      const summary = `crew installed (${written.length} written, ${skipped.length} kept)`
      const hookHint = [
        'Suggested next step — wire verification hooks into .claude/settings.json:',
        '  PostToolUse(Edit|Write) → run your test command',
        '  Stop → run your project test command and record the outcome',
        'Use the /update-config skill or edit settings.json manually.',
      ].join('\n')

      if (options.md) {
        const lines = ['# prjct crew installed', '', `Wrote to \`${projectPath}\`.`, '', '## Files']
        for (const f2 of written) lines.push(`- written: \`${f2}\``)
        for (const f3 of skipped) lines.push(`- kept: \`${f3}\``)
        lines.push('', '## Next step', '', hookHint)
        console.log(lines.join('\n'))
      } else {
        out.done(summary)
        for (const f4 of written) out.info(`written: ${f4}`)
        for (const f5 of skipped) out.info(`kept:    ${f5}`)
        console.log('')
        console.log(hookHint)
      }

      return { success: true, written, skipped }
    } catch (error) {
      const msg = getErrorMessage(error)
      return failHard(msg)
    }
  }

  /**
   * `prjct crew uninstall` — remove the trio + CHECKPOINTS,
   * strip the leader-mode snippet from CLAUDE.md.
   */
  async uninstall(
    _arg: string | null = null,
    projectPath: string = process.cwd(),
    options: MdOption = {}
  ): Promise<CommandResult> {
    try {
      const removed: string[] = []
      const missing: string[] = []

      // AGENT_FILES + legacy .prjct/CHECKPOINTS.md if still present on disk
      // (older installs wrote it before spec a50b32d1 moved checkpoints to
      // kv_store). The file is no longer written by install.
      const toRemove: CrewFile[] = [...AGENT_FILES, CHECKPOINTS_FILE]
      for (const f of toRemove) {
        const dest = path.join(projectPath, f.destRelative)
        if (await fileExists(dest)) {
          await fs.rm(dest)
          removed.push(f.destRelative)
        } else {
          missing.push(f.destRelative)
        }
      }

      // Clean up empty .claude/agents (only if it ended up empty after removal)
      const agentsDir = path.join(projectPath, '.claude/agents')
      try {
        const entries = await fs.readdir(agentsDir)
        if (entries.length === 0) await fs.rmdir(agentsDir)
      } catch {
        // Either doesn't exist or not empty — leave it.
      }

      // Strip CLAUDE.md snippet if present
      const claudePath = path.join(projectPath, CLAUDE_FILE)
      const existingClaude = await readClaudeMd(projectPath)
      if (existingClaude !== null && snippetPresent(existingClaude)) {
        const next = stripSnippet(existingClaude)
        await fs.writeFile(claudePath, next, 'utf-8')
        removed.push(`${CLAUDE_FILE} (snippet stripped)`)
      }

      const summary = `crew uninstalled (${removed.length} removed)`
      if (options.md) {
        const lines = ['# prjct crew uninstalled', '']
        for (const f2 of removed) lines.push(`- removed: \`${f2}\``)
        for (const f3 of missing) lines.push(`- not present: \`${f3}\``)
        console.log(lines.join('\n'))
      } else {
        out.done(summary)
        for (const f4 of removed) out.info(`removed: ${f4}`)
      }

      return { success: true, removed, missing }
    } catch (error) {
      const msg = getErrorMessage(error)
      return failHard(msg)
    }
  }

  /**
   * `prjct crew status` — report which pieces of the bundle are installed.
   */
  async status(
    _arg: string | null = null,
    projectPath: string = process.cwd(),
    options: MdOption = {}
  ): Promise<CommandResult> {
    try {
      const status = await getStatus(projectPath)
      const tag = (s: PieceStatus) => (s.installed ? 'installed' : 'missing')

      if (options.md) {
        const lines = [
          '# prjct crew status',
          '',
          `Project: \`${projectPath}\``,
          `Complete: **${status.complete ? 'yes' : 'no'}**`,
          '',
          '## Pieces',
        ]
        for (const a of status.agents) lines.push(`- ${tag(a)}: \`${a.path}\``)
        lines.push(`- ${tag(status.checkpoints)}: \`${status.checkpoints.path}\``)
        lines.push(`- ${tag(status.claudeSnippet)}: \`${status.claudeSnippet.path}\` (snippet)`)
        console.log(lines.join('\n'))
      } else {
        const label = status.complete ? 'complete' : 'partial'
        out.info(`crew: ${label}`)
        for (const a2 of status.agents) out.info(`  ${tag(a2)}: ${a2.path}`)
        out.info(`  ${tag(status.checkpoints)}: ${status.checkpoints.path}`)
        out.info(`  ${tag(status.claudeSnippet)}: ${status.claudeSnippet.path} (snippet)`)
      }

      return { success: true, complete: status.complete, status }
    } catch (error) {
      const msg = getErrorMessage(error)
      return failHard(msg)
    }
  }

  /**
   * `prjct crew checkpoints` (no sub) → show
   * `prjct crew checkpoints set [--content | --file | <stdin>]` → write
   * `prjct crew checkpoints reset` → bundled default
   * `prjct crew checkpoints export [--file]` → snapshot (NOT authoritative)
   *
   * See spec a50b32d1 ACs #7 and #8.
   */
  async checkpoints(
    sub: string | null = null,
    projectPath: string = process.cwd(),
    options: {
      md?: boolean
      content?: string
      file?: string
    } = {}
  ): Promise<CommandResult> {
    try {
      const initResult = await this.ensureProjectInit(projectPath)
      if (!initResult.success) return initResult
      const projectId = await configManager.getProjectId(projectPath)
      if (!projectId) {
        return failHard('No prjct project. Run `prjct init` first.', options)
      }

      // Default subverb: show
      if (sub === null || sub === 'show') {
        const row = checkpointsStorage.get(projectId)
        process.stdout.write(row.content)
        return { success: true, source: row.source }
      }

      if (sub === 'set') {
        const content =
          typeof options.content === 'string' && options.content.length > 0
            ? options.content
            : typeof options.file === 'string' && options.file.length > 0
              ? await fs.readFile(path.resolve(projectPath, options.file), 'utf-8')
              : !process.stdin.isTTY
                ? await readAllStdin()
                : null
        if (content === null) {
          // Stdin is a TTY → no content piped, no flag given. Error fast
          // instead of blocking on a read that will never arrive. Exit 2.
          process.stderr.write(
            'error: no content provided; pipe to stdin, or pass --content / --file\n'
          )
          process.exitCode = 2
          return failWith('checkpoints set: no content provided', options)
        }
        if (content.length === 0) {
          return failWith('checkpoints set: content is empty', options)
        }
        const row = checkpointsStorage.set(projectId, content, 'user')
        if (options.md) console.log(`✓ checkpoints updated (source=${row.source})`)
        else out.done(`checkpoints updated (source=${row.source})`)
        return { success: true, source: row.source }
      }

      if (sub === 'reset') {
        checkpointsStorage.reset(projectId)
        if (options.md) console.log('✓ checkpoints reset to bundled default')
        else out.done('checkpoints reset to bundled default')
        return { success: true, reset: true }
      }

      if (sub === 'export') {
        const row = checkpointsStorage.get(projectId)
        const isDefault = !checkpointsStorage.hasCustomization(projectId)
        if (isDefault) {
          process.stderr.write('(exporting bundled default; no user customization set)\n')
        }
        if (typeof options.file === 'string' && options.file.length > 0) {
          const target = path.resolve(projectPath, options.file)
          await fs.mkdir(path.dirname(target), { recursive: true })
          await fs.writeFile(target, row.content, 'utf-8')
          if (options.md) console.log(`✓ exported to \`${options.file}\``)
          else out.done(`exported to ${options.file}`)
          return { success: true, exported: true, file: options.file, isDefault }
        }
        process.stdout.write(row.content)
        return { success: true, exported: true, isDefault }
      }

      return failWith(
        `Unknown crew checkpoints subverb: ${sub}. Use: show, set, reset, export.`,
        options
      )
    } catch (error) {
      return failHard(getErrorMessage(error), options)
    }
  }

  /**
   * `prjct crew record-run` — at the end of a crew flow, the leader
   * persists a single durable row capturing the implementer's summary
   * + reviewer verdict. Idempotent on caller-supplied --run-id.
   *
   * See spec a50b32d1 AC #4.
   */
  async recordRun(
    projectPath: string = process.cwd(),
    options: {
      md?: boolean
      spec?: string
      task?: string
      'implementer-summary'?: string
      files?: string
      'reviewer-verdict'?: string
      'reviewer-notes'?: string
      'run-id'?: string
    } = {}
  ): Promise<CommandResult> {
    try {
      const initResult = await this.ensureProjectInit(projectPath)
      if (!initResult.success) return initResult
      const projectId = await configManager.getProjectId(projectPath)
      if (!projectId) {
        return failHard('No prjct project. Run `prjct init` first.', options)
      }

      const summary = options['implementer-summary']
      const verdict = options['reviewer-verdict']
      const filesArg = options.files ?? ''

      if (!summary) {
        return failWith('crew record-run: --implementer-summary is required', options)
      }
      if (verdict !== 'APPROVED' && verdict !== 'CHANGES_REQUESTED') {
        return failWith(
          'crew record-run: --reviewer-verdict must be APPROVED or CHANGES_REQUESTED',
          options
        )
      }

      const filesTouched = filesArg
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0)

      const run = crewRunStorage.record(projectId, {
        runId: options['run-id'],
        specId: options.spec ?? null,
        taskId: options.task ?? null,
        implementerSummary: summary,
        filesTouched,
        reviewerVerdict: verdict,
        reviewerNotes: options['reviewer-notes'] ?? null,
      })

      if (options.md) {
        console.log(`✓ crew run recorded: run-id=${run.id}`)
      } else {
        out.done(`crew run recorded: run-id=${run.id}`)
      }
      return { success: true, runId: run.id }
    } catch (error) {
      return failHard(getErrorMessage(error), options)
    }
  }
}

async function readAllStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer))
  }
  return Buffer.concat(chunks).toString('utf-8')
}
