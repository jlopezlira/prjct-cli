/**
 * UserPromptSubmit hook — lean project-state injection only.
 *
 * Fires when the human submits a prompt and injects pure facts about where
 * the project is right now (active work, branch, working tree, recent ships)
 * so the LLM can disambiguate intent without asking ("listo" + dirty tree +
 * active work + unpushed commits → ship; clean tree → close work).
 *
 * General memory and improvement signals are PULL, not PUSH: the agent
 * fetches them on demand (`prjct context memory <topic>`, `prjct guard
 * <file>`, MCP recall). Per-turn keyword-matched recall used to match on
 * stopwords/noise and burn the context window with entries the turn never
 * needed — exactly the bloat we refuse to ship to clients.
 *
 * Narrow exceptions to PULL: preventive knowledge and explicitly authored,
 * selectively matched instruction guidance. Decisions/learnings/facts stay
 * pull-only; every pushed section shares the existing hard state budget.
 *
 * Zero "do X" prescription. The LLM decides. Degrades gracefully: on any
 * error (no project, no git) we emit `{}` and stay out of the way.
 */

import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { DAEMON_PATHS } from '../daemon/protocol'
import configManager from '../infrastructure/config-manager'
import { deriveTitle } from '../memory/format'
import { projectMemory } from '../memory/project-memory'
import { buildAlignmentCard } from '../services/alignment-card'
import { contextPressureVerdict } from '../services/context-pressure'
import { buildIndexedFileCue } from '../services/file-cue'
import {
  buildDeliveryGuidance,
  classifyDeliveryIntent,
  type DeliveryIntent,
} from '../services/instruction-guidance'
import { qualityInjectForProject } from '../services/judgment-orchestrator'
import { loopGuardVerdict } from '../services/loop-guard'
import { gateDelivery, normalizeStateForMaterialChange } from '../services/session-context-cache'
import { renderDelegationTrigger } from '../services/task-orchestration'
import { collectActiveTasks } from '../services/task-overview'
import { recordSurfacedForActiveTask } from '../services/usefulness/surface-attribution'
import { recordHookEmissionChars } from '../services/work-cost-service'
import { prjctDb } from '../storage/database'
import { instructionFailureStorage } from '../storage/instruction-failure-storage'
import { queueStorage } from '../storage/queue-storage'
import { shippedStorage } from '../storage/shipped-storage'
import { stateStorage } from '../storage/state-storage'
import type { LocalConfig } from '../types/config'
import { execFileAsync } from '../utils/exec'
import { fileExists } from '../utils/file-helper'
import { type HookIo, runHook } from './_runner'
import { extractKeywords, safeTruncate } from './_shared'
import {
  buildCompactReanchor,
  buildSessionContext,
  consumeKimiSessionInjection,
} from './session-start'

const STATE_BUDGET = 700
/**
 * First-prompt budget under Kimi: the SessionStart payload (persona +
 * cold-start digest, ~2.1k chars worst case) rides the first UserPromptSubmit
 * because Kimi never surfaces SessionStart stdout — so that one payload gets
 * the digest budget on top of the per-turn state budget.
 */
const KIMI_FIRST_PROMPT_BUDGET = STATE_BUDGET + 2100
/**
 * Turns on a single cycle before the state block escalates from "stay on goal"
 * to "stop looping". Set above a normal multi-step cycle so it only fires on a
 * genuine grind, not honest iteration.
 */
const STUCK_TURN_THRESHOLD = 15
/**
 * Show the short loop-discipline cue only every N turns of a cycle. The old
 * per-turn paragraph re-shipped identical bytes on EVERY prompt while a cycle
 * was open — pure prescription against this hook's contract (see header).
 * Escalation past STUCK_TURN_THRESHOLD stays with the alignment card.
 */
const LOOP_CUE_INTERVAL = 10
/** FTS candidates fetched before the preventive-type filter picks ONE. */
const CUE_CANDIDATES = 8
const GUIDANCE_BUDGET = 240
const GUIDANCE_MAX_ENTRIES = 2
const GIT_SNAPSHOT_TTL_MS = 15_000

export { buildDeliveryGuidance, classifyDeliveryIntent, type DeliveryIntent }

const GENERIC_GUIDANCE_TOKENS = new Set([
  'address',
  'apply',
  'check',
  'continue',
  'create',
  'current',
  'description',
  'feedback',
  'handle',
  'merge',
  'monitor',
  'please',
  'review',
  'should',
  'title',
  'watch',
  'write',
])

interface PromptAfterEmit {
  projectId: string
  projectPath: string
  bumpTurn: boolean
  surfacedIds: string[]
  guidanceRuleId: string | null
  /** Chars of the payload actually emitted this turn (0 = suppressed/deduped)
   *  — accumulated into token_usage as prjct's own context-tax estimate. */
  emittedChars: number
}

const promptAfterEmit = new WeakMap<object, PromptAfterEmit>()
const promptPayloadHashes = new Map<string, string>()

interface HookInput {
  prompt?: string
  /** Claude/Kimi/Gemini/Codex session identity. */
  session_id?: string
  /** Cursor session identity. */
  conversation_id?: string
}

/** One transient signal inside the state — gated per `key`, emitted on
 *  appearance/material change only (event-only doctrine, pull-first). */
export interface StateEvent {
  key: string
  text: string
}

export interface ProjectStateParts {
  /** Standing facts (cycle, owner, branch, ships, inbox) — delivered once
   *  per session, re-delivered only on material change. */
  standing: string | null
  /** Transient signals (loop cue, budget, delegation, alignment, handoff) —
   *  each emitted when it appears or escalates, silent while unchanged. */
  events: StateEvent[]
}

