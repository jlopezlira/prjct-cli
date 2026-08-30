/**
 * prjct crew — install/uninstall/status the crew-mode bundle.
 *
 * Crew state is stored entirely in the project SQLite kv_store (key
 * `crew:state`). No agent-facing files (`.claude/agents/`, `CLAUDE.md`,
 * `CREW.md`) are ever written into the client repository. Strictly opt-in.
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
import { type CrewState, crewStateStorage } from '../storage/crew-state-storage'
import type { MdOption } from '../types/cli'
import type { CommandResult } from '../types/commands'
import { getErrorMessage } from '../types/fs'
import { failHard, failWith } from '../utils/md-aware'
import out from '../utils/output'
import { PrjctCommandsBase } from './base'

const CHECKPOINTS_START =
  '<!-- prjct:checkpoints:start - DO NOT EDIT (managed by `prjct crew checkpoints set|reset`) -->'
const CHECKPOINTS_END = '<!-- prjct:checkpoints:end -->'

/**
 * Splice the current checkpoints content into the reviewer agent
 * template between the marker pair. Anchored regex — refuses to build
 * the agent if markers are missing or duplicated (defensive against
 * template drift). Content outside the markers is preserved verbatim.
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

interface CrewAgentFile {
  /** Path inside the templates/crew/ tree */
  templateKey: string
  /** Agent name as stored in the crew state row */
  name: 'leader' | 'implementer' | 'reviewer'
}

// Native agent templates — derived from CREW_ROLES so the native crew,
// the emulated protocol, and the model policy can never drift apart.
const AGENT_FILES: CrewAgentFile[] = CREW_ROLES.map((r) => ({
  templateKey: `crew/roles/${r.name}.md`,
  name: r.name as 'leader' | 'implementer' | 'reviewer',
}))

const CREW_AGENT_ROLES: Record<string, AgentRole> = Object.fromEntries(
  CREW_ROLES.map((r) => [r.name, r.role])
)

/**
 * Strip any `model:` frontmatter from a crew agent at install time so the
 * subagent inherits whatever model the user is driving. prjct does not pick
 * models for roles — see `core/schemas/model.ts`. No-op for a name that maps
 * to no crew role, or a template with no `model:` line.
 *
 * Keyed on the role NAME, not a `.claude/agents/<name>.md` path: crew state
 * lives in SQLite and prjct writes no agent files into the client repo, so a
 * path here would only be a fiction a future reader could mistake for one.
 */
export function stripCrewModelPin(content: string, roleName: string): string {
  if (!CREW_AGENT_ROLES[roleName]) return content
  return content.replace(/^model:[ \t].*(?:\r?\n)?/m, '')
}

async function readTemplate(key: string): Promise<string> {
  const content = getTemplateContent(key)
  if (!content) {
    throw new Error(`Missing crew template: ${key}`)
  }
  return content
}

async function buildNativeAgents(
  checkpointsContent: string
): Promise<Record<'leader' | 'implementer' | 'reviewer', string>> {
  const agents: Partial<Record<'leader' | 'implementer' | 'reviewer', string>> = {}
  for (const f of AGENT_FILES) {
    const template = await readTemplate(f.templateKey)
    const content =
      f.name === 'reviewer' ? spliceCheckpoints(template, checkpointsContent) : template
    agents[f.name] = stripCrewModelPin(content, f.name)
  }
  return agents as Record<'leader' | 'implementer' | 'reviewer', string>
}

interface CrewStatus {
  state: CrewState | null
  checkpoints: { path: string; installed: boolean }
  complete: boolean
}

async function getStatus(projectPath: string): Promise<CrewStatus> {
  const state = await (async (): Promise<CrewState | null> => {
    try {
      const projectId = await configManager.getProjectId(projectPath)
      if (!projectId) return null
      return crewStateStorage.get(projectId)
    } catch {
      return null
    }
  })()

  const checkpointsInstalled = await (async (): Promise<boolean> => {
    try {
      const projectId = await configManager.getProjectId(projectPath)
      if (!projectId) return false
      // get() always returns something (bundled default fallback), so
      // installed == a project exists with the row available.
      checkpointsStorage.get(projectId)
      return true
    } catch {
      return false
    }
  })()

  const complete = state?.enabled === true && checkpointsInstalled

  return {
    state,
    checkpoints: { path: 'kv_store[crew:checkpoints]', installed: checkpointsInstalled },
    complete,
  }
}

export class CrewCommands extends PrjctCommandsBase {
  /**
   * `prjct crew install` — persist crew state to the project kv_store.
   *
   * No files are written into the client repository. Native (Claude) rigs
   * store generated agent contents in the state row; emulated rigs store the
   * emulated protocol string. A future global hook can print/inject these
   * without touching the repo.
   */
  async install(
    _arg: string | null = null,
    projectPath: string = process.cwd(),
    options: MdOption = {}
  ): Promise<CommandResult> {
    try {
      const initResult = await this.ensureProjectInit(projectPath)
      if (!initResult.success) return initResult
      const projectId = await configManager.getProjectId(projectPath)
      if (!projectId) {
        return failHard('No prjct project. Run `prjct init` first.', options)
      }

      const checkpointsRow = checkpointsStorage.get(projectId)
      const mechanism = await resolveDispatchMechanism()

      const baseState: CrewState = {
        enabled: true,
        mechanism: mechanism.native ? 'native' : 'emulated',
        provider: mechanism.provider,
        installedAt: new Date().toISOString(),
      }

      // Native and emulated differ only in which payload the row carries;
      // build the finished row per branch so `state` stays const.
      const { state, writtenLabel } = mechanism.native
        ? {
            state: {
              ...baseState,
              agents: await buildNativeAgents(checkpointsRow.content),
            } as CrewState,
            writtenLabel: 'crew:state with native agent contents',
          }
        : {
            state: {
              ...baseState,
              emulatedProtocol: buildEmulatedCrewProtocol(mechanism, checkpointsRow.content),
            } as CrewState,
            writtenLabel: 'crew:state with emulated protocol',
          }

      crewStateStorage.set(projectId, state)

      const mechanismLabel = mechanism.native
        ? `native (${mechanism.provider})`
        : `emulated (${mechanism.provider})`
      const note = `crew installed (${mechanismLabel}). State stored in project SQLite; no files were written to the repository.`

      if (options.md) {
        console.log(
          [
            '# prjct crew installed',
            '',
            note,
            '',
            '## Stored',
            `- \`${writtenLabel}\` in kv_store`,
            '- Checkpoints remain in `kv_store[crew:checkpoints]`',
          ].join('\n')
        )
      } else {
        out.done(note)
      }

      return { success: true, written: [writtenLabel], skipped: [] }
    } catch (error) {
      const msg = getErrorMessage(error)
      return failHard(msg)
    }
  }

