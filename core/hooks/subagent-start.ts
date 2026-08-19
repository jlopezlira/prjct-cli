/**
 * SubagentStart hook — inject a compact project digest into spawned
 * subagents. Without this, subagents start with zero project context
 * and re-investigate facts the main session already knows.
 *
 * Uses `buildSubagentDigest` (role + this worktree's active work cycle + top
 * traps) rather than the full session context: SubagentStart emits via
 * `systemMessage` (its schema rejects `additionalContext`), which sits
 * outside the cached prompt prefix, so variable content is safe here.
 * Same rules: describe WHAT, never HOW.
 */

import configManager from '../infrastructure/config-manager'
import { prjctDb } from '../storage/database'
import { type HookIo, runHook } from './_runner'
import { buildSubagentDigest } from './session-start'

/** Emitted chars per spawn, for the afterEmit context-tax accumulator. */
const subagentEmitChars = new WeakMap<object, number>()

export function runSubagentStartHook(
  projectPath: string = process.cwd(),
  io?: HookIo
): Promise<void> {
  return runHook(
    {
      event: 'SubagentStart',
      projectPath,
      // No dedupe here on purpose: each subagent is a FRESH context —
      // suppressing its digest would lose information, not save repeats.
      build: async (_input, p) => {
        const digest = await buildSubagentDigest(p)
        if (digest) subagentEmitChars.set(_input as object, digest.length)
        return digest
      },
      afterEmit: async (_input, p, host) => {
        // Fan-out telemetry: one event per spawn, attributed to the active
        // cycle, so `prjct performance` can show how many subagents a cycle
        // cost (was the crew worth it?). Best-effort, silent.
        try {
          const config = await configManager.readConfig(p)
          if (!config?.projectId) return
          const { collectActiveTasks } = await import('../services/task-overview')
          const overview = await collectActiveTasks(config.projectId, p)
          prjctDb.appendEvent(config.projectId, 'subagent.spawned', {
            taskId: overview.current?.id ?? null,
          })
          const chars = subagentEmitChars.get(_input as object) ?? 0
          if (chars > 0 && overview.current?.id) {
            const { recordHookEmissionChars } = await import('../services/work-cost-service')
            recordHookEmissionChars(
              config.projectId,
              overview.current.id,
              chars,
              host ?? 'claude',
              'subagent-start'
            )
          }
        } catch {
          /* telemetry only */
        }
      },
    },
    io
  )
}
