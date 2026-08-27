/**
 * PreToolUse hook (matcher: Edit|Write). Surfaces preventive memory and runs
 * the Decision Conflict Gate (warn/deny by conflictMode). Quiet default (off);
 * pack code → advisory warn; code-strict / conflictMode=strict → deny path.
 *
 * Hot path: one recallForFile shared by decide+build (request cache);
 * wall-clock hard cap → fail-open; SQL LIMIT on recall.
 */

import configManager from '../infrastructure/config-manager'
import type { MemoryEntry } from '../memory/entries'
import { deriveTitle, flatDetail, preventiveLabel } from '../memory/format'
import { projectMemory } from '../memory/project-memory'
import {
  budgetExceeded,
  CONFLICT_RECALL_LIMIT,
  candidatesFromPreventive,
  conflictHardCapMs,
  decisionConflictVerdict,
  loadConflictOverrides,
  recordConflictEvent,
} from '../services/decision-conflict'
import { loopGuardVerdict } from '../services/loop-guard'
import {
  gateDelivery,
  markRepositoryContextDeliveredThisTurn,
  repositoryContextDeliveredThisTurn,
} from '../services/session-context-cache'
import { sotBindVerdict } from '../services/sot-bind'
import {
  repoRelativeFile,
  sourceFirstDenyMessage,
  sourceInspectionToken,
  wasSourceInspected,
} from '../services/source-first-gate'
import { formatTrapSurfaceMessage } from '../services/trap-surface-slo'
import { recordSurfacedForActiveTask } from '../services/usefulness/surface-attribution'
import { conflictModeWithWeakModel } from '../services/weak-model-mode'
import { stateStorage } from '../storage/state-storage'
import { type HookIo, runHook } from './_runner'
import { safeTruncate } from './_shared'
import { hookFilePaths } from './_tool-input'
import { decideSecrets, type SecretHookInput } from './pre-secrets'

const MAX_CHARS = 1200
/** Tail budget for guidance blocks — the closing action must survive the cut. */
const TAIL_CHARS = Math.floor(MAX_CHARS / 4)

/** Per-invocation cache so decide + build share one recall (P0-3). */
const preventiveRecallCache = new Map<string, MemoryEntry[]>()

// Heads-up dedupe lives in the delivery gate now (surface 'pre-edit',
// keyed by file): durable across cold spawns/daemon restarts when session
// identity exists; process-lifetime only without it (safety content must
// never be cross-agent suppressed). A newly-recorded trap changes the
// rendered message → the content hash re-arms the heads-up.

interface HookInput extends SecretHookInput {
  tool_name?: string
  tool_input?: unknown
  toolInput?: unknown
  /** Claude/Kimi/Gemini session identity. */
  session_id?: string
  /** Cursor session identity. */
  conversation_id?: string
}

function editFilePaths(input: HookInput): string[] {
  return hookFilePaths(input)
}

function hookSessionId(input: HookInput): string | undefined {
  return input.session_id?.trim() || input.conversation_id?.trim() || undefined
}

function recallPreventiveOnce(projectId: string, filePath: string): MemoryEntry[] {
  const key = `${projectId}\0${filePath}`
  const hit = preventiveRecallCache.get(key)
  if (hit) return hit
  const rows = (() => {
    try {
      return projectMemory.recallForFile(projectId, filePath, CONFLICT_RECALL_LIMIT, {
        preventiveOnly: true,
      })
    } catch {
      return []
    }
  })()
  preventiveRecallCache.set(key, rows)
  return rows
}

function clearPreventiveCache(): void {
  preventiveRecallCache.clear()
}

function headsUpMessage(hits: MemoryEntry[], base: string): string {
  // Dynasty trap-before-edit: every trap id MUST appear (trap-surface SLO).
  const trapFmt = formatTrapSurfaceMessage(
    base,
    hits.map((e) => ({
      id: e.id,
      type: preventiveLabel(e),
      title: `${deriveTitle(e)} — ${flatDetail(e.content)}`,
    }))
  )
  if (trapFmt) return safeTruncate(trapFmt, MAX_CHARS, undefined, TAIL_CHARS)
  const lines = [`# prjct: heads-up before editing \`${base}\``, '']
  lines.push(
    `${hits.length} preventive memory entr${hits.length === 1 ? 'y' : 'ies'} recorded against this file:`
  )
  lines.push('')
  for (const e of hits) {
    lines.push(
      `- **[${preventiveLabel(e)}] ${deriveTitle(e)}** — ${flatDetail(e.content)}  \`${e.id}\``
    )
  }
  lines.push('')
  lines.push('> Nudge, not block. Apply if it still holds; proceed if not.')
  return safeTruncate(lines.join('\n'), MAX_CHARS, undefined, TAIL_CHARS)
}

