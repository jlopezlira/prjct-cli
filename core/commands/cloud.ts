/**
 * `prjct cloud` — control surface for the paid cloud-sync layer.
 *
 *   prjct cloud                  → status (linked? paused? pending? last sync?)
 *   prjct cloud link             → connect THIS project (requires `prjct login`)
 *   prjct cloud unlink           → disconnect THIS project (local data untouched)
 *   prjct cloud link --all       → list candidates; needs --yes to proceed
 *   prjct cloud unlink --all     → disconnect all connected; needs --yes
 *   prjct cloud link --interactive → list unconnected; one-by-one Y/n (TTY)
 *   prjct cloud projects         → list local projects + connected?
 *   prjct cloud sync | pull | pause | resume
 *
 * Public aliases (command-data):
 *   prjct connect     → cloud link (cwd)
 *   prjct disconnect  → cloud unlink (cwd)
 *
 * Local-first: nothing leaves the machine until a project is connected.
 */

import path from 'node:path'
import * as readline from 'node:readline/promises'
import { syncEventBus } from '../events/sync-events'
import configManager from '../infrastructure/config-manager'
import {
  actionableCandidates,
  type CloudProjectCandidate,
  listCloudProjectCandidates,
} from '../services/cloud-project-candidates'
import { buildProjectMeta } from '../services/sync/project-meta'
import authConfig from '../sync/auth-config'
import { addLinkedProject, removeLinkedProject } from '../sync/cloud-registry'
import { DEFAULT_INCLUDE } from '../sync/entity-map'
import realtimeManager from '../sync/realtime-manager'
import syncClient from '../sync/sync-client'
import syncManager from '../sync/sync-manager'
import type { MdOption } from '../types/cli'
import type { CommandResult } from '../types/commands'
import type { LocalConfig } from '../types/config'
import { getErrorMessage } from '../types/fs'
import { failHard, failWith } from '../utils/md-aware'
import { mdOutput } from '../utils/md-formatter'
import out from '../utils/output'
import { PrjctCommandsBase } from './base'

const SUBCOMMANDS = [
  'link',
  'unlink',
  'status',
  'sync',
  'pull',
  'pause',
  'resume',
  'projects',
  'list',
] as const

type BulkFlags = {
  all: boolean
  yes: boolean
  interactive: boolean
}

function parseBulkFlags(tokens: string[]): BulkFlags {
  return {
    all: tokens.includes('--all'),
    yes: tokens.includes('--yes') || tokens.includes('-y'),
    interactive: tokens.includes('--interactive') || tokens.includes('-i'),
  }
}

export class CloudCommands extends PrjctCommandsBase {
  /** Web/UX alias: connect project (cwd) — same as `cloud link`. */
  async connect(
    input: string | null = null,
    projectPath: string = process.cwd(),
    options: MdOption = {}
  ): Promise<CommandResult> {
    const flags = parseBulkFlags((input ?? '').trim().split(/\s+/).filter(Boolean))
    if (flags.all || flags.interactive) {
      return this.linkBulk(flags, options)
    }
    return this.link(projectPath, options)
  }

  /** Web/UX alias: disconnect project (cwd) — same as `cloud unlink`. */
  async disconnect(
    input: string | null = null,
    projectPath: string = process.cwd(),
    options: MdOption = {}
  ): Promise<CommandResult> {
    const flags = parseBulkFlags((input ?? '').trim().split(/\s+/).filter(Boolean))
    if (flags.all || flags.interactive) {
      return this.unlinkBulk(flags, options)
    }
    return this.unlink(projectPath, options)
  }

  async cloud(
    input: string | null = null,
    projectPath: string = process.cwd(),
    options: MdOption = {}
  ): Promise<CommandResult> {
    const parts = (input ?? '').trim().split(/\s+/).filter(Boolean)
    const sub = (parts[0] ?? '').toLowerCase()
    const rest = parts.slice(1)
    const flags = parseBulkFlags(rest)

    if (!sub || sub === 'status' || sub === 'show') return this.status(projectPath, options)
    switch (sub) {
      case 'link':
      case 'connect':
        if (flags.all || flags.interactive) return this.linkBulk(flags, options)
        return this.link(projectPath, options)
      case 'unlink':
      case 'disconnect':
        if (flags.all || flags.interactive) return this.unlinkBulk(flags, options)
        return this.unlink(projectPath, options)
      case 'projects':
      case 'list':
        return this.listProjects(options)
      case 'sync':
        return this.runSync(projectPath, options)
      case 'pull':
        return this.runPull(projectPath, options)
      case 'pause':
        return this.setPaused(true, projectPath, options)
      case 'resume':
        return this.setPaused(false, projectPath, options)
      default:
        return failWith(
          `Unknown cloud subcommand "${sub}". Use: ${SUBCOMMANDS.join(', ')}.`,
          options
        )
    }
  }