/**
 * Build the "# prjct: project state" facts, split into standing state and
 * transient events so the delivery gate can suppress each independently.
 * Pure facts about where the project is right now; the LLM reads them to
 * disambiguate user intent without asking.
 *
 * Returns null when there's nothing useful to say (no project) so the
 * caller can skip injection entirely.
 */
export async function buildProjectStateParts(
  projectPath: string,
  preloaded?: LocalConfig | null,
  opts: { skipHandoff?: boolean } = {}
): Promise<ProjectStateParts | null> {
  const config = preloaded !== undefined ? preloaded : await configManager.readConfig(projectPath)
  if (!config?.projectId) return null

  // Kick the secondary probes (queue / ship / inbox / handoff / git) FIRST so
  // their forks overlap the active-work block instead of queueing behind it —
  // a cold `git status` fork is the slowest single probe here (~20-40ms).
  const secondaryPromise = collectSecondarySignals(config, projectPath, opts)

  const lines: string[] = ['# prjct: project state']
  const events: StateEvent[] = []
  // Active work — most useful single fact. Resolved PER worktree so a parallel
  // agent sees its own work, not a sibling's. Falls back to singular outside a
  // worktree.
  try {
    const overview = await collectActiveTasks(config.projectId, projectPath)
    if (overview.current) {
      const startedAgo = formatRelative(overview.current.startedAt)
      lines.push(
        `- Active work cycle: "${overview.current.description}" (${startedAgo}) [${overview.current.label}]`
      )
      // Session-close land reminder lives in SessionStart (buildLandCue),
      // once per session — repeating it on every prompt was per-turn
      // prescription against this hook's contract.
      // Read-only turn state. Reuses collectActiveTasks' already-fetched
      // mainTaskRaw instead of a second stateStorage.getCurrentTask fetch —
      // same doc, same daemon-mode SQLite read, just once instead of twice.
      const { turns, loopVerdict, currentTask } = (() => {
        try {
          const task = overview.mainTaskRaw
          return {
            turns: task?.turnCount ?? 0,
            currentTask: task,
            loopVerdict: loopGuardVerdict(config, task),
          }
        } catch {
          /* best-effort — never block the state block on the counter */
          return { turns: 0, currentTask: null, loopVerdict: null }
        }
      })()
      if (
        !loopVerdict?.stopped &&
        turns > 0 &&
        turns % LOOP_CUE_INTERVAL === 0 &&
        turns < STUCK_TURN_THRESHOLD
      ) {
        // Guardrail events are scoped per CYCLE: normalization erases the
        // numbers, so a session-constant key would let cycle 1's stamp
        // silence cycle 2's warning forever.
        events.push({
          key: `loop:${overview.current.id}`,
          text: `↳ Turn ${turns} on this cycle — still advancing the goal? If stuck, re-plan or split; do not loop.`,
        })
      }
      // Token budget — uses post-bump task (no extra SQLite read).
      try {
        const budget = config.maxTokensPerCycle ?? 0
        if (budget > 0 && currentTask) {
          const spent = (currentTask.tokensIn ?? 0) + (currentTask.tokensOut ?? 0)
          if (spent >= budget) {
            events.push({
              key: `budget:${overview.current.id}`,
              text: `⚠ Token budget: ${spent.toLocaleString()} of ${budget.toLocaleString()} spent on this cycle. STOP growing it — ship the working slice, split the remainder into a new cycle, or check in with the user.`,
            })
          } else if (spent >= budget * 0.8) {
            events.push({
              key: `budget:${overview.current.id}`,
              text: `↳ Token budget: ${spent.toLocaleString()} of ${budget.toLocaleString()} (${Math.round((spent / budget) * 100)}%). Plan the close: prefer finishing over expanding scope.`,
            })
          }
        }
      } catch {
        /* budget is advisory — never block the state block */
      }

      // Delegation + alignment in parallel with static imports where possible.
      try {
        const startedIso = overview.current.startedAt
        if (startedIso) {
          const touched =
            prjctDb.get<{ c: number }>(
              config.projectId,
              `SELECT COUNT(DISTINCT json_extract(data, '$.file')) AS c
               FROM events WHERE type = 'memory.post_edit' AND timestamp >= ?`,
              startedIso
            )?.c ?? 0
          const trigger = renderDelegationTrigger(touched)
          if (trigger) events.push({ key: `delegation:${overview.current.id}`, text: trigger })
        }
      } catch {
        /* best-effort */
      }

      try {
        const pressure = contextPressureVerdict(config, currentTask)
        const qualityInject = qualityInjectForProject(config.projectId)
        const card = buildAlignmentCard({
          loop: loopVerdict,
          pressure,
          qualityInject,
          turns,
          stuckThreshold: STUCK_TURN_THRESHOLD,
        })
        if (card.markdown)
          events.push({ key: `alignment:${overview.current.id}`, text: card.markdown })
      } catch {
        /* advisory */
      }

      // Owner from post-bump task — skip resolveActiveTask (second workspace walk).
      if (currentTask?.ownerAgent) {
        lines.push(
          `- Owner: ${currentTask.ownerAgent}${currentTask.ownerIdentity ? `/${currentTask.ownerIdentity}` : ''}${currentTask.yieldStatus === 'yielded' ? ' (yielded — awaiting accept)' : ''}`
        )
      }
    }
    const others = overview.all.filter((v) => !v.isCurrent)
    if (others.length > 0) {
      lines.push(`- ${others.length} task(s) active in other workspace(s)`)
    }
    if (!overview.current && others.length > 0) {
      lines.push(
        '- This workspace idle but siblings busy — `prjct work` auto-isolates to a worktree when needed'
      )
    }
  } catch {
    /* best-effort */
  }

  // Parallel secondary signals (queue / ship / inbox / handoff / git) —
  // started before the active-work block so the git fork overlaps it.
  const [handoff, ...restSignals] = await secondaryPromise
  // A pending handoff is a transient signal, not standing state — gated per
  // content it fires once, not on every prompt until accepted.
  if (handoff) events.push({ key: 'handoff', text: handoff })
  for (const line of restSignals) {
    if (line) {
      lines.push(line)
    }
  }

  if (lines.length === 1 && events.length === 0) return null
  return { standing: lines.length > 1 ? lines.join('\n') : null, events }
}

