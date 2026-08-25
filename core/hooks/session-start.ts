/**
 * SessionStart hook — injects persona as additionalContext.
 *
 * Anti-harness contract: this hook **describes state**, never prescribes
 * action. Output is a short markdown block Claude reads as WHAT, not HOW.
 * No "first do X, then Y" — just "here's who you are". Claude decides
 * everything else.
 *
 * Claude Code invokes this via `prjct hook session-start`. Contract:
 *   stdin:  JSON with `source` ("startup" | "resume" | "clear" | "compact")
 *   stdout: JSON { hookSpecificOutput: { hookEventName, additionalContext } }
 *   exit 0: success (even when nothing to inject — emits `{}` instead).
 *
 * # Cache stability vs suppression (delivery-gate doctrine)
 *
 * Byte-stability governs the CONTENT of any emitted block — never
 * interpolate per-turn noise (an earlier version injected "Recent memory"
 * and busted Anthropic's cached prefix on every capture). It never
 * governed WHETHER to emit: suppressing a block removes bytes from the
 * message stream, it does not mutate a stable one. So:
 *   - `startup`/`clear` emit the full block (byte-stable) and stamp it.
 *   - `compact` emits only a ≤300-char re-anchor — the host just SUMMARIZED
 *     the full block; re-sending 4KB it already condensed is pure waste.
 *   - `resume` emits nothing when this session was already grounded
 *     (delivery-gate stamp), persona-only otherwise.
 * The output is also reused by `subagent-start` and `cwd-changed`, both of
 * which can fire mid-session — those stay persona-only and byte-identical.
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import { DAEMON_PATHS } from '../daemon/protocol'
import configManager from '../infrastructure/config-manager'
import { isSyncCurrent, runSelfHeal } from '../infrastructure/self-heal'
import { deriveTitle, formatMemoryDigestLine } from '../memory/format'
import { projectMemory } from '../memory/project-memory'
import { recordAgentSessionStart } from '../services/agent-session-recorder'
import { extractDeveloperRules } from '../services/developer-profile'
import { findRepeatMissedEntry } from '../services/memory-index'
import { getActiveProjectStyle } from '../services/project-style-evolution'
import { formatProjectStyleDigest } from '../services/project-style-profile'
import { createStalenessChecker } from '../services/staleness-checker'
import { usefulnessService } from '../services/usefulness'
import type { LocalConfig, ProjectPersona } from '../types/config'
import { VERSION } from '../utils/version'
import { type HookIo, runHook } from './_runner'
import { safeTruncate } from './_shared'

interface HookInput {
  source?: 'startup' | 'resume' | 'clear' | 'compact'
  session_id?: string
}

/** Delivery-gate marker: this session already received the grounding block. */
const SESSION_GROUNDED_MARKER = 'session-start-delivered'
/** Emitted chars per invocation, for the afterEmit context-tax accumulator. */
const sessionStartEmitChars = new WeakMap<object, number>()

interface SessionContextOptions {
  /**
   * Append the project-knowledge digest (top gotchas + decisions + developer
   * profile pointer). OFF by default — see the cache-stability note below.
   * Only the cold-start sources (`startup`/`clear`/`compact`) pass `true`.
   */
  digest?: boolean
}

const DIGEST_MAX_CHARS = 1600
const DIGEST_PER_TYPE = 3
/** How many developer rules to push on cold start (apply without MCP pull). */
const DIGEST_DEV_RULES = 4
/** Teaser sizing for the knowledge-digest lines (see `formatMemoryDigestLine`). */
const DIGEST_TEASER = { minTeaser: 24, maxTeaser: 90 }

/**
 * Build the additionalContext body for the current project.
 *
 * `preloadedConfig` lets the caller skip a duplicate disk read — the
 * hook entry point reads config once and passes it down. Tests can
 * keep calling this with just `projectPath` and we'll read it ourselves.
 *
 * # Why the digest is gated (cache stability)
 *
 * The persona block is intentionally byte-identical across turns: this
 * output is reused by `subagent-start` and `cwd-changed` (which fire
 * mid-session), and any byte change busts Anthropic's cached system-prompt
 * prefix (10× re-tokenization cost). The variable knowledge digest is
 * therefore injected ONLY on cold-start sources — `startup`/`clear`/
 * `compact` — where the context is being built fresh anyway (no warm prefix
 * to bust) and grounding matters most: a freshly-updated model starts blank
 * and SQLite-backed memory is the only thing that survived the update. The
 * mid-session reusers call this with `digest` unset → persona-only, byte-identical.
 */
