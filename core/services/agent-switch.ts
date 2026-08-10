/**
 * Agent switch / accept — realtime multi-agent yield on the same work cycle.
 *
 * Doctrine: prjct owns the Body (SQLite handoff + task owner), never the host
 * loop. Switch records who yielded and why; accept rebinds ownership; hooks
 * inject pending handoffs; optional `--launch` spawns the target CLI.
 */

import { spawn } from 'node:child_process'
import { Providers } from '../infrastructure/ai-provider'
import configManager from '../infrastructure/config-manager'
import { prjctDb } from '../storage/database'
import {
  acceptHandoff,
  createHandoff,
  getHandoff,
  type HandoffEvidence,
  listHandoffs,
  listPendingForAgent,
  type TaskHandoff,
} from '../storage/handoff-storage'
import { stateStorage } from '../storage/state-storage'
import type { AIProviderName } from '../types/provider'
import { effectiveNotifyMode, notifyDesktop } from '../utils/notify'
import { whichAsync } from '../utils/which'
import {
  type AgentIdentity,
  detectRuntimeAgent,
  normalizeAgentName,
  resolveCallerIdentity,
} from './agent-identity'
import { contextPressureVerdict } from './context-pressure'
import { synthesizeLandHandoff } from './land-synthesis'
import { loopGuardVerdict } from './loop-guard'
import { resolveActiveTask } from './task-service'
import { deriveWorkspace, MAIN_WORKSPACE_ID } from './workspace-id'

export interface SwitchOptions {
  reason?: string
  launch?: boolean
  md?: boolean
}

export interface SwitchResult {
  ok: boolean
  error?: string
  handoff?: TaskHandoff
  resumeCard?: string
  launched?: boolean
  launchError?: string
}

export interface AcceptResult {
  ok: boolean
  error?: string
  handoff?: TaskHandoff
  brief?: string
}

async function buildEvidence(
  projectId: string,
  projectPath: string,
  taskId: string,
  startedAt?: string
): Promise<HandoffEvidence> {
  const cfg = await configManager.readConfig(projectPath).catch(() => null)
  const task = await resolveActiveTask(projectId, projectPath).catch(() => null)
  const turns = task?.turnCount ?? 0
  const loop = loopGuardVerdict(cfg, task)
  const pressure = contextPressureVerdict(cfg, task)

  const files: string[] = (() => {
    try {
      if (!startedAt) return []
      const rows = prjctDb.query<{ file: string }>(
        projectId,
        `SELECT DISTINCT json_extract(data, '$.file') AS file
         FROM events
         WHERE type = 'memory.post_edit' AND timestamp >= ?
         LIMIT 20`,
        startedAt
      )
      return rows.map((r) => r.file).filter(Boolean)
    } catch {
      return []
    }
  })()

  const journal: string[] = (() => {
    try {
      const rows = prjctDb.query<{ content: string }>(
        projectId,
        `SELECT content FROM task_log WHERE task_id = ? ORDER BY id DESC LIMIT 5`,
        taskId
      )
      return rows.map((r) => r.content).filter(Boolean)
    } catch {
      return []
    }
  })()

  return {
    turns,
    files,
    pressure: pressure.level !== 'ok' ? pressure.level : undefined,
    loopStopped: loop.stopped || undefined,
    journal: journal.length > 0 ? journal : undefined,
  }
}

function composeReason(
  explicit: string | undefined,
  evidence: HandoffEvidence,
  taskDescription: string
): string {
  const trimmed = explicit?.trim()
  if (trimmed) return trimmed.slice(0, 500)

  const parts: string[] = [`Yielded cycle "${taskDescription.slice(0, 80)}"`]
  if (evidence.turns && evidence.turns > 0) parts.push(`after ${evidence.turns} turns`)
  if (evidence.loopStopped) parts.push('loop-guard stopped')
  if (evidence.pressure) parts.push(`context pressure ${evidence.pressure}`)
  if (evidence.files && evidence.files.length > 0) {
    parts.push(`files: ${evidence.files.slice(0, 5).join(', ')}`)
  }
  parts.push('— continue from current branch state; do not restart from zero')
  return parts.join(' ').slice(0, 500)
}

function formatResumeCard(h: TaskHandoff): string {
  const who = [h.fromAgent, h.fromIdentity].filter(Boolean).join('/')
  return [
    `# prjct handoff → ${h.toAgent}`,
    '',
    `Task: \`${h.taskId}\` — ${h.taskDescription}`,
    `From: ${who} · handoff \`${h.id}\``,
    `Reason: ${h.reason}`,
    h.branch ? `Branch: \`${h.branch}\`` : null,
    h.worktreePath ? `Path: \`${h.worktreePath}\`` : null,
    '',
    '## Accept (target agent)',
    '',
    '```bash',
    `cd ${h.worktreePath ?? '.'}`,
    `prjct accept ${h.id} --md`,
    '```',
    '',
    'Then continue the cycle — do not start a new `prjct work` for the same intent.',
  ]
    .filter((l) => l !== null)
    .join('\n')
}