/** Joined standing+events block — the sessionless fallback payload shape. */
export async function buildProjectState(
  projectPath: string,
  preloaded?: LocalConfig | null,
  opts: { skipHandoff?: boolean } = {}
): Promise<string | null> {
  const parts = await buildProjectStateParts(projectPath, preloaded, opts)
  if (!parts) return null
  return joinStateParts(parts, parts.events)
}

/** Assemble the emitted block from standing (or not) plus fresh events. */
function joinStateParts(parts: ProjectStateParts, freshEvents: StateEvent[]): string | null {
  const eventBlock = freshEvents.map((event) => event.text).join('\n')
  if (parts.standing && eventBlock) return `${parts.standing}\n${eventBlock}`
  if (parts.standing) return parts.standing
  if (eventBlock) return `# prjct: signals\n${eventBlock}`
  return null
}

/**
 * Secondary state probes, all independent: pending handoff cue, queued
 * tasks, git branch/tree snapshot, last ship, memory inbox count. Each is
 * fail-soft (null on any error) so one broken probe never sinks the block.
 */
function collectSecondarySignals(
  config: LocalConfig,
  projectPath: string,
  opts: { skipHandoff?: boolean } = {}
): Promise<Array<string | null>> {
  return Promise.all([
    // skipHandoff: the session context riding this same payload (Kimi first
    // prompt) already carries the pending-handoff cue — probing again here
    // would inject it twice in one payload.
    opts.skipHandoff
      ? Promise.resolve(null)
      : (async (): Promise<string | null> => {
          try {
            const { formatPendingHandoffCue } = await import('../services/agent-switch')
            const cue = formatPendingHandoffCue(config.projectId)
            return cue ? `- ${cue.replace(/\n/g, '\n- ')}` : null
          } catch {
            return null
          }
        })(),
    (async (): Promise<string | null> => {
      try {
        const pending = await queueStorage.getActiveTasks(config.projectId)
        return pending.length > 0
          ? `- Pending: ${pending.length} · Next: "${pending[0]!.description}"`
          : null
      } catch {
        return null
      }
    })(),
    (async (): Promise<string | null> => {
      try {
        if (!(await fileExists(path.join(projectPath, '.git')))) return null
        const git = await captureGit(projectPath)
        if (!git.branch) return null
        const wtBits: string[] = []
        if (git.modified > 0) wtBits.push(`${git.modified} modified`)
        if (git.staged > 0) wtBits.push(`${git.staged} staged`)
        if (git.untracked > 0) wtBits.push(`${git.untracked} untracked`)
        const wt = wtBits.length > 0 ? ` — working tree ${wtBits.join(', ')}` : ''
        const ahead = git.ahead > 0 ? `${wt ? ',' : ' —'} ${git.ahead} unpushed` : ''
        return `- Branch: ${git.branch}${wt}${ahead}`
      } catch {
        return null
      }
    })(),
    (async (): Promise<string | null> => {
      try {
        const recent = await shippedStorage.getRecent(config.projectId, 1)
        if (recent.length === 0) return null
        const last = recent[0]!
        const ago = formatRelative(last.shippedAt ?? '')
        const label = last.version ? `v${last.version}` : last.name
        return `- Last ship: ${label} (${ago})`
      } catch {
        return null
      }
    })(),
    (async (): Promise<string | null> => {
      try {
        const inboxCount = projectMemory.countByType(config.projectId, 'inbox')
        return inboxCount > 0 ? `- Inbox: ${inboxCount} items pending` : null
      } catch {
        return null
      }
    })(),
  ])
}

/**
 * At most ONE preventive entry (gotcha / anti-pattern) whose content
 * BM25-matches the prompt's keywords, as a one-line cue. Best-effort —
 * any failure returns null and the state block ships without it.
 */
interface TopicalCueResult {
  cue: string
  memoryId: string
}

export interface SelectiveGuidanceResult {
  text: string
  memoryIds: string[]
}

function isValidGuidanceEntry(entry: { type: string; tags: Record<string, string> }): boolean {
  if (entry.type === 'voice' || entry.type === 'glossary') return true
  return (
    entry.type === 'example' &&
    Boolean(entry.tags.domain) &&
    (entry.tags.polarity === 'good' || entry.tags.polarity === 'bad')
  )
}

/**
 * Selective, bounded guidance for a prompt. Generic action words never open
 * the memory floodgate: topical lookup requires a distinctive token, while
 * explicit delivery intents may additionally use entries tagged for that
 * delivery domain.
 */
