/**
 * Stop hook — fires when Claude finishes a turn.
 *
 * Silent by contract. The hook does several useful things, all in
 * `afterEmit` so the host parser doesn't wait on housekeeping:
 *   1. Mine the assistant transcript for substantive captures.
 *   2. Detect durable patterns (hot files, debt growth).
 *   3. Run session-end housekeeping (inbox age-out, archive prune).
 *   4. Detect friction signals from user pushback in the transcript.
 *
 * Each step internally swallows its own failures, so the rest of
 * cleanup still runs even if one step trips. The hook deliberately
 * injects no user-visible message — see mem_220 for the anti-harness
 * rationale (we used to nag "N edits without a memory entry"; that
 * delegated capture to Claude instead of doing it ourselves).
 */

import fs from 'node:fs/promises'
import configManager from '../infrastructure/config-manager'
import { recordAgentSessionEnd } from '../services/agent-session-recorder'
import { embeddingService } from '../services/embeddings'
import { detectFriction } from '../services/friction-detector'
import { detectAndPersistLeanDebt } from '../services/lean-detector'
import { detectAndPersistPatterns } from '../services/pattern-detector'
import { recordCleanupReport, runSessionCleanup } from '../services/session-cleanup'
import { detectSkillMisses } from '../services/skill-miss-detector'
import {
  parseTranscriptJsonl,
  sumTranscriptUsage,
  type TranscriptJsonlLine,
  type TranscriptUsage,
} from '../services/transcript-jsonl'
import { ingestTranscript } from '../services/transcript-learner'
import { usefulnessService } from '../services/usefulness'
import { recordTaskTokenUsage } from '../services/work-cost-service'
import { type HookIo, runHook } from './_runner'

interface HookInput {
  transcript_path?: string
  session_id?: string
}

/**
 * Per-project cooldown for the EXPENSIVE, non-turn-critical Stop steps.
 * Claude fires Stop after EVERY assistant turn, but pattern detection
 * (2 git forks, ~110ms), session cleanup (inbox recall + archive prune) and
 * the embeddings backfill are session-cadence work — running them per turn
 * made the Stop hook do O(session) duplicated work all day. Daemon-resident
 * map: the warm daemon (the hot case) honors the cooldown; a cold one-shot
 * CLI stop simply runs the work — correct either way, since every step is
 * idempotent.
 */
const HEAVY_STEP_COOLDOWN_MS = 10 * 60 * 1000
const heavyStepLastRun = new Map<string, number>()

function heavyStepsDue(projectId: string): boolean {
  const last = heavyStepLastRun.get(projectId) ?? 0
  if (Date.now() - last < HEAVY_STEP_COOLDOWN_MS) return false
  if (heavyStepLastRun.size > 32) heavyStepLastRun.clear()
  heavyStepLastRun.set(projectId, Date.now())
  return true
}