function formatAcceptBrief(h: TaskHandoff, accepter: AgentIdentity): string {
  const who = [h.fromAgent, h.fromIdentity].filter(Boolean).join('/')
  const ev = h.evidence
  const lines = [
    `# Handoff accepted — ${h.taskDescription}`,
    '',
    `- Task id: \`${h.taskId}\``,
    `- Handoff: \`${h.id}\``,
    `- Started by: ${who}`,
    `- Accepted by: ${accepter.agent}/${accepter.identity}`,
    `- Why yielded: ${h.reason}`,
  ]
  if (ev?.turns) lines.push(`- Turns spent: ${ev.turns}`)
  if (ev?.pressure) lines.push(`- Context pressure: ${ev.pressure}`)
  if (ev?.files && ev.files.length > 0) {
    lines.push(
      `- Hot files: ${ev.files
        .slice(0, 8)
        .map((f) => `\`${f}\``)
        .join(', ')}`
    )
  }
  if (ev?.journal && ev.journal.length > 0) {
    lines.push('', '## Prior journal', ...ev.journal.map((j) => `- ${j.slice(0, 120)}`))
  }
  lines.push(
    '',
    '## Next',
    '',
    '1. `prjct work --md` — same cycle is still active (now yours)',
    '2. Read hot files + `prjct guard <file>` before editing',
    '3. Continue implementation — do **not** restart from zero'
  )
  return lines.join('\n')
}

async function rebindTaskOwner(
  projectId: string,
  projectPath: string,
  fields: {
    ownerAgent?: string
    ownerIdentity?: string
    ownerSessionId?: string
    yieldStatus?: 'active' | 'yielded'
    /** null clears the pending handoff id */
    pendingHandoffId?: string | null
  }
): Promise<void> {
  const ws = await deriveWorkspace(projectPath)
  if (ws.gitError) {
    // Degraded identity — writing task fields keyed on the main fallback
    // could corrupt another workspace's cycle. Refuse loudly.
    throw new Error(
      `git ${ws.gitError}: workspace identity unknown — refusing to update task fields on the main fallback.`
    )
  }
  // null → delete key inside updateCurrentTask / updateWorkspaceTask
  const patch = fields as Partial<import('../schemas/state').CurrentTask> & Record<string, unknown>

  if (ws.isMain) {
    await stateStorage.updateCurrentTask(projectId, patch)
  } else {
    await stateStorage.updateWorkspaceTask(projectId, ws.workspaceId, patch)
  }
}

/**
 * Yield the current work cycle to another agent runtime.
 */
export async function switchAgent(
  projectId: string,
  projectPath: string,
  targetRaw: string,
  options: SwitchOptions = {}
): Promise<SwitchResult> {
  const toAgent = normalizeAgentName(targetRaw)
  if (!toAgent) {
    return { ok: false, error: 'Usage: prjct switch <agent> [--reason "…"] [--launch]' }
  }

  const task = await resolveActiveTask(projectId, projectPath)
  if (!task) {
    return {
      ok: false,
      error:
        'No active work cycle in this workspace. Start one with `prjct work "<intent>"` first.',
    }
  }

  const caller = resolveCallerIdentity(task.description)
  const fromAgent = task.ownerAgent || caller.agent
  const fromIdentity = task.ownerIdentity || caller.identity

  const ws = await deriveWorkspace(projectPath)
  if (ws.gitError) {
    return {
      ok: false,
      error: `git ${ws.gitError}: workspace identity unknown — refusing to switch agents on the main fallback. Re-run when git is healthy.`,
    }
  }
  const cfg = await configManager.readConfig(projectPath).catch(() => null)
  const evidence = await buildEvidence(projectId, projectPath, task.id, task.startedAt)
  const reason = composeReason(options.reason, evidence, task.description)
  const ttl = cfg?.multiAgent?.handoffTtlHours ?? 24

  const handoff = createHandoff({
    projectId,
    taskId: task.id,
    taskDescription: task.description,
    fromAgent,
    fromIdentity,
    toAgent,
    reason,
    evidence,
    workspaceId: ws.isMain ? MAIN_WORKSPACE_ID : ws.workspaceId,
    worktreePath: ws.worktreePath,
    branch: ws.branch ?? task.branch,
    ttlHours: ttl,
  })

  await rebindTaskOwner(projectId, projectPath, {
    yieldStatus: 'yielded',
    pendingHandoffId: handoff.id,
    // Keep original owner until accept — receivers need "who started"
  })

  // Land snapshot so the next agent has living context without a paste novel.
  try {
    await synthesizeLandHandoff({
      projectId,
      projectPath,
      cycleDescription: task.description,
      cycleId: task.id,
      author: fromIdentity,
    })
  } catch {
    /* land is best-effort */
  }

  try {
    prjctDb.appendEvent(projectId, 'task.handoff.yielded', {
      handoffId: handoff.id,
      taskId: task.id,
      fromAgent,
      toAgent,
      reason,
    })
  } catch {
    /* events best-effort */
  }

  // Desktop notify (L2)
  if (effectiveNotifyMode(cfg) === 'on') {
    await notifyDesktop(
      `prjct → ${toAgent}`,
      `Handoff: ${task.description.slice(0, 80)} — prjct accept ${handoff.id.slice(0, 16)}`
    )
  }

  const resumeCard = formatResumeCard(handoff)
  const wantLaunch = options.launch === true || cfg?.multiAgent?.switchLaunch === true
  const launch = wantLaunch
    ? await launchTargetAgent(toAgent, handoff, ws.worktreePath)
    : { ok: false, error: undefined }

  return { ok: true, handoff, resumeCard, launched: launch.ok, launchError: launch.error }
}

/**
 * Accept a pending handoff (by id or latest for this runtime).
 */
export async function acceptAgentHandoff(
  projectId: string,
  projectPath: string,
  handoffId?: string | null
): Promise<AcceptResult> {
  const caller = resolveCallerIdentity(projectPath)
  const pending = handoffId?.trim() ? [] : listPendingForAgent(projectId, caller.agent)
  const fallback =
    pending.length > 0 ? pending : listHandoffs(projectId, { status: 'pending', limit: 5 })
  const id = handoffId?.trim() || fallback[0]?.id || ''
  if (!id) {
    return { ok: false, error: 'No pending handoff for this agent. List with `prjct handoffs`.' }
  }

  // Peek before accept for task rebinding
  const peek = getHandoff(projectId, id)
  if (!peek) return { ok: false, error: `Handoff not found: ${id}` }
  if (peek.status !== 'pending') {
    return { ok: false, error: `Handoff ${peek.id.slice(0, 16)} is already ${peek.status}` }
  }

  const acceptedBy = `${caller.agent}/${caller.identity}`
  const handoff = acceptHandoff(projectId, peek.id, acceptedBy)
  if (!handoff) {
    return { ok: false, error: `Claim lost — ${peek.id.slice(0, 16)} was taken or expired` }
  }

  // Rebind ownership to the accepting agent; clear yield markers.
  await rebindTaskOwner(projectId, projectPath, {
    ownerAgent: caller.agent,
    ownerIdentity: caller.identity,
    ownerSessionId: caller.sessionId,
    yieldStatus: 'active',
    pendingHandoffId: null,
  })

  try {
    prjctDb.appendEvent(projectId, 'task.handoff.accepted', {
      handoffId: handoff.id,
      taskId: handoff.taskId,
      acceptedBy,
      fromAgent: handoff.fromAgent,
    })
  } catch {
    /* best-effort */
  }

  if (effectiveNotifyMode(await configManager.readConfig(projectPath).catch(() => null)) === 'on') {
    await notifyDesktop(
      'prjct handoff accepted',
      `${acceptedBy} took over: ${handoff.taskDescription.slice(0, 80)}`
    )
  }

  return { ok: true, handoff, brief: formatAcceptBrief(handoff, caller) }
}

/** One-line cue for hooks (SessionStart / prompt). */
export function formatPendingHandoffCue(projectId: string, forAgent?: string): string | null {
  const agent = forAgent ?? detectRuntimeAgent()
  const pending = listPendingForAgent(projectId, agent)
  // If runtime is unknown, still surface any pending handoffs (max 2)
  const rows =
    pending.length > 0
      ? pending
      : agent === 'unknown'
        ? listHandoffs(projectId, { status: 'pending', limit: 2 })
        : []
  if (rows.length === 0) return null
  return rows
    .map(
      (h) =>
        `↔ Handoff pending for ${h.toAgent}: \`${h.taskId.slice(0, 8)}\` — "${h.reason.slice(0, 80)}" · accept: \`prjct accept ${h.id}\``
    )
    .join('\n')
}

/**
 * Best-effort spawn of target CLI with a resume prompt (L3).
 * Never kills the source agent. Detached, ignore stdio.
 */
export async function launchTargetAgent(
  toAgent: string,
  handoff: TaskHandoff,
  cwd: string
): Promise<{ ok: boolean; error?: string }> {
  const providerKey = toAgent as AIProviderName
  const config = Providers[providerKey]
  const cli = config?.cliCommand
  if (!cli) {
    return {
      ok: false,
      error: `No CLI for ${toAgent} — paste the resume card into that terminal instead.`,
    }
  }
  const path = await whichAsync(cli)
  if (!path) {
    return { ok: false, error: `${cli} not on PATH` }
  }

  const prompt = [
    `You are accepting a prjct handoff from ${handoff.fromAgent}.`,
    `Run: prjct accept ${handoff.id} --md`,
    `Then continue task ${handoff.taskId}: ${handoff.taskDescription}.`,
    `Reason yielded: ${handoff.reason}`,
    'Do not restart from zero. Work from the current branch state.',
  ].join(' ')

  try {
    const child = spawn(cli, [prompt], {
      cwd,
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, PRJCT_AGENT_RUNTIME: toAgent },
    })
    child.unref()
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'spawn failed' }
  }
}