export function buildSelectiveGuidance(
  projectId: string,
  prompt: string
): SelectiveGuidanceResult | null {
  try {
    const intent = classifyDeliveryIntent(prompt)
    const distinctive = extractKeywords(prompt).filter(
      (token) => token.length >= 5 && !GENERIC_GUIDANCE_TOKENS.has(token)
    )
    const topical =
      distinctive.length > 0
        ? projectMemory.searchFts(projectId, distinctive, CUE_CANDIDATES * 2)
        : []
    const delivery = intent
      ? projectMemory
          .recall(projectId, {
            types: ['voice', 'glossary', 'example'],
            limit: CUE_CANDIDATES * 2,
          })
          .filter((entry) => entry.tags.domain === 'delivery' || entry.tags.domain === intent)
      : []
    const unique = new Map([...topical, ...delivery].map((entry) => [entry.id, entry]))
    const typeRank = new Map([
      ['voice', 0],
      ['glossary', 1],
      ['example', 2],
    ])
    const selected = [...unique.values()]
      .filter(isValidGuidanceEntry)
      .sort((a, b) => (typeRank.get(a.type) ?? 3) - (typeRank.get(b.type) ?? 3))
      .slice(0, GUIDANCE_MAX_ENTRIES)
    if (selected.length === 0) return null

    const lines = ['# prjct: selective guidance']
    for (const entry of selected) {
      const qualifiers =
        entry.type === 'example'
          ? ` ${entry.tags.polarity}/${entry.tags.domain}`
          : entry.tags.domain
            ? ` ${entry.tags.domain}`
            : ''
      const available = GUIDANCE_BUDGET - lines.join('\n').length - qualifiers.length - 8
      if (available < 24) break
      const content = safeTruncate(
        entry.content.replace(/\s+/g, ' ').trim(),
        Math.min(150, available)
      )
      lines.push(`- ${entry.type}${qualifiers}: ${content}`)
    }
    if (lines.length === 1) return null
    return {
      text: safeTruncate(lines.join('\n'), GUIDANCE_BUDGET),
      memoryIds: selected.slice(0, lines.length - 1).map((entry) => entry.id),
    }
  } catch {
    return null
  }
}

function appendPromptSection(
  payload: string,
  section: string | null | undefined,
  budget = STATE_BUDGET
): string | null {
  if (!section) return payload
  const candidate = payload ? `${payload}\n\n${section}` : section
  return candidate.length <= budget ? candidate : null
}

function buildTopicalCueResult(projectId: string, prompt: string): TopicalCueResult | null {
  try {
    const keywords = extractKeywords(prompt)
    if (keywords.length === 0) return null
    const hits = projectMemory.searchFts(projectId, keywords, CUE_CANDIDATES)
    const ranked =
      hits.find((e) => e.type === 'decision' || e.type === 'gotcha' || e.type === 'fact') ??
      hits.find((e) => e.type === 'anti-pattern' || e.type === 'pattern') ??
      hits.find((e) => e.type === 'gotcha' || e.type === 'anti-pattern')
    if (!ranked) return null
    if (ranked.type === 'decision' || ranked.type === 'gotcha' || ranked.type === 'fact') {
      return {
        cue: `> Tip→user (SoT): ${deriveTitle(ranked)}  \`${ranked.id}\` — say it briefly in chat; binding — do not contradict without superseding`,
        memoryId: ranked.id,
      }
    }
    if (ranked.type === 'anti-pattern' || ranked.type === 'pattern') {
      return {
        cue: `> Tip→user (suggest): ${deriveTitle(ranked)}  \`${ranked.id}\` — propose the live change in chat, then apply when editing`,
        memoryId: ranked.id,
      }
    }
    return { cue: `> Tip→user: ${deriveTitle(ranked)}  \`${ranked.id}\``, memoryId: ranked.id }
  } catch {
    return null
  }
}

export function buildTopicalCue(
  projectId: string,
  prompt: string,
  _projectPath?: string
): string | null {
  return buildTopicalCueResult(projectId, prompt)?.cue ?? null
}

interface GitSnapshot {
  branch: string
  modified: number
  staged: number
  untracked: number
  ahead: number
}

interface GitSnapshotCacheEntry {
  snapshot: GitSnapshot
  expiresAt: number
  indexMtimeMs: number
}

// The daemon serves hooks from a long-lived process, so agentic bursts
// (dozens of prompts per minute) would fork `git status` dozens of times
// for a snapshot that can't meaningfully change between turns. A short
// A 15s TTL plus .git/index mtime invalidation drops forks across both warm
// and cold hooks while still observing staged/branch changes immediately.
const gitSnapshotCache = new Map<string, GitSnapshotCacheEntry>()
const gitSnapshotTestState = { skipDiskSnapshotOnce: false }

/** Test-only: drop cached git snapshots so a test can observe fresh state. */
export function _resetGitSnapshotCacheForTests(): void {
  gitSnapshotCache.clear()
  gitSnapshotTestState.skipDiskSnapshotOnce = true
}

