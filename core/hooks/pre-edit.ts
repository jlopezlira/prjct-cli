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
  CONFLICT_HARD_CAP_MS,
  CONFLICT_RECALL_LIMIT,
  candidatesFromPreventive,
  decisionConflictVerdict,
  loadConflictOverrides,
  recordConflictEvent,
} from '../services/decision-conflict'
import { loopGuardVerdict } from '../services/loop-guard'
import { sotBindVerdict } from '../services/sot-bind'
import { formatTrapSurfaceMessage } from '../services/trap-surface-slo'
import { recordSurfacedForActiveTask } from '../services/usefulness/surface-attribution'
import { conflictModeWithWeakModel } from '../services/weak-model-mode'
import { stateStorage } from '../storage/state-storage'
import { type HookIo, runHook } from './_runner'
import { safeTruncate } from './_shared'
import { decideSecrets, type SecretHookInput } from './pre-secrets'

const MAX_CHARS = 1200

/** Per-invocation cache so decide + build share one recall (P0-3). */
const preventiveRecallCache = new Map<string, MemoryEntry[]>()

interface HookInput extends SecretHookInput {
  tool_name?: string
  tool_input?: { file_path?: string; [key: string]: unknown }
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
  if (trapFmt) return safeTruncate(trapFmt, MAX_CHARS)
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
  return safeTruncate(lines.join('\n'), MAX_CHARS)
}

async function buildPreEditContext(projectPath: string, filePath: string): Promise<string | null> {
  const started = Date.now()
  const config = await configManager.readConfig(projectPath)
  if (!config?.projectId) return null

  const hits = recallPreventiveOnce(config.projectId, filePath)
  if (budgetExceeded(started)) return null
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
      return safeTruncate(sot.message, MAX_CHARS)
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
    return safeTruncate(verdict.message, MAX_CHARS)
  }

  // mode=off or gate none: classic heads-up (deny already handled in decide)
  // Trap-surface SLO: always list every preventive id when present.
  if (mode === 'off' || verdict.action === 'none' || hits.length > 0) {
    return headsUpMessage(hits, base)
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
    if (budgetExceeded(started, CONFLICT_HARD_CAP_MS)) return null

    const hits = recallPreventiveOnce(config.projectId, filePath)
    if (hits.length === 0) return null
    if (budgetExceeded(started, CONFLICT_HARD_CAP_MS)) return null

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

export function runPreEditHook(projectPath: string = process.cwd(), io?: HookIo): Promise<void> {
  return runHook<HookInput>(
    {
      event: 'PreToolUse',
      projectPath,
      decide: async (input, p) => {
        clearPreventiveCache()
        const secretDecision = decideSecrets(input)
        if (secretDecision) return secretDecision
        return decideHardStop(p, input.tool_input?.file_path?.trim())
      },
      build: async (input, p) => {
        try {
          const filePath = input.tool_input?.file_path?.trim()
          if (!filePath) return null
          return buildPreEditContext(p, filePath)
        } finally {
          clearPreventiveCache()
        }
      },
    },
    io
  )
}