export async function buildSessionContext(
  projectPath: string,
  preloadedConfig?: LocalConfig | null,
  opts: SessionContextOptions = {}
): Promise<string | null> {
  const config = preloadedConfig ?? (await configManager.readConfig(projectPath))
  if (!config?.projectId) return null

  const persona = config.persona
  // L0 memory index (Claude MEMORY.md pattern): compact TOC always-on when
  // digest is requested. Prefer stored/fresh stamp; fall back to legacy digest
  // only when the index cannot be built.
  const digest = opts.digest
    ? await (async (): Promise<string | null> => {
        try {
          const { memoryL0IndexForSession } = await import('../services/memory-index')
          const indexMd = memoryL0IndexForSession(config.projectId, { rebuildIfStale: true })
          return indexMd || buildKnowledgeDigest(config.projectId)
        } catch {
          return buildKnowledgeDigest(config.projectId)
        }
      })()
    : null
  // Start independent post-digest probes together. Each retains its original
  // failure contract, and output assembly below preserves their byte order.
  const stalenessPromise = buildStalenessNotice(projectPath, config.projectId)
  const vaultNoticePromise = import('../services/vault-retire-notice').then(
    ({ vaultRetirementNotice }) => vaultRetirementNotice(config, config.projectId)
  )
  const landCuePromise = (async (): Promise<string | null> => {
    try {
      const { buildLandCue } = await import('../services/land-cue')
      return await buildLandCue(config.projectId, projectPath, config)
    } catch {
      return null
    }
  })()
  const weakBannerPromise = (async (): Promise<string | null> => {
    try {
      const { effectiveWeakModelMode, weakModelBanner } = await import(
        '../services/weak-model-mode'
      )
      return effectiveWeakModelMode(config) === 'on' ? weakModelBanner() : null
    } catch {
      return null
    }
  })()
  const handoffCuePromise: Promise<string | null> = opts.digest
    ? (async () => {
        try {
          const { formatPendingHandoffCue } = await import('../services/agent-switch')
          const cue = formatPendingHandoffCue(config.projectId)
          return cue ? `# prjct: pending handoff\n${cue}` : null
        } catch {
          return null
        }
      })()
    : Promise.resolve(null)
  const continuityCuePromise: Promise<string | null> = opts.digest
    ? (async () => {
        try {
          const { loadSessionContinuity, formatContinuitySessionCue } = await import(
            '../services/session-continuity'
          )
          return formatContinuitySessionCue(loadSessionContinuity(config.projectId))
        } catch {
          return null
        }
      })()
    : Promise.resolve(null)
  // prjct does not infer the project's language — it states the gap and the
  // agent, which is already reading this repo, closes it once.
  const gauntletCuePromise: Promise<string | null> = opts.digest
    ? (async () => {
        try {
          const { gauntletBootstrapCue } = await import('../services/gauntlet')
          return await gauntletBootstrapCue(projectPath)
        } catch {
          return null
        }
      })()
    : Promise.resolve(null)
  const identityPromise = buildProjectIdentityLine(projectPath, config.projectId)
  const [
    staleness,
    vaultNotice,
    landCue,
    weakBanner,
    handoffCue,
    continuityCue,
    gauntletCue,
    identity,
  ] = await Promise.all([
    stalenessPromise,
    vaultNoticePromise,
    landCuePromise,
    weakBannerPromise,
    handoffCuePromise,
    continuityCuePromise,
    gauntletCuePromise,
    identityPromise,
  ])

  // Nothing to say (no identity, persona, knowledge, drift) → stay silent.
  if (
    !identity &&
    !persona &&
    !digest &&
    !staleness &&
    !vaultNotice &&
    !landCue &&
    !weakBanner &&
    !handoffCue &&
    !continuityCue
  ) {
    return null
  }

  const sections: string[] = ['# prjct: project context', '']

  if (identity) {
    sections.push(identity, '')
  }

  if (persona) {
    // One advisory line only — the recall verbs already live in the skill's
    // Primitives section; repeating them here cost tokens on every cold
    // start for zero new information (token-cache audit R5).
    sections.push(
      formatPersona(persona),
      '',
      '> Exposed as state, not prescription. Decide whether any of this matters for the current turn.'
    )
  }
  if (digest) {
    if (persona) sections.push('')
    sections.push(digest)
  }
  if (staleness) {
    if (persona || digest) sections.push('')
    sections.push(staleness)
  }
  if (vaultNotice) {
    if (persona || digest || staleness) sections.push('')
    sections.push(vaultNotice)
  }
  if (landCue) {
    if (persona || digest || staleness || vaultNotice) sections.push('')
    sections.push(landCue)
  }
  if (weakBanner) {
    if (persona || digest || staleness || vaultNotice || landCue) sections.push('')
    sections.push(weakBanner)
  }
  if (handoffCue) {
    if (persona || digest || staleness || vaultNotice || landCue || weakBanner) sections.push('')
    sections.push(handoffCue)
  }
  if (continuityCue) {
    if (persona || digest || staleness || vaultNotice || landCue || weakBanner || handoffCue) {
      sections.push('')
    }
    sections.push(continuityCue)
  }
  if (gauntletCue) {
    if (sections.length > 0) sections.push('')
    sections.push(gauntletCue)
  }
  return sections.join('\n')
}