async function captureGit(projectPath: string): Promise<GitSnapshot> {
  const indexMtimeMs = await fs
    .stat(path.join(projectPath, '.git', 'index'))
    .then((stat) => stat.mtimeMs)
    .catch(() => 0)
  const cached = gitSnapshotCache.get(projectPath)
  if (cached && cached.expiresAt > Date.now() && cached.indexMtimeMs === indexMtimeMs) {
    return cached.snapshot
  }

  const diskPath = gitSnapshotPath(projectPath)
  // Disk only helps the FIRST touch of this path in this process (e.g. right
  // after a daemon restart, handed off from whichever process wrote it last).
  // Once an in-memory entry exists, its disk twin was written with the same
  // expiresAt at the same refresh — so if memory just expired, disk is
  // exactly as expired; re-reading+parsing it on every ~15s refresh through
  // a session is a guaranteed-miss disk round-trip. Gate on `!cached`, not
  // "memory check failed", so a live process never re-touches disk once it
  // has served this path at all.
  if (!cached && !gitSnapshotTestState.skipDiskSnapshotOnce) {
    const disk = await fs
      .readFile(diskPath, 'utf-8')
      .then((raw) => JSON.parse(raw) as GitSnapshotCacheEntry)
      .catch(() => null)
    if (disk && disk.expiresAt > Date.now() && disk.indexMtimeMs === indexMtimeMs) {
      gitSnapshotCache.set(projectPath, disk)
      return disk.snapshot
    }
  }
  gitSnapshotTestState.skipDiskSnapshotOnce = false

  const snapshot = await captureGitUncached(projectPath)
  // Bound the map: hooks only ever run for a handful of cwds per daemon,
  // but a runaway caller must not grow this unbounded.
  if (gitSnapshotCache.size > 32) gitSnapshotCache.clear()
  const entry = { snapshot, expiresAt: Date.now() + GIT_SNAPSHOT_TTL_MS, indexMtimeMs }
  gitSnapshotCache.set(projectPath, entry)
  // Fire-and-forget: this write only helps a DIFFERENT process (cross-process
  // handoff on cold start / restart) — it can never help the in-memory return
  // below, so awaiting it just adds disk I/O to this request's critical path.
  void fs
    .mkdir(path.dirname(diskPath), { recursive: true })
    .then(() => fs.writeFile(diskPath, JSON.stringify(entry)))
    .catch(() => undefined)
  return snapshot
}

function gitSnapshotPath(projectPath: string): string {
  const key = createHash('sha1').update(path.resolve(projectPath)).digest('hex').slice(0, 16)
  return path.join(DAEMON_PATHS.runDir(), `prompt-git-${key}.json`)
}

function promptHashKey(projectId: string, projectPath: string): string {
  const cwd = createHash('sha1').update(path.resolve(projectPath)).digest('hex').slice(0, 12)
  return `${projectId.replace(/[^a-zA-Z0-9._-]/g, '_')}-${cwd}`
}

async function dedupePromptPayload(
  projectId: string,
  projectPath: string,
  payload: string
): Promise<string | null> {
  const key = promptHashKey(projectId, projectPath)
  const hash = createHash('sha256').update(payload).digest('hex')
  if (promptPayloadHashes.get(key) === hash) return null
  if (promptPayloadHashes.size > 64) promptPayloadHashes.clear()
  promptPayloadHashes.set(key, hash)

  const stamp = path.join(DAEMON_PATHS.runDir(), `prompt-state-${key}.hash`)
  const previous = await fs.readFile(stamp, 'utf-8').catch(() => '')
  if (previous.trim() === hash) return null
  await fs
    .mkdir(path.dirname(stamp), { recursive: true })
    .then(() => fs.writeFile(stamp, hash))
    .catch(() => undefined)
  return payload
}

/**
 * Write the whole-payload stamp for the payload actually emitted. The
 * kimi/codex delta branch bypasses dedupePromptPayload (the stamp's only
 * other writer), but readPersistedPromptAfterEmit still validates the
 * persisted afterEmit record against this file — without the write, the
 * cold path's detached worker rebuilds the whole prompt every turn.
 */
async function writePromptStateStamp(
  projectId: string,
  projectPath: string,
  payload: string
): Promise<void> {
  const stamp = path.join(
    DAEMON_PATHS.runDir(),
    `prompt-state-${promptHashKey(projectId, projectPath)}.hash`
  )
  const hash = createHash('sha256').update(payload).digest('hex')
  await fs
    .mkdir(path.dirname(stamp), { recursive: true })
    .then(() => fs.writeFile(stamp, hash))
    .catch(() => undefined)
}

function promptAfterEmitStampPath(projectId: string, projectPath: string): string {
  return path.join(
    DAEMON_PATHS.runDir(),
    `prompt-afteremit-${promptHashKey(projectId, projectPath)}.json`
  )
}

/**
 * Persist the afterEmit record next to the payload hash in the run dir. The
 * cold path's detached afterEmit worker is a SEPARATE process where the
 * `promptAfterEmit` WeakMap is empty — without this record the worker had to
 * re-run the entire prompt build (buildProjectState + FTS queries) just to
 * recover surfacedIds/bumpTurn. Awaited (not fire-and-forget) so the file is
 * on disk before the parent can exit and spawn the worker.
 */
async function persistPromptAfterEmit(
  projectId: string,
  projectPath: string,
  payload: string,
  record: PromptAfterEmit
): Promise<void> {
  const stamp = promptAfterEmitStampPath(projectId, projectPath)
  const hash = createHash('sha256').update(payload).digest('hex')
  await fs
    .mkdir(path.dirname(stamp), { recursive: true })
    .then(() => fs.writeFile(stamp, JSON.stringify({ hash, record })))
    .catch(() => undefined)
}

/**
 * Read the parent's persisted afterEmit record. Valid only when its payload
 * hash still matches the emitted-payload stamp — a mismatch means the record
 * belongs to a different prompt (race or stale file) and the caller falls
 * back to recomputing. Fail-soft: any error returns null.
 */
async function readPersistedPromptAfterEmit(
  projectId: string,
  projectPath: string
): Promise<PromptAfterEmit | null> {
  try {
    const key = promptHashKey(projectId, projectPath)
    const runDir = DAEMON_PATHS.runDir()
    const [rawRecord, emittedHash] = await Promise.all([
      fs.readFile(path.join(runDir, `prompt-afteremit-${key}.json`), 'utf-8'),
      fs.readFile(path.join(runDir, `prompt-state-${key}.hash`), 'utf-8'),
    ])
    const parsed = JSON.parse(rawRecord) as { hash?: string; record?: PromptAfterEmit }
    const record = parsed.record
    if (!record || parsed.hash !== emittedHash.trim()) return null
    if (record.projectId !== projectId || !Array.isArray(record.surfacedIds)) return null
    // Records persisted by older versions lack emittedChars — normalize so
    // the context-tax accumulator never sees undefined.
    return {
      ...record,
      emittedChars: typeof record.emittedChars === 'number' ? record.emittedChars : 0,
    }
  } catch {
    return null
  }
}

