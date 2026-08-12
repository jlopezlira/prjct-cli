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
import { renderDelegationTrigger } from '../services/task-orchestration'
import { collectActiveTasks } from '../services/task-overview'
import { recordSurfacedForActiveTask } from '../services/usefulness/surface-attribution'
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

const STATE_BUDGET = 1500
/**
 * Turns on a single cycle before the state block escalates from "stay on goal"
 * to "stop looping". Set above a normal multi-step cycle so it only fires on a
 * genuine grind, not honest iteration.
 */
const STUCK_TURN_THRESHOLD = 15
/** FTS candidates fetched before the preventive-type filter picks ONE. */
const CUE_CANDIDATES = 8
const GUIDANCE_BUDGET = 420
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
}

const promptAfterEmit = new WeakMap<object, PromptAfterEmit>()
const promptPayloadHashes = new Map<string, string>()

interface HookInput {
  prompt?: string
}

/**
 * Build a "# prjct: project state" block — pure facts about where the
 * project is right now (active work, branch, working tree, recent
 * ships). The LLM reads it to disambiguate user intent without asking.
 *
 * Returns null when there's nothing useful to say (no project, no
 * git repo) so the caller can skip injection entirely.
 */
export async function buildProjectState(
  projectPath: string,
  preloaded?: LocalConfig | null
): Promise<string | null> {
  const config = preloaded !== undefined ? preloaded : await configManager.readConfig(projectPath)
  if (!config?.projectId) return null

  const lines: string[] = ['# prjct: project state']
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
      if ((config.land?.mode ?? 'advisory') !== 'off') {
        lines.push(
          '  ↳ Before session end: `prjct land` · hand-off `prjct remember context "Session close: …"`'
        )
      }
      // Read-only turn state. The increment moved to afterEmit so SQLite never
      // sits between the prompt event and the host-visible response.
      const { turns, loopVerdict, currentTask } = await (async () => {
        try {
          const task = await stateStorage.getCurrentTask(config.projectId)
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
      if (!loopVerdict?.stopped && turns < STUCK_TURN_THRESHOLD) {
        lines.push(
          '  ↳ Stay on this goal. Each turn, before acting: is this step ADVANCING it? If you have hit the same wall twice, or you are exploring rather than progressing, STOP — re-plan, split the cycle, or ask the user. Do not loop; finish the cycle, then `prjct status done`.'
        )
      }
      // Token budget — uses post-bump task (no extra SQLite read).
      try {
        const budget = config.maxTokensPerCycle ?? 0
        if (budget > 0 && currentTask) {
          const spent = (currentTask.tokensIn ?? 0) + (currentTask.tokensOut ?? 0)
          if (spent >= budget) {
            lines.push(
              `  ⚠ Token budget: ${spent.toLocaleString()} of ${budget.toLocaleString()} spent on this cycle. STOP growing it — ship the working slice, split the remainder into a new cycle, or check in with the user.`
            )
          } else if (spent >= budget * 0.8) {
            lines.push(
              `  ↳ Token budget: ${spent.toLocaleString()} of ${budget.toLocaleString()} (${Math.round((spent / budget) * 100)}%). Plan the close: prefer finishing over expanding scope.`
            )
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
          if (trigger) lines.push(`  ${trigger}`)
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
        if (card.markdown) {
          lines.push('')
          lines.push(card.markdown)
        }
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

  // Parallel secondary signals (queue / ship / inbox / handoff / git) — was serial.
  const secondary = await Promise.all([
    (async (): Promise<string | null> => {
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

  for (const line of secondary) {
    if (line) {
      lines.push(line)
    }
  }

  if (lines.length === 1) return null
  return lines.join('\n')
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

function appendPromptSection(payload: string, section: string | null | undefined): string | null {
  if (!section) return payload
  const candidate = payload ? `${payload}\n\n${section}` : section
  return candidate.length <= STATE_BUDGET ? candidate : null
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
  if (!gitSnapshotTestState.skipDiskSnapshotOnce) {
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
  await fs
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
  state: string
): PromptGuidanceComputation {
  const cueResult = buildTopicalCueResult(projectId, prompt)
  const files = buildIndexedFileCue(projectId, prompt)
  const delivery = buildDeliveryGuidance(prompt)
  const guidance = buildSelectiveGuidance(projectId, prompt)
  const prioritized = [cueResult?.cue, delivery, guidance?.text, files]
    .filter((section): section is string => Boolean(section))
    .reduce<string>(
      (payload, section) => appendPromptSection(payload, section) ?? payload,
      safeTruncate(state, STATE_BUDGET)
    )
  const guidanceIncluded = Boolean(guidance?.text && prioritized.includes(guidance.text))
  const deliveryIncluded = Boolean(delivery && prioritized.includes(delivery))
  const guidanceRuleId = deliveryIncluded
    ? `delivery:${classifyDeliveryIntent(prompt) ?? 'unknown'}`
    : guidanceIncluded
      ? (guidance?.memoryIds[0] ?? null)
      : null
  return { prioritized, cueResult, guidance, guidanceIncluded, guidanceRuleId }
}

export function runPromptHook(projectPath: string = process.cwd(), io?: HookIo): Promise<void> {
  return runHook<HookInput>(
    {
      event: 'UserPromptSubmit',
      projectPath,
      build: async (input, p) => {
        const prompt = (input.prompt ?? '').trim()
        if (!prompt) return null
        const config = await configManager.readConfig(p)
        if (!config?.projectId) return null
        // PUSH→PULL: the per-turn hook starts with lean project-state facts
        // (active work, branch, working tree) so the agent can disambiguate
        // intent without asking. General memory and improvement signals are
        // PULL — the agent fetches them on demand via
        // `prjct context memory <topic>`, `prjct guard <file>`, or the MCP
        // recall tools. Pushing keyword-matched memory into every prompt
        // matched on stopwords/noise and burned the context window with
        // entries the turn never needed.
        const state = await buildProjectState(p, config)
        if (!state) return null
        // Narrow push exceptions: one preventive cue plus selective delivery
        // and authored guidance. State leads; all sections share one budget.
        const { prioritized, cueResult, guidance, guidanceIncluded, guidanceRuleId } =
          computePromptGuidance(config.projectId, prompt, state)
        promptAfterEmit.set(input as object, {
          projectId: config.projectId,
          projectPath: p,
          bumpTurn: state.includes('Active work cycle:'),
          surfacedIds: [
            ...(cueResult ? [cueResult.memoryId] : []),
            ...(guidanceIncluded ? (guidance?.memoryIds ?? []) : []),
          ],
          guidanceRuleId,
        })
        return dedupePromptPayload(config.projectId, p, prioritized)
      },
      afterEmit: async (input, p) => {
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
  }
}