export function runStopHook(projectPath: string = process.cwd(), io?: HookIo): Promise<void> {
  return runHook<HookInput>(
    {
      event: 'Stop',
      projectPath,
      afterEmit: async (input, p) => {
        const config = await configManager.readConfig(p).catch(() => null)
        if (!config?.projectId) return

        // Read + parse the transcript ONCE. Three consumers below
        // (transcript-learner, friction-detector, skill-miss-detector) each
        // used to re-read and re-tokenize the same multi-hundred-KB JSONL.
        const stopContext: {
          transcriptLines?: TranscriptJsonlLine[]
          transcriptUsage?: TranscriptUsage
          activeTaskId?: string
          activeTaskDescription?: string
        } = {}
        if (input.transcript_path) {
          const raw = await fs.readFile(input.transcript_path, 'utf-8').catch(() => null)
          if (raw !== null) stopContext.transcriptLines = parseTranscriptJsonl(raw)
        }

        // Measure the work cycle's token cost: sum the transcript usage and
        // write it onto the active task. Closes the work-cost coverage gap so
        // `prjct performance` can prove prjct's net token savings. Best-effort.
        if (stopContext.transcriptLines && stopContext.transcriptLines.length > 0) {
          try {
            // Session total (for the agent-session record below) is unwindowed;
            // the TASK attribution is windowed to the cycle's start — a task
            // active for 5 minutes of a 10M-token session must not be billed
            // the whole session.
            stopContext.transcriptUsage = sumTranscriptUsage(stopContext.transcriptLines)
            if (stopContext.transcriptUsage.tokensIn + stopContext.transcriptUsage.tokensOut > 0) {
              const { collectActiveTasks } = await import('../services/task-overview')
              const overview = await collectActiveTasks(config.projectId, p)
              stopContext.activeTaskId = overview.current?.id
              stopContext.activeTaskDescription = overview.current?.description
              const taskWindow = overview.current?.startedAt
                ? { sinceIso: overview.current.startedAt }
                : undefined
              const taskUsage = sumTranscriptUsage(stopContext.transcriptLines, taskWindow)
              if (stopContext.activeTaskId && taskUsage.tokensIn + taskUsage.tokensOut > 0) {
                recordTaskTokenUsage(
                  config.projectId,
                  stopContext.activeTaskId,
                  taskUsage.tokensIn,
                  taskUsage.tokensOut,
                  {
                    description: stopContext.activeTaskDescription,
                    agent: 'claude',
                    // Distinct source so this exact transcript-derived measurement
                    // never shares an event_key with the agent-agnostic manual
                    // report (prjct status --tokens-in, core/commands/primitives.ts)
                    // — both used to default to 'cli' and silently clobber each
                    // other via the token_usage upsert (ON CONFLICT(event_key)).
                    source: 'claude-transcript',
                  }
                )
                // Per-model breakdown: one token_usage row per model this
                // session touched (event_key = task:source, so a per-model
                // source keeps rows distinct + upsert-idempotent). This is
                // the data that PROVES whether model routing saves money.
                try {
                  const { sumTranscriptUsageByModel } = await import('../services/transcript-jsonl')
                  for (const [model, u] of sumTranscriptUsageByModel(
                    stopContext.transcriptLines,
                    taskWindow
                  )) {
                    if (u.tokensIn + u.tokensOut <= 0) continue
                    recordTaskTokenUsage(
                      config.projectId,
                      stopContext.activeTaskId,
                      u.tokensIn,
                      u.tokensOut,
                      {
                        model,
                        agent: 'claude',
                        source: `claude-transcript:${model}`,
                      }
                    )
                  }
                } catch {
                  /* per-model breakdown is additive telemetry — never blocks */
                }
              }
            }
          } catch {
            /* measurement must never block session end */
          }
        }

        recordAgentSessionEnd({
          projectId: config.projectId,
          sessionId: input.session_id,
          directory: p,
          taskId: stopContext.activeTaskId,
          goal: stopContext.activeTaskDescription,
          tokensIn: stopContext.transcriptUsage?.tokensIn,
          tokensOut: stopContext.transcriptUsage?.tokensOut,
          agent: 'claude',
        })

        // M1a: auto-capture substantive insights from the assistant's
        // transcript. Conservative heuristics, hashed-dedup, never blocks.
        if (input.transcript_path) {
          try {
            await ingestTranscript(p, input.transcript_path, input.session_id ?? null, {
              preloadedConfig: config,
              preloadedLines: stopContext.transcriptLines,
            })
          } catch {
            // Failed parse / unexpected format → swallow. The user can
            // always run `prjct remember` explicitly.
          }
        }

        // Session-cadence work behind the cooldown (see heavyStepsDue): these
        // steps are idempotent and their signal changes on the minutes scale,
        // not per turn.
        const runHeavySteps = heavyStepsDue(config.projectId)

        // M2: detect durable patterns (hot files for now) and persist them
        // as learning memory entries. Lookup-first protocol means Claude
        // finds them on next session start without inflating context.
        if (runHeavySteps) {
          try {
            await detectAndPersistPatterns(p, config)
          } catch {
            // Git failure / non-repo → swallow; nothing to do here.
          }

          // Lean-debt growth (opt-in via config.lean.mode): flag when `lean:`
          // simplification markers accumulate. No-op when lean mode is off.
          try {
            await detectAndPersistLeanDebt(p, config)
          } catch {
            // Same contract — git failure / non-repo → swallow.
          }

          // Session-end housekeeping (Phase A): age-out inbox, prune archives
          // and old checkpoints, rotate stale on-disk caches. Best-effort —
          // each step internally swallows its own failures, so the rest of
          // the cleanup still runs even if one step trips.
          try {
            const cleanup = await runSessionCleanup(config.projectId)
            await recordCleanupReport(config.projectId, cleanup)
          } catch {
            /* never block session end on cleanup */
          }
        }

        // Session-end friction capture (Phase B): scan the transcript for
        // user-pushback moments (negation, correction, complaint markers)
        // and persist them as `improvement-signal` memory entries. The
        // next session's Claude reads them via topical recall and
        // synthesises improvement ideas — no regex-based classification
        // here, only signal extraction.
        if (input.transcript_path) {
          try {
            const friction = await detectFriction(
              p,
              input.transcript_path,
              input.session_id ?? null,
              {
                preloadedLines: stopContext.transcriptLines,
              }
            )
            // AUTOMATIC negative reinforcement (no command): if the user
            // pushed back this session, demote the memories that were in
            // context for the active task. prjct learns from mistakes on its
            // own — the explicit `corrects:` tag is now an optional override,
            // not a requirement.
            if (friction.signalsRecorded > 0) {
              // Per-worktree: penalize memories surfaced for THIS workspace's
              // task, not a sibling worktree's. Falls back to singular.
              const { collectActiveTasks } = await import('../services/task-overview')
              const overview = await collectActiveTasks(config.projectId, p)
              const taskId = overview.current?.id
              if (taskId) usefulnessService.penalizeSurfaced(config.projectId, taskId)
            }
          } catch {
            /* same contract as transcript-learner — silent best-effort */
          }
        }

        // Session-end skill-miss capture (harness #16): flag captured
        // project knowledge (decision/gotcha/anti-pattern) that was
        // relevant to this session's work but never referenced. Persisted
        // as `improvement-signal` and surfaced under the existing block at
        // the next session start — advisory, never a gate. Same silent
        // best-effort contract as the friction detector above.
        if (input.transcript_path) {
          try {
            await detectSkillMisses(p, input.transcript_path, input.session_id ?? null, {
              preloadedLines: stopContext.transcriptLines,
            })
          } catch {
            /* silent best-effort — must never block session end */
          }
        }

        // Semantic index maintenance: embed memory entries written this
        // session so semantic recall stays current. The default provider is
        // the in-process local embedder (no network, no key), so this runs for
        // every project; a configured HTTP endpoint transparently takes over.
        // Best-effort, idempotent (only un-embedded entries are touched), and
        // must never block session end.
        if (runHeavySteps) {
          try {
            // First arg is the projectId, NOT the path: passing `p` here keyed
            // every query to path.join(projectsDir, <abs path>) — a phantom DB
            // under ~/.prjct-cli/projects/Users/... that made the session-end
            // backfill a silent no-op (ghost dirs confirmed on disk).
            await embeddingService.backfill(config.projectId, config, new Date().toISOString())
          } catch {
            /* never block session end on index maintenance */
          }
        }

        // Land auto-synthesis: when a cycle is open, write the Session close
        // hand-off without asking the agent to remember. Cooldown-aligned
        // with heavy steps so we don't re-write every assistant turn.
        if (runHeavySteps && stopContext.activeTaskId) {
          try {
            const { synthesizeLandHandoff } = await import('../services/land-synthesis')
            await synthesizeLandHandoff({
              projectId: config.projectId,
              projectPath: p,
              cycleDescription: stopContext.activeTaskDescription ?? null,
              cycleId: stopContext.activeTaskId,
              tokensIn: stopContext.transcriptUsage?.tokensIn,
              tokensOut: stopContext.transcriptUsage?.tokensOut,
              model: 'claude',
            })
          } catch {
            /* never block session end on land synthesis */
          }
          try {
            const { synthesizeJudgmentReceipt } = await import('../services/judgment-receipt')
            await synthesizeJudgmentReceipt({
              projectId: config.projectId,
              projectPath: p,
              cycleDescription: stopContext.activeTaskDescription ?? null,
              cycleId: stopContext.activeTaskId,
              tokensIn: stopContext.transcriptUsage?.tokensIn,
              tokensOut: stopContext.transcriptUsage?.tokensOut,
              model: 'claude',
            })
          } catch {
            /* never block session end on judgment receipt */
          }
        }

        // Cloud sync (opt-in): flush this project's pending queue at session
        // end. Gated on cloud.enabled — a no-op for local-only projects.
        // Awaited here (inside afterEmit) so it completes before teardown,
        // avoiding the fire-and-forget-after-teardown trap (mem_1988).
        try {
          const { flushIfLinked } = await import('../sync/auto-flush')
          await flushIfLinked(p, config)
        } catch {
          /* never block session end on cloud sync */
        }
      },
    },
    io
  )
}