async function captureGitUncached(projectPath: string): Promise<GitSnapshot> {
  const empty: GitSnapshot = { branch: '', modified: 0, staged: 0, untracked: 0, ahead: 0 }
  const safe = async (args: string[]): Promise<string> => {
    try {
      const r = await execFileAsync('git', args, { cwd: projectPath, timeout: 2000 })
      return r.stdout.trim()
    } catch {
      return ''
    }
  }

  // Hook fires on every prompt; 3 sequential git forks cost ~15-45ms.
  // Running them in parallel collapses to a single round-trip (~5-15ms).
  // `@{u}` returns empty when no upstream is set; treat as 0 unpushed.
  const [branch, status, aheadStr] = await Promise.all([
    safe(['branch', '--show-current']),
    safe(['status', '--porcelain']),
    safe(['rev-list', '--count', '@{u}..HEAD']),
  ])
  if (!branch) return empty

  const { modified, staged, untracked } = status
    .split('\n')
    .filter(Boolean)
    .reduce(
      (counts, line) => {
        const code = line.slice(0, 2)
        if (code.startsWith('??')) counts.untracked++
        else {
          if (code[0] !== ' ' && code[0] !== '?') counts.staged++
          if (code[1] !== ' ') counts.modified++
        }
        return counts
      },
      { modified: 0, staged: 0, untracked: 0 }
    )

  const ahead = Number.parseInt(aheadStr, 10) || 0

  return { branch, modified, staged, untracked, ahead }
}

// Coarse buckets on purpose: minute/hour-level strings ("47m ago",
// "3h ago") flip constantly between turns — diff-noise the model must
// re-read for zero added signal (token-cache audit R1). Day-level
// resolution is all the state block needs.
function formatRelative(isoTimestamp: string): string {
  if (!isoTimestamp) return 'unknown'
  const t = Date.parse(isoTimestamp)
  if (Number.isNaN(t)) return 'unknown'
  const days = Math.max(0, Math.floor((Date.now() - t) / 86_400_000))
  if (days < 1) return 'today'
  if (days < 2) return 'yesterday'
  if (days < 30) return `${days}d ago`
  return `${Math.floor(days / 30)}mo ago`
}

interface PromptGuidanceComputation {
  prioritized: string
  /** Only the per-prompt cue sections that made the budget — the delta
   *  payload for non-caching hosts when the state block is unchanged. */
  cueOnly: string
  cueResult: TopicalCueResult | null
  guidance: SelectiveGuidanceResult | null
  guidanceIncluded: boolean
  guidanceRuleId: string | null
}

/**
 * Shared by the fast in-process `build:` path and `rebuildPromptAfterEmit`'s
 * cross-process fallback (the `afterEmit:` WeakMap cache doesn't survive a
 * detached/re-entrant hook invocation) — one computation, not two drifting
 * copies of the same prioritized-payload + guidance-attribution logic.
 */
function computePromptGuidance(
  projectId: string,
  prompt: string,
  state: string,
  budget = STATE_BUDGET
): PromptGuidanceComputation {
  const cueResult = buildTopicalCueResult(projectId, prompt)
  const files = buildIndexedFileCue(projectId, prompt)
  const delivery = buildDeliveryGuidance(prompt)
  const guidance = buildSelectiveGuidance(projectId, prompt)
  const sections = [cueResult?.cue, delivery, guidance?.text, files].filter(
    (section): section is string => Boolean(section)
  )
  const prioritized = sections.reduce<string>(
    (payload, section) => appendPromptSection(payload, section, budget) ?? payload,
    safeTruncate(state, budget)
  )
  const cueOnly = sections.filter((section) => prioritized.includes(section)).join('\n\n')
  const guidanceIncluded = Boolean(guidance?.text && prioritized.includes(guidance.text))
  const deliveryIncluded = Boolean(delivery && prioritized.includes(delivery))
  const guidanceRuleId = deliveryIncluded
    ? `delivery:${classifyDeliveryIntent(prompt) ?? 'unknown'}`
    : guidanceIncluded
      ? (guidance?.memoryIds[0] ?? null)
      : null
  return { prioritized, cueOnly, cueResult, guidance, guidanceIncluded, guidanceRuleId }
}