async function buildPreEditContext(
  projectPath: string,
  filePath: string,
  sessionId: string
): Promise<string | null> {
  const started = Date.now()
  const config = await configManager.readConfig(projectPath)
  if (!config?.projectId) return null

  const hits = recallPreventiveOnce(config.projectId, filePath)
  // Fail-open is correct; failing open SILENTLY is not. Someone who chose
  // conflictMode 'strict' asked for a hard gate, and a quiet pass lets them
  // edit over a decision in force believing the gate cleared them. Say the
  // gate did not run — as context, never as a deny.
  if (budgetExceeded(started)) {
    return conflictModeWithWeakModel(config) === 'strict'
      ? `# prjct: conflict gate skipped\nPreventive recall on \`${filePath}\` exceeded its ${conflictHardCapMs()}ms budget, so this edit was NOT checked against decisions in force. The edit is not blocked. Re-run it to retry the check, or raise \`PRJCT_CONFLICT_HARD_CAP_MS\` if this machine is consistently slower than the budget.`
      : null
  }
  if (hits.length === 0) return null

  void recordSurfacedForActiveTask(
    config.projectId,
    projectPath,
    hits.map((e) => e.id)
  )

  const mode = conflictModeWithWeakModel(config)
  const overrides = loadConflictOverrides(config.projectId)
  const candidates = candidatesFromPreventive(hits)
  const base = filePath.split('/').pop() ?? filePath
  const verdict = decisionConflictVerdict({
    mode,
    candidates,
    overriddenIds: overrides,
    fileLabel: base,
  })

  if (budgetExceeded(started)) return null

  // H1 SoT soft-bind warn (when not already conflict-warn)
  try {
    const task = await stateStorage.getCurrentTask(config.projectId)
    const sot = sotBindVerdict({
      harnessLevel: task?.harness?.level ?? null,
      candidates,
      overriddenIds: overrides,
      fileLabel: base,
    })
    if (sot.action === 'warn' && sot.message) {
      return safeTruncate(sot.message, MAX_CHARS, undefined, TAIL_CHARS)
    }
  } catch {
    /* best-effort */
  }

  if (verdict.action === 'warn' && verdict.message) {
    // warn is ephemeral — not persisted (recordConflictEvent no-ops warn)
    void recordConflictEvent(
      projectPath,
      config.projectId,
      'warn',
      verdict.memoryIds,
      verdict.reason
    )
    return safeTruncate(verdict.message, MAX_CHARS, undefined, TAIL_CHARS)
  }

  // mode=off or gate none: classic heads-up (deny already handled in decide)
  // Trap-surface SLO: always list every preventive id when present.
  if (mode === 'off' || verdict.action === 'none' || hits.length > 0) {
    // Once per (project, session, file, trap-set) — never re-injects.
    const message = headsUpMessage(hits, base)
    const gate = await gateDelivery({
      projectId: config.projectId,
      projectPath,
      sessionId: sessionId === 'unknown' ? undefined : sessionId,
      surface: 'pre-edit',
      key: filePath,
      content: message,
      noSession: { mode: 'memory' },
    })
    return gate.suppressed ? null : message
  }

  return null
}

/**
 * Hard loop guard + conflict deny + H2+ SoT hard-bind. Shares recall cache with build.
 */