  /**
   * `prjct crew uninstall` — remove crew state from the project kv_store
   * and reset crew-specific data. No client-repo files are touched.
   */
  async uninstall(
    _arg: string | null = null,
    projectPath: string = process.cwd(),
    options: MdOption = {}
  ): Promise<CommandResult> {
    try {
      const projectId = await configManager.getProjectId(projectPath)
      if (!projectId) {
        const note = 'No prjct project; nothing to uninstall.'
        if (options.md) {
          console.log(`# prjct crew uninstalled\n\n${note}`)
        } else {
          out.done(note)
        }
        return { success: true, removed: [], missing: [] }
      }

      const removed: string[] = []
      const missing: string[] = []

      const hadState = crewStateStorage.get(projectId) !== null
      if (hadState) {
        crewStateStorage.clear(projectId)
        removed.push('crew:state (SQLite)')
      } else {
        missing.push('crew:state (SQLite)')
      }

      // Only reset checkpoints when crew was actually installed. Resetting
      // unconditionally would silently discard a `crew checkpoints set`
      // customization on a project that never had crew mode at all.
      if (hadState && checkpointsStorage.hasCustomization(projectId)) {
        checkpointsStorage.reset(projectId)
        removed.push('kv_store[crew:checkpoints] reset')
      } else {
        missing.push('kv_store[crew:checkpoints] (already default)')
      }

      // An older prjct wrote crew files into the repo. Uninstall is when the
      // user most wants them gone, but they are not ours to delete — name
      // them so "uninstalled" does not read as "nothing left behind".
      const { scanLegacyRepoCrewFiles, formatLegacyRepoCrewLine } = await import(
        '../services/legacy-repo-crew-scan'
      )
      const legacy = await scanLegacyRepoCrewFiles(projectPath)
      const legacyLine = formatLegacyRepoCrewLine(legacy)

      const summary = `crew uninstalled (${removed.length} removed)`
      if (options.md) {
        const lines = ['# prjct crew uninstalled', '', summary, '', '## Removed']
        for (const f2 of removed) lines.push(`- ${f2}`)
        for (const f3 of missing) lines.push(`- not present: \`${f3}\``)
        if (legacyLine !== null) lines.push('', '## Left in your repo', `- ${legacyLine}`)
        console.log(lines.join('\n'))
      } else {
        out.done(summary)
        for (const f4 of removed) out.info(`removed: ${f4}`)
        if (legacyLine !== null) out.warn(legacyLine)
      }

      return { success: true, removed, missing, legacyRepoFiles: legacy.staleFiles }
    } catch (error) {
      const msg = getErrorMessage(error)
      return failHard(msg)
    }
  }

  /**
   * `prjct crew status` — report crew state from the project kv_store.
   */
  async status(
    _arg: string | null = null,
    projectPath: string = process.cwd(),
    options: MdOption = {}
  ): Promise<CommandResult> {
    try {
      const status = await getStatus(projectPath)
      const tag = (installed: boolean) => (installed ? 'installed' : 'missing')

      if (options.md) {
        const lines = [
          '# prjct crew status',
          '',
          `Project: \`${projectPath}\``,
          `Complete: **${status.complete ? 'yes' : 'no'}**`,
          '',
          '## State',
        ]
        if (status.state) {
          lines.push(`- enabled: **${status.state.enabled}**`)
          lines.push(`- mechanism: \`${status.state.mechanism}\``)
          lines.push(`- provider: \`${status.state.provider ?? 'unknown'}\``)
          lines.push(`- installedAt: \`${status.state.installedAt}\``)
        } else {
          lines.push('- _no crew:state row — crew is not installed_')
        }
        lines.push(`- ${tag(status.checkpoints.installed)}: \`${status.checkpoints.path}\``)
        console.log(lines.join('\n'))
      } else {
        const label = status.complete ? 'complete' : 'partial'
        out.info(`crew: ${label}`)
        if (status.state) {
          out.info(`  enabled: ${status.state.enabled}`)
          out.info(`  mechanism: ${status.state.mechanism}`)
          out.info(`  provider: ${status.state.provider ?? 'unknown'}`)
          out.info(`  installedAt: ${status.state.installedAt}`)
        } else {
          out.info('  crew:state: missing')
        }
        out.info(`  ${tag(status.checkpoints.installed)}: ${status.checkpoints.path}`)
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
          const rel = path.relative(projectPath, target)
          const insideProject = !rel.startsWith('..') && !path.isAbsolute(rel)
          if (insideProject) {
            return failWith(
              'prjct never writes files into the client repository. Pass an absolute path outside the project or omit --file to print to stdout.',
              options
            )
          }
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