export function runPromptHook(projectPath: string = process.cwd(), io?: HookIo): Promise<void> {
  return runHook<HookInput>(
    {
      event: 'UserPromptSubmit',
      projectPath,
      build: async (input, p, host) => {
        const prompt = (input.prompt ?? '').trim()
        if (!prompt) return null
        const config = await configManager.readConfig(p)
        if (!config?.projectId) return null
        // Kimi: SessionStart stdout never reaches the model, so the persona /
        // cold-start digest parked by the session-start hook is injected HERE,
        // on the session's first prompt only (stamp consumed = deduped).
        // Consumed BEFORE the state build: when the session context rides
        // this payload it already carries the pending-handoff cue, so the
        // state block skips its own handoff probe (no double injection).
        const kimiInjection =
          host === 'kimi'
            ? await consumeKimiSessionInjection(config.projectId, input.session_id, host).catch(
                () => null
              )
            : null
        // PULL-FIRST / EVENT-ONLY: standing state (cycle, branch, ships) is
        // delivered ONCE per session and re-delivered only on material change
        // — the agent can always pull it via `prjct context`. Per-turn the
        // hook speaks only when a transient signal appears or escalates
        // (loop cue, budget crossing, delegation, alignment, handoff) or a
        // preventive cue matches the prompt (the one PUSH exception). Every
        // block flows through the delivery gate; a silent turn emits nothing.
        const parts = await buildProjectStateParts(p, config, {
          skipHandoff: Boolean(kimiInjection),
        })
        const sessionContext = kimiInjection
          ? kimiInjection === 'reanchor'
            ? await buildCompactReanchor(p, config).catch(() => null)
            : await buildSessionContext(p, config, { digest: kimiInjection === 'digest' }).catch(
                () => null
              )
          : null
        if (!parts && !sessionContext) return null
        const sessionId = input.session_id ?? input.conversation_id
        const budget = sessionContext ? KIMI_FIRST_PROMPT_BUDGET : STATE_BUDGET
        const bumpTurn = Boolean(parts?.standing?.includes('Active work cycle:'))

        // Suppression needs a session scope: without an identity a shared
        // stamp would suppress a brand-new session, so fall through to the
        // whole-payload dedupe floor instead.
        if (sessionId) {
          const gateBase = { projectId: config.projectId, projectPath: p, sessionId }
          // Kimi first prompt: the parked SessionStart payload rides this
          // turn — force-emit (and restamp) so the model gets one complete
          // grounding block; suppression starts on the next prompt.
          const force = Boolean(sessionContext)
          // PROBE first (no stamp writes): the assembly below truncates to a
          // budget, and stamping content the truncation cut would suppress it
          // for the whole session without the model ever seeing it. Stamps
          // are written at the end, only for parts fully inside `emitted`.
          const standingGate = parts?.standing
            ? await gateDelivery({
                ...gateBase,
                surface: 'prompt-state',
                content: parts.standing,
                normalize: normalizeStateForMaterialChange,
                full: force,
                probe: true,
              })
            : null
          const freshEvents: StateEvent[] = []
          for (const event of parts?.events ?? []) {
            const eventGate = await gateDelivery({
              ...gateBase,
              surface: 'prompt-cues',
              key: `event:${event.key}`,
              content: event.text,
              normalize: normalizeStateForMaterialChange,
              full: force,
              probe: true,
            })
            if (!eventGate.suppressed) freshEvents.push(event)
          }
          // WHOLE-PART packing under the budget (never truncate the joined
          // blob): a part that doesn't fit this turn stays UNSTAMPED and
          // re-emits when it can lead a later turn; a part that can never
          // fit (alone over budget) is truncated once and stamped in full so
          // it cannot loop. Stamping truncated-away content would suppress
          // it for the whole session without the model ever seeing it.
          const standingFresh = Boolean(parts?.standing) && standingGate?.suppressed === false
          const stateCandidates: Array<{ key?: string; text: string; standing: boolean }> = [
            ...(standingFresh && parts?.standing ? [{ text: parts.standing, standing: true }] : []),
            ...freshEvents.map((event) => ({
              key: `event:${event.key}`,
              text: event.text,
              standing: false,
            })),
          ]
          const stateBudget = Math.max(
            budget - (sessionContext ? sessionContext.length + 2 : 0),
            200
          )
          const packed = stateCandidates.reduce<{
            blocks: string[]
            used: number
            stamps: Array<{ key?: string; text: string; standing: boolean }>
            hasStanding: boolean
          }>(
            (acc, candidate) => {
              const sep = acc.used > 0 ? 1 : 0
              if (acc.used + sep + candidate.text.length <= stateBudget) {
                acc.blocks.push(candidate.text)
                acc.used += sep + candidate.text.length
                acc.stamps.push(candidate)
                if (candidate.standing) acc.hasStanding = true
              } else if (acc.used === 0) {
                // Alone over budget: deliver best-effort once, stamp in full.
                // (−20 leaves room for the '# prjct: signals' header line.)
                acc.blocks.push(safeTruncate(candidate.text, stateBudget - 20))
                acc.used = stateBudget
                acc.stamps.push(candidate)
                if (candidate.standing) acc.hasStanding = true
              }
              return acc
            },
            { blocks: [], used: 0, stamps: [], hasStanding: false }
          )
          const stateBlock =
            packed.blocks.length === 0
              ? null
              : packed.hasStanding
                ? packed.blocks.join('\n')
                : `# prjct: signals\n${packed.blocks.join('\n')}`
          const base = [sessionContext, stateBlock].filter(Boolean).join('\n\n')
          // Narrow push exceptions: one preventive cue plus selective delivery
          // and authored guidance — gated as one blob by content so a repeat
          // of the same cue ships once per session, not once per prompt.
          // appendPromptSection only adds whole sections that fit, so nothing
          // below ever needs a post-hoc truncation.
          const { prioritized, cueOnly, cueResult, guidance, guidanceIncluded, guidanceRuleId } =
            computePromptGuidance(config.projectId, prompt, base, budget)
          const cueGate = cueOnly
            ? await gateDelivery({
                ...gateBase,
                surface: 'prompt-cues',
                key: 'guidance',
                content: cueOnly,
                full: force,
                probe: true,
              })
            : null
          const cueFresh = Boolean(cueOnly) && cueGate?.suppressed === false
          const emitted = cueFresh ? prioritized || null : base || null
          // Stamp exactly what was delivered (same normalize as the probes,
          // or probe/stamp hashes would never agree and suppression dies).
          for (const stamp of packed.stamps) {
            await gateDelivery({
              ...gateBase,
              surface: stamp.standing ? 'prompt-state' : 'prompt-cues',
              ...(stamp.key ? { key: stamp.key } : {}),
              content: stamp.text,
              normalize: normalizeStateForMaterialChange,
              full: true,
            })
          }
          if (cueFresh && cueOnly) {
            await gateDelivery({
              ...gateBase,
              surface: 'prompt-cues',
              key: 'guidance',
              content: cueOnly,
              full: true,
            })
          }
          // Attribution must credit only what the model actually received:
          // a turn whose cues were suppressed surfaced nothing. bumpTurn
          // still advances every prompt (the loop guard counts turns, not
          // emissions).
          const record: PromptAfterEmit = {
            projectId: config.projectId,
            projectPath: p,
            bumpTurn,
            surfacedIds: cueFresh
              ? [
                  ...(cueResult ? [cueResult.memoryId] : []),
                  ...(guidanceIncluded ? (guidance?.memoryIds ?? []) : []),
                ]
              : [],
            guidanceRuleId: cueFresh ? guidanceRuleId : null,
            emittedChars: emitted?.length ?? 0,
          }
          promptAfterEmit.set(input as object, record)
          await persistPromptAfterEmit(config.projectId, p, emitted ?? '', record)
          // Keep the whole-payload stamp in sync with the EMITTED payload —
          // readPersistedPromptAfterEmit validates against it, and without
          // this write the cold path's detached afterEmit worker would fall
          // back to a full rebuild on every prompt.
          await writePromptStateStamp(config.projectId, p, emitted ?? '')
          return emitted
        }

        // Sessionless floor: assemble the full block and dedupe the whole
        // payload — identical repeats collapse, any byte change re-emits.
        const state = parts ? joinStateParts(parts, parts.events) : null
        const base = [sessionContext, state].filter(Boolean).join('\n\n')
        const { prioritized, cueResult, guidance, guidanceIncluded, guidanceRuleId } =
          computePromptGuidance(config.projectId, prompt, base, budget)
        const afterEmitRecord: PromptAfterEmit = {
          projectId: config.projectId,
          projectPath: p,
          bumpTurn,
          surfacedIds: [
            ...(cueResult ? [cueResult.memoryId] : []),
            ...(guidanceIncluded ? (guidance?.memoryIds ?? []) : []),
          ],
          guidanceRuleId,
          emittedChars: 0,
        }
        // Resolve the dedupe BEFORE building the record so emittedChars
        // reflects what the model actually received (0 when deduped).
        const deduped = await dedupePromptPayload(config.projectId, p, prioritized)
        const record: PromptAfterEmit = { ...afterEmitRecord, emittedChars: deduped?.length ?? 0 }
        promptAfterEmit.set(input as object, record)
        // Hand the record to the cold path's detached afterEmit worker (a
        // separate process — the WeakMap above is empty there) so it never
        // recomputes the whole prompt build to recover surfacedIds/bumpTurn.
        await persistPromptAfterEmit(config.projectId, p, prioritized, record)
        return deduped
      },
      afterEmit: async (input, p, host) => {
        const pending =
          promptAfterEmit.get(input as object) ?? (await rebuildPromptAfterEmit(input, p))
        promptAfterEmit.delete(input as object)
        if (!pending) return
        await Promise.all([
          pending.bumpTurn
            ? stateStorage.bumpTurnCount(pending.projectId).then(() => undefined)
            : Promise.resolve(),
          pending.surfacedIds.length > 0
            ? recordSurfacedForActiveTask(
                pending.projectId,
                pending.projectPath,
                pending.surfacedIds
              )
            : Promise.resolve(),
          pending.guidanceRuleId
            ? Promise.resolve(
                instructionFailureStorage.recordGuidanceActivation(pending.projectId, {
                  ruleId: pending.guidanceRuleId,
                })
              ).then(() => undefined)
            : Promise.resolve(),
          // prjct's own context tax, accumulated per active cycle so
          // `prjct product cost` can prove it against host totals. Only
          // meaningful with an active cycle (token_usage is cycle-keyed).
          pending.emittedChars > 0
            ? stateStorage
                .getCurrentTask(pending.projectId)
                .then((task) =>
                  recordHookEmissionChars(pending.projectId, task?.id, pending.emittedChars, host)
                )
                .catch(() => undefined)
            : Promise.resolve(),
        ])
      },
    },
    io
  )
}