  /** Read the local config, or null when this isn't a prjct project. */
  private async readProject(projectPath: string): Promise<LocalConfig | null> {
    const config = await configManager.readConfig(projectPath).catch(() => null)
    return config?.projectId ? config : null
  }

  /** Opt this project into cloud sync and push an initial snapshot. */
  private async link(projectPath: string, options: MdOption): Promise<CommandResult> {
    const config = await this.readProject(projectPath)
    if (!config) return failHard('No prjct project here — run `prjct init` first.', options)
    if (!(await authConfig.hasAuth())) {
      return failHard(
        'Not authenticated. Run `prjct login`, then `prjct connect` (or `prjct cloud link`).',
        options
      )
    }

    const linkedCloud = {
      enabled: true,
      paused: false,
      linkedAt: config.cloud?.linkedAt ?? new Date().toISOString(),
      include: config.cloud?.include,
    }
    const meta = await buildProjectMeta(config.projectId).catch(() => undefined)
    const link = await syncClient.linkProject(config.projectId, path.basename(projectPath), meta)
    config.cloud = linkedCloud
    await configManager.writeConfig(projectPath, config)

    if (link.syncStatus === 'active') {
      await addLinkedProject(config.projectId, projectPath)
      await realtimeManager.start(config.projectId, projectPath).catch(() => undefined)
      const result = await syncManager.sync(config.projectId, {
        include: config.cloud.include ?? {},
      })
      return this.reportSync('Connected', result, options, {
        extra:
          'Project is now connected. It will also sync on `prjct ship` and at session end. Disconnect with `prjct disconnect`.',
      })
    }

    return this.subscriptionRequired(link.message, options, {
      title:
        link.syncStatus === 'payment_pending'
          ? 'Cloud sync waiting for payment'
          : 'Cloud sync waiting for subscription',
      prefix: `Repo connected to your prjct account. Billing: ${link.billingUrl}`,
    })
  }

  /** Detach from cloud — local DB is untouched. Soft: cloud records kept. */
  private async unlink(projectPath: string, options: MdOption): Promise<CommandResult> {
    const config = await this.readProject(projectPath)
    if (!config) return failHard('No prjct project here — run `prjct init` first.', options)
    if (!config.cloud?.enabled) {
      const msg = 'Already local-only — nothing to disconnect.'
      console.log(options.md ? mdOutput('## Cloud', `> ${msg}`) : msg)
      return { success: true, linked: false }
    }
    config.cloud = { ...config.cloud, enabled: false, paused: false }
    await configManager.writeConfig(projectPath, config)
    realtimeManager.stop(config.projectId)
    await removeLinkedProject(config.projectId)
    await syncClient.setCloudLifecycle(config.projectId, 'unlink').catch(() => undefined)
    const msg =
      'Disconnected — this project is local-only again. Cloud history kept; local data untouched. Re-connect with `prjct connect`.'
    if (options.md) console.log(mdOutput('## Cloud', `> ${msg}`))
    else out.done(msg)
    return { success: true, linked: false }
  }

  private async listProjects(options: MdOption): Promise<CommandResult> {
    const list = await listCloudProjectCandidates()
    if (list.length === 0) {
      const msg =
        'No local prjct projects found. Run `prjct sync` inside a git repo, then `prjct connect`.'
      if (options.md) console.log(mdOutput('## Cloud projects', `> ${msg}`))
      else out.info(msg)
      return { success: true, projects: [] }
    }
    const lines = list.map((c) => {
      const state = c.connected ? (c.paused ? 'connected,paused' : 'connected') : 'local-only'
      const p = c.projectPath ?? '(path unknown)'
      return `- **${c.name}** · ${state} · \`${p}\` · \`${c.projectId.slice(0, 8)}\``
    })
    if (options.md) {
      console.log(
        mdOutput('## Cloud projects', `> ${list.length} local project(s)`, lines.join('\n'))
      )
    } else {
      out.info(`Cloud projects (${list.length})`)
      for (const c of list) {
        const state = c.connected ? (c.paused ? 'connected · paused' : 'connected') : 'local-only'
        out.info(`  ${c.name.padEnd(24)} ${state.padEnd(18)} ${c.projectPath ?? '(path unknown)'}`)
      }
      out.info('Connect: prjct connect | Disconnect: prjct disconnect | Bulk: … --all --yes')
    }
    return {
      success: true,
      projects: list.map((c) => ({
        projectId: c.projectId,
        name: c.name,
        path: c.projectPath,
        connected: c.connected,
        paused: c.paused,
      })),
    }
  }

