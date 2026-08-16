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
 *
 * Turn-cadence vs session-cadence: Claude fires Stop after EVERY
 * assistant turn, and reading/parsing the transcript is O(session size)
 * — multi-MB JSONL by mid-session. Transcript-dependent work (token
 * accounting, transcript mining, friction, skill-miss) therefore runs
 * only behind the same 10-min `heavyStepsDue` cooldown as pattern
 * detection/cleanup; a non-due Stop is a near-free no-op. In the warm
 * daemon the afterEmit runs on the daemon's single thread, so this gate
 * is also what keeps the latency-critical prompt/pre-edit hooks from
 * queueing behind a full transcript parse.
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import { DAEMON_PATHS } from '../daemon/protocol'
import configManager from '../infrastructure/config-manager'
import { recordAgentSessionEnd } from '../services/agent-session-recorder'
import { embeddingService } from '../services/embeddings'
import { detectFriction } from '../services/friction-detector'
import { resolveInstructionRuntime } from '../services/instruction-attribution'
import { detectAndPersistLeanDebt } from '../services/lean-detector'
import { detectAndPersistPatterns } from '../services/pattern-detector'
import { recordCleanupReport, runSessionCleanup } from '../services/session-cleanup'
import { detectSkillMisses } from '../services/skill-miss-detector'
import {
  identifyTranscriptModel,
  parseTranscriptJsonl,
  sumTranscriptUsage,
  type TranscriptJsonlLine,
  type TranscriptUsage,
} from '../services/transcript-jsonl'
import { ingestTranscript } from '../services/transcript-learner'
import { usefulnessService } from '../services/usefulness'
import { recordTaskTokenUsage } from '../services/work-cost-service'
import { instructionFailureStorage } from '../storage/instruction-failure-storage'
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
 * made the Stop hook do O(session) duplicated work all day.
 *
 * Source of truth is a per-project stamp file in the daemon run dir
 * (`~/.prjct-cli/run/stop-heavy-<projectId>.stamp`): the COLD path spawns a
 * fresh detached worker per event (core/hooks/cold-entry.ts), where an
 * in-memory map would reset every time and every Stop would re-run the
 * mining. The in-memory map remains as a same-process fast path for the
 * warm daemon. The stamp is written BEFORE the work runs so concurrent
 * Stops don't duplicate it. If the run dir is unreadable/unwritable we
 * fall through and run the work — every step is idempotent.
 */
const HEAVY_STEP_COOLDOWN_MS = 10 * 60 * 1000
const heavyStepLastRun = new Map<string, number>()

/** Exported for tests (stamp location is part of the cooldown contract). */
export function heavyStepStampPath(projectId: string): string {
  // projectId is not guaranteed filename-safe across hosts — clamp it.
  const safeId = projectId.replace(/[^a-zA-Z0-9._-]/g, '_')
  return path.join(DAEMON_PATHS.runDir(), `stop-heavy-${safeId}.stamp`)
}

async function claimHeavyStep(stamp: string, now: number, retry: boolean = true): Promise<boolean> {
  const recent = await fs
    .stat(stamp)
    .then((stat) => now - stat.mtimeMs < HEAVY_STEP_COOLDOWN_MS)
    .catch(() => false)
  if (recent) return false

  const lock = `${stamp}.lock`
  try {
    await fs.mkdir(lock)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    const staleLock = await fs
      .stat(lock)
      .then((stat) => now - stat.mtimeMs >= HEAVY_STEP_COOLDOWN_MS)
      .catch(() => false)
    if (!staleLock || !retry) return false
    await fs.rmdir(lock).catch(() => undefined)
    return claimHeavyStep(stamp, now, false)
  }

  try {
    // Re-check under the atomic mkdir lock: another process may have written
    // the stamp between our optimistic stat and lock acquisition.
    const claimed = await fs
      .stat(stamp)
      .then((stat) => now - stat.mtimeMs < HEAVY_STEP_COOLDOWN_MS)
      .catch(() => false)
    if (claimed) return false
    await fs.writeFile(stamp, String(now))
    return true
  } finally {
    await fs.rmdir(lock).catch(() => undefined)
  }
}