/**
 * One-line drift notice: surfaced only on GENUINE staleness — code actually
 * changed since a real sync AND it crossed the threshold. The never-synced
 * bootstrap nag belongs to onboarding, not every session, so commitsSinceSync
 * must be > 0. Best-effort; never blocks the session block.
 */
async function buildStalenessNotice(
  projectPath: string,
  projectId: string
): Promise<string | null> {
  try {
    const checker = createStalenessChecker(projectPath)
    const status = await checker.check(projectId)
    if (!status.isStale || status.commitsSinceSync <= 0) return null
    const warning = checker.getWarning(status)
    if (!warning) return null
    // Continuous understanding: detach a lightweight sync so the map
    // refreshes without GSD-style full map-codebase thrash every phase.
    // SUPERIOR: stamp schedule/apply so we don't warn forever after refresh.
    try {
      const path = await import('node:path')
      const { resolveUserPath } = await import('../infrastructure/user-home')
      const { maybeDetachDriftRefresh, readDriftStamp, formatDriftNotice, driftStaleResolved } =
        await import('../services/drift-refresh')
      const cliHome = process.env.PRJCT_CLI_HOME
        ? path.resolve(process.env.PRJCT_CLI_HOME)
        : resolveUserPath('.prjct-cli')
      const initialStamp = readDriftStamp(cliHome)
      // If a recent apply already cleared staleness presentation, say so once.
      if (driftStaleResolved(initialStamp)) {
        return formatDriftNotice({
          warning,
          commitsSinceSync: status.commitsSinceSync,
          stamp: initialStamp,
          refreshScheduled: false,
        })
      }
      const refreshScheduled = maybeDetachDriftRefresh({
        projectPath,
        cliHome,
        commitsSinceSync: status.commitsSinceSync,
      })
      const stamp = readDriftStamp(cliHome)
      return formatDriftNotice({
        warning,
        commitsSinceSync: status.commitsSinceSync,
        stamp,
        refreshScheduled,
      })
    } catch {
      /* never block SessionStart */
    }
    // Symbol graph age: if sync is stale OR index missing, nudge code reindex.
    const symbolCue = await (async (): Promise<string> => {
      try {
        const { hasSymbolIndex, loadMeta } = await import('../domain/symbol-graph')
        if (!hasSymbolIndex(projectId)) {
          return ' Code graph empty — `prjct code reindex` (or `prjct sync`) before trace/impact.'
        }
        if (status.commitsSinceSync < 5) return ''
        const meta = loadMeta(projectId)
        const built = meta?.builtAt ? ` (index ${meta.builtAt.slice(0, 10)})` : ''
        return ` Symbol index may lag${built} — prefer \`prjct code reindex\` after big pulls.`
      } catch {
        return ''
      }
    })()
    return `**Understanding may be stale:** ${warning} — run \`prjct sync\` before big calls.${symbolCue}`
  } catch {
    return null
  }
}