  private async linkBulk(flags: BulkFlags, options: MdOption): Promise<CommandResult> {
    if (!(await authConfig.hasAuth())) {
      return failHard('Not authenticated. Run `prjct login` first.', options)
    }
    const all = await listCloudProjectCandidates()
    const availableTargets = actionableCandidates(all, 'connect')
    if (availableTargets.length === 0) {
      const msg =
        'No unconnected projects with a known path. Open each repo and run `prjct connect`, or `prjct sync` first so paths are recorded.'
      if (options.md) console.log(mdOutput('## Connect', `> ${msg}`))
      else out.info(msg)
      return { success: true, connected: 0, skipped: 0 }
    }

    const targets =
      flags.interactive && !flags.all
        ? await this.pickInteractively(availableTargets, 'connect', options)
        : availableTargets
    if (targets === null) {
      return failWith(
        'No TTY for one-by-one prompts. Confirm with the human, then run `prjct cloud link --all --yes`, or `cd <path> && prjct connect` per project.',
        options
      )
    }
    if (flags.interactive && !flags.all) {
      const picked = targets
      if (picked.length === 0) {
        const msg = 'No projects selected.'
        if (options.md) console.log(mdOutput('## Connect', `> ${msg}`))
        else out.info(msg)
        return { success: true, connected: 0 }
      }
    } else {
      // --all (or interactive+all): require --yes unless already confirmed via interactive
      const ok = await this.confirmBulk(
        `Connect ${targets.length} project(s) to Cloud Sync?`,
        targets,
        flags.yes,
        options
      )
      if (!ok) {
        return failWith(
          `Would connect ${targets.length} project(s). Confirm with the human, then re-run with --yes.`,
          options
        )
      }
    }

    return this.runBulk(targets, 'connect', options)
  }

  private async unlinkBulk(flags: BulkFlags, options: MdOption): Promise<CommandResult> {
    const all = await listCloudProjectCandidates()
    const availableTargets = actionableCandidates(all, 'disconnect')
    if (availableTargets.length === 0) {
      const msg = 'No connected projects with a known path to disconnect.'
      if (options.md) console.log(mdOutput('## Disconnect', `> ${msg}`))
      else out.info(msg)
      return { success: true, disconnected: 0 }
    }

    const targets =
      flags.interactive && !flags.all
        ? await this.pickInteractively(availableTargets, 'disconnect', options)
        : availableTargets
    if (targets === null) {
      return failWith(
        'No TTY for one-by-one prompts. Confirm with the human, then run `prjct cloud unlink --all --yes`, or `cd <path> && prjct disconnect` per project.',
        options
      )
    }
    if (flags.interactive && !flags.all) {
      const picked = targets
      if (picked.length === 0) {
        const msg = 'No projects selected.'
        if (options.md) console.log(mdOutput('## Disconnect', `> ${msg}`))
        else out.info(msg)
        return { success: true, disconnected: 0 }
      }
    } else {
      const ok = await this.confirmBulk(
        `Disconnect ${targets.length} project(s)? Cloud history kept; local vaults untouched.`,
        targets,
        flags.yes,
        options
      )
      if (!ok) {
        return failWith(
          `Would disconnect ${targets.length} project(s). Confirm with the human, then re-run with --yes.`,
          options
        )
      }
    }

    return this.runBulk(targets, 'disconnect', options)
  }

  private async runBulk(
    targets: CloudProjectCandidate[],
    mode: 'connect' | 'disconnect',
    options: MdOption
  ): Promise<CommandResult> {
    const succeeded: CloudProjectCandidate[] = []
    const failed: CloudProjectCandidate[] = []
    const errors: string[] = []
    for (const t of targets) {
      if (!t.projectPath) continue
      const res =
        mode === 'connect'
          ? await this.link(t.projectPath, { ...options, md: true })
          : await this.unlink(t.projectPath, { ...options, md: true })
      if (res.success || (mode === 'connect' && res.paymentRequired)) {
        succeeded.push(t)
        if (!options.md) {
          out.done(
            `${mode === 'connect' ? 'Connected' : 'Disconnected'}: ${t.name} (${t.projectPath})`
          )
        }
      } else {
        failed.push(t)
        errors.push(`${t.name}: ${res.error ?? res.message ?? 'failed'}`)
        if (!options.md) out.warn(`Failed: ${t.name} — ${res.error ?? res.message ?? 'failed'}`)
      }
    }
    const label = mode === 'connect' ? 'Connected' : 'Disconnected'
    const summary = `${label} ${succeeded.length} project(s)${failed.length ? ` · ${failed.length} failed` : ''}.`
    if (options.md) {
      console.log(
        mdOutput(
          `## Cloud ${mode}`,
          `> ${summary}`,
          ...(errors.length ? [errors.map((e) => `- ${e}`).join('\n')] : [])
        )
      )
    } else {
      out.done(summary)
    }
    return {
      success: failed.length === 0,
      [mode === 'connect' ? 'connected' : 'disconnected']: succeeded.length,
      failed: failed.length,
      errors,
    }
  }