async function rebuildPromptAfterEmit(
  input: HookInput,
  projectPath: string
): Promise<PromptAfterEmit | null> {
  const prompt = (input.prompt ?? '').trim()
  if (!prompt) return null
  const config = await configManager.readConfig(projectPath).catch(() => null)
  if (!config?.projectId) return null
  // Fast path: the parent process persisted the record next to the payload
  // hash — read it instead of recomputing the entire prompt build below.
  const persisted = await readPersistedPromptAfterEmit(config.projectId, projectPath)
  if (persisted) return persisted
  // Fallback (record missing/stale): recompute from live state.
  const [task, state] = await Promise.all([
    stateStorage.getCurrentTask(config.projectId).catch(() => null),
    buildProjectState(projectPath, config),
  ])
  const { cueResult, guidance, guidanceIncluded, guidanceRuleId } = computePromptGuidance(
    config.projectId,
    prompt,
    state ?? ''
  )
  return {
    projectId: config.projectId,
    projectPath,
    bumpTurn: Boolean(task),
    surfacedIds: [
      ...(cueResult ? [cueResult.memoryId] : []),
      ...(guidanceIncluded ? (guidance?.memoryIds ?? []) : []),
    ],
    guidanceRuleId,
    // Recomputed fallback can't know what was actually emitted — record no
    // context tax rather than a guess (the fast path carries the real size).
    emittedChars: 0,
  }
}