/**
 * Compact, high-signal recall of what the project + developer already know —
 * cross-model-update grounding. Top traps + decisions + distilled developer
 * rules (apply-loop: push enough to act without pull instinct). Recency-
 * ranked with usefulness rerank; tightly truncated.
 */
function buildKnowledgeDigest(projectId: string): string | null {
  const memories = (() => {
    try {
      // Overfetch recency-ordered candidates, then allow the usefulness
      // ledger to reorder before taking the few digest slots.
      const gotchas = usefulnessService
        .rerank(
          projectId,
          projectMemory.recall(projectId, {
            types: ['gotcha', 'anti-pattern'],
            limit: DIGEST_PER_TYPE * 4,
          })
        )
        .slice(0, DIGEST_PER_TYPE)
      const decisions = usefulnessService
        .rerank(
          projectId,
          projectMemory.recall(projectId, { types: ['decision'], limit: DIGEST_PER_TYPE * 4 })
        )
        .slice(0, DIGEST_PER_TYPE)
      return { gotchas, decisions }
    } catch {
      return null
    }
  })()
  if (!memories) return null
  const { gotchas, decisions } = memories

  // Developer model: feedback + friction → actionable rules. Pushed here so
  // a cold model (post-update) acts as the developer without MCP pull.
  const devRules = (() => {
    try {
      const projectRules = projectMemory.recall(projectId, {
        types: ['feedback', 'improvement-signal'],
        limit: 40,
        dedupeByKey: false,
      })
      const globalRules = (() => {
        try {
          return projectMemory.recall('global-kb', {
            types: ['feedback', 'improvement-signal'],
            limit: 20,
            dedupeByKey: false,
          })
        } catch {
          return []
        }
      })()
      const pool = [...projectRules, ...globalRules]
      return extractDeveloperRules(pool, DIGEST_DEV_RULES)
    } catch {
      return []
    }
  })()

  const repeatMiss = findRepeatMissedEntry(
    projectId,
    new Set([...gotchas, ...decisions].map((e) => e.id))
  )
  // Project style (house rules) — dual to developer rules
  const projectStyleBlock = (() => {
    try {
      const style = getActiveProjectStyle(projectId)
      return style
        ? formatProjectStyleDigest(style, { maxConventions: 4, maxPatterns: 3, maxAnti: 2 })
        : null
    } catch {
      return null
    }
  })()

  if (
    gotchas.length === 0 &&
    decisions.length === 0 &&
    !repeatMiss &&
    devRules.length === 0 &&
    !projectStyleBlock
  ) {
    return null
  }

  const lines: string[] = ['## What this project already knows', '']
  lines.push(
    // Paired with the role block's "state, not prescription. Decide whether
    // any of this matters" a few lines earlier, "Apply these; do not re-derive
    // from source" read as a direct contradiction in one payload — one half
    // says judge it, the other says obey it and don't check. Say the useful
    // part: this is prior findings, and re-deriving them costs a rediscovery.
    '> Carried across sessions and model updates — this survived even if your conversation context did not. Prefer these over re-deriving from source; verify one before relying on it if the code may have moved.'
  )
  if (devRules.length > 0) {
    lines.push('', '**How this developer works (act as them):**')
    for (const r of devRules) {
      const short = r.rule.length > 140 ? `${r.rule.slice(0, 139)}…` : r.rule
      lines.push(`- ${short}  \`${r.sourceId}\``)
    }
  }
  if (projectStyleBlock) {
    // Fold style under digest without duplicating the outer header
    const body = projectStyleBlock
      .replace(/^## How this repo works \(project style\)\n?/, '')
      .trim()
    if (body) {
      lines.push('', '**How this repo works (match house style):**', body)
    }
  }
  if (gotchas.length > 0) {
    lines.push('', '**Traps to avoid:**')
    for (const e of gotchas) lines.push(`- ${formatMemoryDigestLine(e, DIGEST_TEASER)}`)
  }
  if (decisions.length > 0) {
    lines.push('', '**Decisions in force:**')
    for (const e2 of decisions) lines.push(`- ${formatMemoryDigestLine(e2, DIGEST_TEASER)}`)
  }
  if (repeatMiss) {
    lines.push(
      '',
      '**Keeps being missed:**',
      `- ${formatMemoryDigestLine(repeatMiss.entry, DIGEST_TEASER)} — flagged relevant-but-unused ${repeatMiss.count}×. Apply it or supersede it.`
    )
  }
  lines.push(
    '',
    '> Resolve any `mem_id` with `prjct search <id>`. Full developer model: MCP `prjct_developer`. Project style: `prjct analysis` / sync evolution.'
  )
  return safeTruncate(lines.join('\n'), DIGEST_MAX_CHARS)
}

const SUBAGENT_DIGEST_MAX_CHARS = 350
const SUBAGENT_GOTCHA_COUNT = 2

/**
 * Compact context for a spawned subagent: role, the active work cycle for THIS
 * worktree, and the top preventive traps. Subagents previously received the
 * persona block only and re-investigated facts the main session already knew.
 *
 * SubagentStart's response schema rejects `additionalContext`, so this is
 * emitted as `systemMessage` — outside the cached system-prompt prefix —
 * which is why variable content (the active work cycle) is safe here while the
 * SessionStart persona block must stay byte-identical.
 */
export async function buildSubagentDigest(projectPath: string): Promise<string | null> {
  const config = await configManager.readConfig(projectPath).catch(() => null)
  if (!config?.projectId) return null

  const lines: string[] = ['# prjct: subagent context']
  if (config.persona?.role) lines.push(`Role in this project: ${config.persona.role}`)

  try {
    const { resolveActiveTask } = await import('../services/task-service')
    const task = await resolveActiveTask(config.projectId, projectPath)
    if (task) lines.push(`Active work cycle (this worktree): ${task.description}`)
  } catch {
    // best-effort — a digest without the task is still useful
  }

  try {
    // Same proven-first selection as the session digest (see
    // buildKnowledgeDigest) — subagents do the bulk of the editing, so
    // their 2 trap slots should carry the entries that keep paying off,
    // not just the newest.
    const gotchas = usefulnessService
      .rerank(
        config.projectId,
        projectMemory.recall(config.projectId, {
          types: ['gotcha', 'anti-pattern'],
          limit: SUBAGENT_GOTCHA_COUNT * 4,
        })
      )
      .slice(0, SUBAGENT_GOTCHA_COUNT)
    if (gotchas.length > 0) {
      lines.push('Traps to avoid:')
      for (const e of gotchas) lines.push(`- ${deriveTitle(e)}  \`${e.id}\``)
    }
    // Same repeat-miss slot the session digest has: knowledge flagged
    // relevant-but-unused 2+ times reaches subagents too — they do the
    // bulk of the editing and were blind to it (review follow-up).
    const repeatMiss = findRepeatMissedEntry(config.projectId, new Set(gotchas.map((e) => e.id)))
    if (repeatMiss) {
      lines.push(`Keeps being missed: ${deriveTitle(repeatMiss.entry)}  \`${repeatMiss.entry.id}\``)
    }
  } catch {
    // best-effort
  }

  if (lines.length <= 1) return null
  return safeTruncate(lines.join('\n'), SUBAGENT_DIGEST_MAX_CHARS)
}

function formatPersona(persona: ProjectPersona): string {
  const lines: string[] = []
  lines.push(`## Your role in this project: **${persona.role}**`)
  if (persona.focus) lines.push(`Focus: ${persona.focus}`)
  if (persona.mcps && persona.mcps.length > 0) {
    lines.push(`Available MCPs this project expects: ${persona.mcps.join(', ')}`)
  }
  if (persona.packs && persona.packs.length > 0) {
    lines.push(`Active packs: ${persona.packs.join(', ')}`)
  }
  return lines.join('\n')
}

/**
 * Cwd-scoped project identity for L1 inject. Global skills stay portable;
 * this is the only place agents should learn "which repo am I in?".
 */
export async function buildProjectIdentityLine(
  projectPath: string,
  projectId: string
): Promise<string | null> {
  try {
    const path = await import('node:path')
    const { execFileAsync } = await import('../utils/exec')
    const name = path.basename(projectPath)
    const branch = await (async (): Promise<string> => {
      try {
        const { stdout } = await execFileAsync('git', ['branch', '--show-current'], {
          cwd: projectPath,
        })
        return stdout.trim()
      } catch {
        return ''
      }
    })()
    const shortId = projectId.length > 12 ? `${projectId.slice(0, 8)}…` : projectId
    const parts = [`## Project identity (cwd)`, `- **${name}** · id \`${shortId}\``]
    if (branch) parts.push(`- Branch: \`${branch}\``)
    parts.push(
      '- Skill is portable L0 — if skill text names another project, ignore it; trust this block + `prjct context --md`.'
    )
    return parts.join('\n')
  } catch {
    return null
  }
}

/**
 * Kimi session hand-off stamp.
 *
 * Kimi's SessionStart is observation-only: its stdout is NOT appended to
 * context (the docs only promise that for UserPromptSubmit). So under host
 * `kimi` this hook emits nothing and instead parks WHAT should have been
 * injected ('digest' on cold starts, 'persona' on resume) in a per-session
 * stamp under the daemon run dir (same pattern as the Stop heavy-step
 * stamps). The prompt hook consumes the stamp on the session's first
 * UserPromptSubmit and injects the payload there — exactly once.
 */
function kimiSessionStampPath(
  projectId: string,
  sessionId: string | undefined,
  host: string = 'kimi'
): string {
  const safeProject = projectId.replace(/[^a-zA-Z0-9._-]/g, '_')
  // Missing session_id used to collapse to the literal 'unknown', so every
  // concurrent session of one host shared a single stamp and clobbered each
  // other's parked payload. Namespace the fallback per project+host instead.
  const safeSession = (sessionId ?? `nosession-${host}`).replace(/[^a-zA-Z0-9._-]/g, '_')
  return path.join(DAEMON_PATHS.runDir(), `kimi-session-${safeProject}-${safeSession}.pending`)
}

/**
 * Read-and-consume the pending Kimi session injection. Returns what to
 * inject ('digest' = cold start, 'reanchor' = post-compact, 'persona' =
 * resume) or null when nothing is pending. Exported for the prompt hook
 * + tests.
 */
export async function consumeKimiSessionInjection(
  projectId: string,
  sessionId: string | undefined,
  host: string = 'kimi'
): Promise<'digest' | 'persona' | 'reanchor' | null> {
  const stamp = kimiSessionStampPath(projectId, sessionId, host)
  const content = await fs.readFile(stamp, 'utf-8').catch(() => null)
  if (content === null) return null
  await fs.rm(stamp, { force: true }).catch(() => undefined)
  const value = content.trim()
  if (value === 'digest') return 'digest'
  if (value === 'reanchor') return 'reanchor'
  return 'persona'
}

/**
 * Post-compact re-anchor: the host just summarized the whole conversation
 * (prjct's grounding block included), so re-sending it is pure waste. Emit
 * only what must survive verbatim: the land contract and the active cycle.
 */
export async function buildCompactReanchor(
  projectPath: string,
  preloadedConfig?: LocalConfig | null
): Promise<string | null> {
  const config = preloadedConfig ?? (await configManager.readConfig(projectPath).catch(() => null))
  if (!config?.projectId) return null
  const lines: string[] = ['# prjct: re-anchor (post-compact)']
  try {
    const { collectActiveTasks } = await import('../services/task-overview')
    const overview = await collectActiveTasks(config.projectId, projectPath)
    if (overview.current) {
      lines.push(
        `- Active cycle: "${overview.current.description}" · ${overview.current.id.slice(0, 8)}`
      )
    }
  } catch {
    /* best-effort */
  }
  try {
    const { buildLandCue } = await import('../services/land-cue')
    const cue = await buildLandCue(config.projectId, projectPath, config)
    if (cue) lines.push(cue)
  } catch {
    /* best-effort */
  }
  if (lines.length === 1) return null
  return safeTruncate(lines.join('\n'), 300)
}

/**
 * Top-level entry — read stdin, emit JSON, exit.
 * Never throws; hook failures must not break the host session.
 */
export function runSessionStartHook(
  projectPath: string = process.cwd(),
  io?: HookIo
): Promise<void> {
  // Captured by the build closure so afterEmit can reuse it without a
  // second disk read on the hot path that fires on every session start.
  const cachedConfig = configManager.readConfig(projectPath).catch(() => null)

  return runHook<HookInput>(
    {
      event: 'SessionStart',
      projectPath,
      build: async (input, p, host) => {
        const config =
          p === projectPath
            ? await cachedConfig
            : await configManager.readConfig(p).catch(() => null)
        // Source routing (delivery-gate doctrine, header note): startup/clear
        // rebuild context from scratch → full grounding block; compact just
        // summarized that block → ≤300-char re-anchor; resume still holds its
        // context → nothing (stamped) or persona-only (unstamped).
        const source = input.source ?? 'startup'
        const digest = source === 'startup' || source === 'clear'
        // Kimi's SessionStart never reaches the model (observation-only) —
        // park the payload for the prompt hook's first-turn injection and
        // emit nothing here (see kimiSessionStampPath above).
        if (host === 'kimi') {
          if (config?.projectId) {
            const stamp = kimiSessionStampPath(config.projectId, input.session_id, host)
            const parked = source === 'compact' ? 'reanchor' : digest ? 'digest' : 'persona'
            await fs
              .mkdir(path.dirname(stamp), { recursive: true })
              .then(() => fs.writeFile(stamp, parked))
              .catch(() => undefined)
          }
          return null
        }
        const emitted = await (async (): Promise<string | null> => {
          if (source === 'compact') return buildCompactReanchor(p, config)
          if (source === 'resume') {
            if (!config?.projectId) return buildSessionContext(p, config, {})
            const { gateDelivery } = await import('../services/session-context-cache')
            // Marker stamp: "this session was already grounded once". Written
            // at startup below; a resume that finds it emits nothing, a
            // resume without it (stamp GC'd, session began elsewhere) falls
            // back to persona-only.
            const gate = await gateDelivery({
              projectId: config.projectId,
              projectPath: p,
              sessionId: input.session_id,
              surface: 'session-start',
              content: SESSION_GROUNDED_MARKER,
            })
            return gate.suppressed ? null : buildSessionContext(p, config, {})
          }
          const full = await buildSessionContext(p, config, { digest })
          if (full && config?.projectId && input.session_id) {
            const { gateDelivery } = await import('../services/session-context-cache')
            await gateDelivery({
              projectId: config.projectId,
              projectPath: p,
              sessionId: input.session_id,
              surface: 'session-start',
              content: SESSION_GROUNDED_MARKER,
              full: true,
            })
          }
          return full
        })()
        if (emitted) sessionStartEmitChars.set(input as object, emitted.length)
        return emitted
      },
      afterEmit: async (_input, p, host) => {
        const config = await cachedConfig
        if (config?.projectId) {
          const activeTask = await (async (): Promise<{
            taskId: string | null
            goal: string | null
          }> => {
            try {
              const { collectActiveTasks } = await import('../services/task-overview')
              const overview = await collectActiveTasks(config.projectId, p)
              return {
                taskId: overview.current?.id ?? null,
                goal: overview.current?.description ?? _input.source ?? null,
              }
            } catch {
              return { taskId: null, goal: _input.source ?? null }
            }
          })()
          recordAgentSessionStart({
            projectId: config.projectId,
            sessionId: _input.session_id,
            directory: p,
            taskId: activeTask.taskId,
            goal: activeTask.goal,
          })
          // Context-tax attribution for the grounding block itself.
          const chars = sessionStartEmitChars.get(_input as object) ?? 0
          if (chars > 0 && activeTask.taskId) {
            try {
              const { recordHookEmissionChars } = await import('../services/work-cost-service')
              recordHookEmissionChars(
                config.projectId,
                activeTask.taskId,
                chars,
                host ?? 'claude',
                'session-start'
              )
            } catch {
              /* telemetry only */
            }
          }
        }

        // Self-heal hooks + global CLAUDE.md when the binary moved past the
        // last sync. Catches machines where postinstall is disabled by
        // security policy. Hot path is one fs read of the stamp file.
        if (!isSyncCurrent(VERSION)) {
          await runSelfHeal(VERSION).catch(() => undefined)
        }

        // M5: opt-in silent auto-update. No-op unless the user has opted
        // in via `prjct config set auto-update on`. Throttled to 1/hour
        // and runs detached so the session never waits.
        try {
          const { maybeAutoUpdate } = await import('../services/auto-updater')
          maybeAutoUpdate(VERSION)
        } catch {
          // never block the session on update mechanics
        }
      },
    },
    io
  )
}