async function decideHardStop(
  projectPath: string,
  filePath?: string
): Promise<{ deny: string } | null> {
  const started = Date.now()
  try {
    const config = await configManager.readConfig(projectPath)
    if (!config?.projectId) return null

    const task = await stateStorage.getCurrentTask(config.projectId)

    if (config.maxTurnsPerCycle) {
      const verdict = loopGuardVerdict(config, task)
      if (verdict.stopped) return { deny: verdict.message }
    }

    if (!filePath) return null
    // Budget exhaustion NEVER denies — an edit must not be blocked because
    // recall was slow. The skip is reported through context instead
    // (`buildPreEditContext`), so the author learns the gate did not run
    // without being stopped from working.
    if (budgetExceeded(started)) return null

    const hits = recallPreventiveOnce(config.projectId, filePath)
    if (hits.length === 0) return null
    if (budgetExceeded(started)) return null

    const overrides = loadConflictOverrides(config.projectId)
    const base = filePath.split('/').pop() ?? filePath
    const candidates = candidatesFromPreventive(hits)

    // Dynasty SoT hard-bind: H2+ denies high-confidence decision/gotcha/fact
    // even when conflictMode is off/advisory (living SoT is code-enforced).
    const sot = sotBindVerdict({
      harnessLevel: task?.harness?.level ?? null,
      candidates,
      overriddenIds: overrides,
      fileLabel: base,
    })
    if (sot.action === 'deny' && sot.message) {
      void recordConflictEvent(projectPath, config.projectId, 'deny', sot.memoryIds, sot.reason)
      return { deny: sot.message }
    }

    const mode = conflictModeWithWeakModel(config)
    if (mode !== 'strict') return null

    const conflict = decisionConflictVerdict({
      mode,
      candidates,
      overriddenIds: overrides,
      fileLabel: base,
    })
    if (conflict.action === 'deny' && conflict.message) {
      void recordConflictEvent(
        projectPath,
        config.projectId,
        'deny',
        conflict.memoryIds,
        conflict.reason
      )
      return { deny: conflict.message }
    }
    return null
  } catch {
    return null
  }
}

async function decideSourceFirst(
  projectPath: string,
  filePath: string,
  sessionId: string | undefined
): Promise<{ deny: string } | null> {
  const config = await configManager.readConfig(projectPath).catch(() => null)
  if (!config?.projectId) return null
  try {
    const inspected = await wasSourceInspected({
      projectId: config.projectId,
      projectPath,
      sessionId,
      filePath,
    })
    if (inspected) {
      return null
    }
    const token = sourceInspectionToken({
      projectId: config.projectId,
      projectPath,
      sessionId,
      filePath,
    })
    const repositoryAlreadyDelivered = await repositoryContextDeliveredThisTurn({
      projectId: config.projectId,
      projectPath,
      sessionId: sessionId ?? 'sessionless',
    })
    const message = sourceFirstDenyMessage(config.projectId, projectPath, filePath, token, {
      includeSyncedPatterns: !repositoryAlreadyDelivered,
    })
    if (!message) return null
    if (!repositoryAlreadyDelivered && message.includes('Synced house patterns for this file:')) {
      await markRepositoryContextDeliveredThisTurn({
        projectId: config.projectId,
        projectPath,
        sessionId: sessionId ?? 'sessionless',
      })
    }

    return { deny: message }
  } catch {
    // Source-first is the correctness boundary, unlike advisory memory recall.
    // Once a project and target file are known, an auxiliary lookup failure
    // cannot silently authorize a blind edit.
    const file = repoRelativeFile(projectPath, filePath)
    if (!file) return null
    return {
      deny: [
        '# prjct: source-first gate — edit blocked',
        `Inspection state could not be verified for \`${file}\`.`,
        `Read the existing implementation or run \`prjct guard "${file}" --md\`, then retry the edit.`,
      ].join('\n'),
    }
  }
}

export function runPreEditHook(projectPath: string = process.cwd(), io?: HookIo): Promise<void> {
  return runHook<HookInput>(
    {
      event: 'PreToolUse',
      projectPath,
      decide: async (input, p) => {
        clearPreventiveCache()
        const secretDecision = decideSecrets(input)
        if (secretDecision) return secretDecision
        const filePaths = editFilePaths(input)
        if (filePaths.length === 0) return decideHardStop(p)
        for (const filePath of filePaths) {
          const hardStop = await decideHardStop(p, filePath)
          if (hardStop) return hardStop
          const sourceFirst = await decideSourceFirst(p, filePath, hookSessionId(input))
          if (sourceFirst) return sourceFirst
        }
        return null
      },
      build: async (input, p) => {
        try {
          const filePath = editFilePaths(input)[0]
          if (!filePath) return null
          return buildPreEditContext(p, filePath, hookSessionId(input) ?? 'unknown')
        } finally {
          clearPreventiveCache()
        }
      },
    },
    io
  )
}