/** Exported for tests (core/__tests__/hooks/stop-heavy-cooldown.test.ts). */
export async function heavyStepsDue(projectId: string): Promise<boolean> {
  const now = Date.now()
  // Fast path: same-process (warm daemon) — no disk hit.
  const last = heavyStepLastRun.get(projectId) ?? 0
  if (now - last < HEAVY_STEP_COOLDOWN_MS) return false
  try {
    const stamp = heavyStepStampPath(projectId)
    await fs.mkdir(path.dirname(stamp), { recursive: true })
    const due = await claimHeavyStep(stamp, now)
    if (heavyStepLastRun.size > 32) heavyStepLastRun.clear()
    heavyStepLastRun.set(projectId, now)
    return due
  } catch {
    // Run dir unwritable → run the work anyway (idempotent).
  }
  if (heavyStepLastRun.size > 32) heavyStepLastRun.clear()
  heavyStepLastRun.set(projectId, now)
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
        const runtime = resolveInstructionRuntime()

        // Session-cadence gate FIRST: everything transcript-dependent below
        // (read + parse of a multi-MB JSONL, mining, friction, skill-miss)
        // is O(session size) and only needs minutes-scale freshness. A
        // non-due Stop must be near-free.
        const runHeavySteps = await heavyStepsDue(config.projectId)

        // Read + parse the transcript ONCE, and only when heavy steps are
        // due. Three consumers below (transcript-learner, friction-detector,
        // skill-miss-detector) each used to re-read and re-tokenize the same
        // multi-hundred-KB JSONL.
        const stopContext: {
          transcriptLines?: TranscriptJsonlLine[]
          transcriptUsage?: TranscriptUsage
          activeTaskId?: string
          activeTaskDescription?: string
          activeTaskStartedAt?: string
        } = {}
        if (runHeavySteps && input.transcript_path) {
          const raw = await fs.readFile(input.transcript_path, 'utf-8').catch(() => null)
          if (raw !== null) stopContext.transcriptLines = parseTranscriptJsonl(raw)
        }
        const model = identifyTranscriptModel(stopContext.transcriptLines ?? [])
        if (runHeavySteps) {
          try {
            const { collectActiveTasks } = await import('../services/task-overview')
            const overview = await collectActiveTasks(config.projectId, p)
            stopContext.activeTaskId = overview.current?.id
            stopContext.activeTaskDescription = overview.current?.description
            stopContext.activeTaskStartedAt = overview.current?.startedAt
          } catch {
            /* task attribution is best-effort and independent from token usage */
          }
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
              const taskWindow = stopContext.activeTaskStartedAt
                ? { sinceIso: stopContext.activeTaskStartedAt }
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
                    agent: runtime,
                    // Distinct source so this exact transcript-derived measurement
                    // never shares an event_key with the agent-agnostic manual
                    // report (prjct status --tokens-in, core/commands/primitives.ts)
                    // — both used to default to 'cli' and silently clobber each
                    // other via the token_usage upsert (ON CONFLICT(event_key)).
                    source: `${runtime}-transcript`,
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
                        agent: runtime,
                        source: `${runtime}-transcript:${model}`,
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
          agent: runtime,
          model,
        })

        // M1a: auto-capture substantive insights from the assistant's
        // transcript. Conservative heuristics, hashed-dedup, never blocks.
        // Session-cadence: gated with the heavy steps (see above) so a
        // per-turn Stop never pays the transcript scan.
        if (runHeavySteps && input.transcript_path) {
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
        // not per turn. The gate was claimed at the top of afterEmit so the
        // transcript read could share it.

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
            instructionFailureStorage.pruneRetained(config.projectId)
          } catch {
            /* never block session end on cleanup */
          }
        }

        // Session-end friction capture (Phase B): scan the transcript for
        // user-pushback moments (negation, correction, complaint markers)
        // and persist them as `improvement-signal` memory entries. The
        // next session's Claude reads them via topical recall and
        // synthesises improvement ideas — no regex-based classification
        // here, only signal extraction. Session-cadence (heavy-step gate).
        if (runHeavySteps && input.transcript_path) {
          try {
            const friction = await detectFriction(
              p,
              input.transcript_path,
              input.session_id ?? null,
              {
                preloadedLines: stopContext.transcriptLines,
                runtime,
                model,
              }
            )
            for (const failure of friction.failures) {
              try {
                instructionFailureStorage.record(config.projectId, {
                  source: 'friction-detector',
                  runtime,
                  model,
                  sessionId: input.session_id ?? null,
                  taskId: stopContext.activeTaskId ?? null,
                  ...failure,
                })
              } catch {
                /* ledger is additive; the memory signal remains authoritative */
              }
            }
            // AUTOMATIC negative reinforcement (no command): if the user
            // pushed back this session, demote the memories that were in
            // context for the active task. prjct learns from mistakes on its
            // own — the explicit `corrects:` tag is now an optional override,
            // not a requirement.
            if (friction.signalsRecorded > 0 && stopContext.activeTaskId) {
              // The task was resolved per-worktree above, so a sibling's
              // surfaced memories are never penalized by this transcript.
              usefulnessService.penalizeSurfaced(config.projectId, stopContext.activeTaskId)
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
        // best-effort contract as the friction detector above. Session-cadence
        // (heavy-step gate).
        if (runHeavySteps && input.transcript_path) {
          try {
            const skillMisses = await detectSkillMisses(
              p,
              input.transcript_path,
              input.session_id ?? null,
              {
                preloadedLines: stopContext.transcriptLines,
                runtime,
                model,
              }
            )
            for (const failure of skillMisses.failures) {
              try {
                instructionFailureStorage.record(config.projectId, {
                  source: 'skill-miss-detector',
                  runtime,
                  model,
                  sessionId: input.session_id ?? null,
                  taskId: stopContext.activeTaskId ?? null,
                  ...failure,
                })
              } catch {
                /* ledger is additive; the memory signal remains authoritative */
              }
            }
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
          // Shared by both syntheses below — same cycle snapshot, two
          // independent best-effort writers.
          const cycleSynthesisArgs = {
            projectId: config.projectId,
            projectPath: p,
            cycleDescription: stopContext.activeTaskDescription ?? null,
            cycleId: stopContext.activeTaskId,
            tokensIn: stopContext.transcriptUsage?.tokensIn,
            tokensOut: stopContext.transcriptUsage?.tokensOut,
            model,
          }
          const runBestEffort = async (fn: () => Promise<void>): Promise<void> => {
            try {
              await fn()
            } catch {
              /* never block session end — land synthesis / judgment receipt are best-effort */
            }
          }
          await runBestEffort(async () => {
            const { synthesizeLandHandoff } = await import('../services/land-synthesis')
            await synthesizeLandHandoff(cycleSynthesisArgs)
          })
          await runBestEffort(async () => {
            const { synthesizeJudgmentReceipt } = await import('../services/judgment-receipt')
            await synthesizeJudgmentReceipt(cycleSynthesisArgs)
          })
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