  /** Returns selected list, empty if none chosen, null if no TTY. */
  private async pickInteractively(
    targets: CloudProjectCandidate[],
    mode: 'connect' | 'disconnect',
    options: MdOption
  ): Promise<CloudProjectCandidate[] | null> {
    if (!process.stdin.isTTY || !process.stdout.isTTY) return null
    if (!options.md) {
      out.info(
        mode === 'connect'
          ? 'Connect projects one by one (y/N). Local data never leaves until you say yes.'
          : 'Disconnect projects one by one (y/N). Cloud history kept; local vault untouched.'
      )
    }
    const selected: CloudProjectCandidate[] = []
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
    try {
      for (const t of targets) {
        const q = `${mode === 'connect' ? 'Connect' : 'Disconnect'} ${t.name} (${t.projectPath})? [y/N] `
        const ans = (await rl.question(q)).trim().toLowerCase()
        if (ans === 'y' || ans === 'yes') selected.push(t)
      }
    } finally {
      rl.close()
    }
    return selected
  }

  private async confirmBulk(
    title: string,
    targets: CloudProjectCandidate[],
    yes: boolean,
    options: MdOption
  ): Promise<boolean> {
    if (yes) return true
    const lines = targets.map((t) => `  - ${t.name}: ${t.projectPath}`)
    if (options.md) {
      console.log(mdOutput('## Confirm', `> ${title}`, lines.join('\n')))
    } else {
      out.info(title)
      for (const line of lines) out.info(line)
    }
    if (!process.stdin.isTTY || !process.stdout.isTTY) return false
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
    try {
      const ans = (await rl.question('Proceed? [y/N] ')).trim().toLowerCase()
      return ans === 'y' || ans === 'yes'
    } finally {
      rl.close()
    }
  }

  /** Manual push + pull. */
  private async runSync(projectPath: string, options: MdOption): Promise<CommandResult> {
    const config = await this.readProject(projectPath)
    if (!config) return failHard('No prjct project here — run `prjct init` first.', options)
    const gate = this.gate(config, options)
    if (gate) return gate
    const result = await syncManager.sync(config.projectId, {
      include: config.cloud?.include ?? {},
    })
    return this.reportSync('Synced', result, options)
  }

  /** Pull-only — the move for a fresh second machine. */
  private async runPull(projectPath: string, options: MdOption): Promise<CommandResult> {
    const config = await this.readProject(projectPath)
    if (!config) return failHard('No prjct project here — run `prjct init` first.', options)
    const gate = this.gate(config, options)
    if (gate) return gate
    try {
      const result = await syncManager.pull(config.projectId)
      if (!result.success) {
        if (result.code === 'PAYMENT_REQUIRED')
          return this.subscriptionRequired(result.error, options)
        return failWith(`Pull failed: ${result.error ?? 'unknown error'}`, options)
      }
      const msg = `Pulled ${result.count ?? 0} change(s) (${result.applied ?? 0} applied).`
      if (options.md) console.log(mdOutput('## Cloud pull', `> ${msg}`))
      else out.done(msg)
      return { success: true, pulled: result.count ?? 0, applied: result.applied ?? 0 }
    } catch (error) {
      return failHard(getErrorMessage(error), options)
    }
  }

  /** Pause/resume without disconnecting. */
  private async setPaused(
    paused: boolean,
    projectPath: string,
    options: MdOption
  ): Promise<CommandResult> {
    const config = await this.readProject(projectPath)
    if (!config) return failHard('No prjct project here — run `prjct init` first.', options)
    if (!config.cloud?.enabled) {
      return failWith(
        'Not connected — nothing to pause/resume. Run `prjct connect` first.',
        options
      )
    }
    config.cloud = { ...config.cloud, paused }
    await configManager.writeConfig(projectPath, config)
    if (paused) realtimeManager.stop(config.projectId)
    else await realtimeManager.start(config.projectId, projectPath).catch(() => undefined)
    await syncClient
      .setCloudLifecycle(config.projectId, paused ? 'pause' : 'resume')
      .catch(() => undefined)
    const msg = paused
      ? 'Cloud sync paused (still connected). Resume with `prjct cloud resume`. Disconnect with `prjct disconnect`.'
      : 'Cloud sync resumed.'
    if (options.md) console.log(mdOutput('## Cloud', `> ${msg}`))
    else out.done(msg)
    return { success: true, paused }
  }

  private async status(projectPath: string, options: MdOption): Promise<CommandResult> {
    const config = await this.readProject(projectPath)
    if (!config) return failHard('No prjct project here — run `prjct init` first.', options)

    const authed = await authConfig.hasAuth()
    const cloud = config.cloud
    const linked = !!cloud?.enabled
    const paused = !!cloud?.paused
    const pending = (await syncEventBus.getPending(config.projectId)).length
    const lastSync = await syncEventBus.getLastSync(config.projectId)
    const include = { ...DEFAULT_INCLUDE, ...(cloud?.include ?? {}) }
    const onGroups = Object.entries(include)
      .filter(([, v]) => v)
      .map(([k]) => k)

    const state = !authed
      ? 'not authenticated (run `prjct login`)'
      : !linked
        ? 'local-only (run `prjct connect`)'
        : paused
          ? 'connected, paused'
          : 'connected, active'

    const realtime = !linked
      ? 'n/a'
      : realtimeManager.available()
        ? realtimeManager.status(config.projectId)
        : 'requires daemon'

    if (options.md) {
      console.log(
        mdOutput(
          '## Cloud status',
          `> **State**: ${state}`,
          [
            `- Authenticated: ${authed ? 'yes' : 'no'}`,
            `- Connected: ${linked ? 'yes' : 'no'}${cloud?.linkedAt ? ` (since ${cloud.linkedAt})` : ''}`,
            `- Realtime: ${realtime}`,
            `- Pending events: ${pending}`,
            `- Last sync: ${lastSync?.timestamp ?? 'never'}`,
            `- Syncing groups: ${onGroups.join(', ')}`,
          ].join('\n')
        )
      )
    } else {
      out.info(
        [
          `Cloud — ${state}`,
          `  Authenticated: ${authed ? 'yes' : 'no'}`,
          `  Connected: ${linked ? 'yes' : 'no'}${cloud?.linkedAt ? ` (since ${cloud.linkedAt})` : ''}`,
          `  Realtime: ${realtime}`,
          `  Pending events: ${pending}`,
          `  Last sync: ${lastSync?.timestamp ?? 'never'}`,
          `  Syncing groups: ${onGroups.join(', ')}`,
        ].join('\n')
      )
    }
    return { success: true, linked, paused, authed, pending, realtime }
  }

  private gate(config: LocalConfig, options: MdOption): CommandResult | null {
    if (!config.cloud?.enabled) {
      return failWith('This project is not connected. Run `prjct connect` first.', options)
    }
    if (config.cloud.paused) {
      return failWith('Cloud sync is paused. Run `prjct cloud resume` first.', options)
    }
    return null
  }

  private subscriptionRequired(
    reason: string | undefined,
    options: MdOption,
    opts?: { title?: string; prefix?: string }
  ): CommandResult {
    const msg =
      reason ??
      'Cloud sync needs an active prjct subscription. Your local data is safe — only cloud backup is paused.'
    if (options.md) {
      console.log(
        mdOutput(
          `## ${opts?.title ?? 'Subscription required'}`,
          `> 💳 ${opts?.prefix ? `${opts.prefix}\n\n${msg}` : msg}`
        )
      )
    } else {
      out.warn(opts?.title ?? 'Cloud backup paused — subscription required')
      if (opts?.prefix) out.info(opts.prefix)
      out.info(msg)
    }
    return { success: false, paymentRequired: true, message: msg }
  }

  private reportSync(
    label: string,
    result: Awaited<ReturnType<typeof syncManager.sync>>,
    options: MdOption,
    opts?: { extra?: string }
  ): CommandResult {
    if (!result.success) {
      if (result.code === 'PAYMENT_REQUIRED')
        return this.subscriptionRequired(result.error, options)
      return failWith(`${label} with errors: ${result.error ?? 'unknown error'}`, options)
    }
    const pushed = result.pushed?.count ?? 0
    const pulled = result.pulled?.count ?? 0
    const msg = `${label} — ${pushed} pushed, ${pulled} pulled.`
    if (options.md) {
      console.log(mdOutput('## Cloud', `> ${msg}`, ...(opts?.extra ? [opts.extra] : [])))
    } else {
      out.done(msg)
      if (opts?.extra) out.info(opts.extra)
    }
    return { success: true, pushed, pulled }
  }
}
