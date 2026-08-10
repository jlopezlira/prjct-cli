/**
 * Pattern Detector — surface durable patterns from recent project work.
 *
 * Three detectors, all conservative + idempotent + best-effort:
 *
 * 1. Hot files — a file touched 3+ times in the last 7 days is a
 *    refactor candidate. (Original M2 scope.)
 * 2. Recurring bugs — gotchas with the same `topic` tag that appear
 *    2+ times across the last 30 days. Suggests a pattern bug worth
 *    investigation.
 * 3. Tech-debt growth — total TODO/FIXME/XXX count grew by 5+ since
 *    the last detection run. Suggests debt is accumulating without
 *    being addressed.
 *
 * All detectors persist findings as `learning` memory entries. The
 * lookup-first protocol in CLAUDE.md (M0) ensures Claude finds them
 * at session start and can propose action.
 *
 * Design contract (mem_899):
 *   - Best-effort, never blocks the Stop hook.
 *   - Idempotent: window-based dedup on each detector.
 *   - Conservative: noise > value. Each detector tuned for high
 *     precision over recall.
 */

import path from 'node:path'
import configManager from '../infrastructure/config-manager'
import { projectMemory } from '../memory/project-memory'
import type { LocalConfig } from '../types/config'
import { exitCodeMeans, runGit, throwProc } from '../utils/exec'

const HOT_FILE_PATTERN_TAG = 'hot-file'
const HOT_FILE_SOURCE_TAG = 'pattern-detector-auto'
const RECURRING_BUG_PATTERN_TAG = 'recurring-bug'
const RECURRING_BUG_SOURCE_TAG = 'pattern-detector-recurring'
const TECH_DEBT_PATTERN_TAG = 'tech-debt-growth'
const TECH_DEBT_SOURCE_TAG = 'pattern-detector-debt'

// Window + threshold tuned conservatively. 3+ touches over a week is
// "this file is the locus of recent activity" without flagging every
// daily-touched file in an active repo.
const WINDOW_DAYS = 7
const HOT_THRESHOLD = 3
// Recurring bugs: same topic tag must appear 2+ times across a longer
// window. Bugs cluster monthly more than weekly — using 30 days
// catches real patterns without re-flagging every day.
const RECURRING_WINDOW_DAYS = 30
const RECURRING_THRESHOLD = 2
// Tech debt: only flag when growth >= 5 since last snapshot. Smaller
// deltas are noise (refactors flush old TODOs and add new ones in
// passing). Using projectMemory as the storage layer for snapshots so
// we don't need a new table.
const TECH_DEBT_GROWTH_THRESHOLD = 5
// Skip noisy paths that are touched on every commit and offer no
// refactor signal.
const IGNORE_PATTERNS: readonly RegExp[] = [
  /^package(-lock)?\.json$/,
  /^bun\.lock(b)?$/,
  /^pnpm-lock\.yaml$/,
  /^yarn\.lock$/,
  /^CHANGELOG\.md$/,
  /^\.gitignore$/,
  /\.snap$/,
  /^dist\//,
  /^node_modules\//,
]

interface HotFile {
  path: string
  touches: number
}

interface DetectResult {
  scanned: number
  hotFiles: HotFile[]
  persisted: number
  skipped: { reason: string; file?: string }[]
  errors: string[]
}

/**
 * Public entry: run all three detectors, persist new insights. Stop
 * hook awaits this best-effort. Each detector is wrapped so a single
 * failure (e.g. git missing) never breaks the others.
 */
export async function detectAndPersistPatterns(
  projectPath: string,
  preloadedConfig?: LocalConfig | null
): Promise<DetectResult> {
  const result: DetectResult = {
    scanned: 0,
    hotFiles: [],
    persisted: 0,
    skipped: [],
    errors: [],
  }

  const config =
    preloadedConfig !== undefined
      ? preloadedConfig
      : await configManager.readConfig(projectPath).catch(() => null)
  if (!config?.projectId) {
    result.errors.push('no project config')
    return result
  }

  // 1. Hot files
  try {
    const hotFiles = await detectHotFiles(projectPath)
    result.scanned += hotFiles.length
    result.hotFiles = hotFiles
    if (hotFiles.length > 0) {
      const alreadyMarked = collectAlreadyMarkedHotFiles(config.projectId)
      for (const hf of hotFiles) {
        if (alreadyMarked.has(hf.path)) {
          result.skipped.push({ reason: 'already-marked-this-window', file: hf.path })
          continue
        }
        try {
          await projectMemory.remember(projectPath, {
            type: 'learning',
            content:
              `Hot file: \`${hf.path}\` — ${hf.touches} touches in the last ${WINDOW_DAYS} days. ` +
              `Worth a refactor pass or a deliberate decision about why it churns this often.`,
            tags: {
              source: HOT_FILE_SOURCE_TAG,
              pattern: HOT_FILE_PATTERN_TAG,
              file: hf.path,
              touches: String(hf.touches),
              window_days: String(WINDOW_DAYS),
            },
            provenance: 'inferred',
          })
          result.persisted += 1
        } catch (err) {
          result.errors.push(`remember failed for ${hf.path}: ${(err as Error).message}`)
        }
      }
    }
  } catch (err) {
    result.errors.push(`hot-file detection failed: ${(err as Error).message}`)
  }

  // 2. Recurring bugs
  try {
    const recurring = detectRecurringBugs(config.projectId)
    if (recurring.length > 0) {
      const alreadyMarked = collectAlreadyMarkedRecurringBugs(config.projectId)
      for (const r of recurring) {
        if (alreadyMarked.has(r.topic)) {
          result.skipped.push({
            reason: 'recurring-bug-already-marked',
            file: r.topic,
          })
          continue
        }
        try {
          await projectMemory.remember(projectPath, {
            type: 'learning',
            content:
              `Recurring bug pattern: gotchas tagged \`topic:${r.topic}\` reported ${r.occurrences} ` +
              `times in the last ${RECURRING_WINDOW_DAYS} days. Likely a real underlying issue — ` +
              `consider a focused investigation before patching the next instance.`,
            tags: {
              source: RECURRING_BUG_SOURCE_TAG,
              pattern: RECURRING_BUG_PATTERN_TAG,
              topic: r.topic,
              occurrences: String(r.occurrences),
              window_days: String(RECURRING_WINDOW_DAYS),
            },
            provenance: 'inferred',
          })
          result.persisted += 1
        } catch (err) {
          result.errors.push(`remember failed for recurring ${r.topic}: ${(err as Error).message}`)
        }
      }
    }
  } catch (err) {
    result.errors.push(`recurring-bug detection failed: ${(err as Error).message}`)
  }

  // 3. Tech-debt growth
  try {
    const debtSnapshot = await measureTechDebt(projectPath)
    if (debtSnapshot.totalCount > 0) {
      const previous = collectPreviousDebtSnapshot(config.projectId)
      const delta = debtSnapshot.totalCount - previous
      if (previous > 0 && delta >= TECH_DEBT_GROWTH_THRESHOLD) {
        try {
          await projectMemory.remember(projectPath, {
            type: 'learning',
            content:
              `Tech debt growing: TODO/FIXME/XXX count rose by ${delta} (now ${debtSnapshot.totalCount}, was ${previous}). ` +
              `Consider a focused debt-reduction pass before adding more features.`,
            tags: {
              source: TECH_DEBT_SOURCE_TAG,
              pattern: TECH_DEBT_PATTERN_TAG,
              total: String(debtSnapshot.totalCount),
              previous: String(previous),
              delta: String(delta),
            },
            provenance: 'inferred',
          })
          result.persisted += 1
        } catch (err) {
          result.errors.push(`remember failed for tech-debt: ${(err as Error).message}`)
        }
      }
    }
  } catch (err) {
    result.errors.push(`tech-debt detection failed: ${(err as Error).message}`)
  }

  return result
}

// Hot file detection

/**
 * Walk `git log --name-only` for the last WINDOW_DAYS, count touches per
 * path, drop ignore-listed paths, return ones over HOT_THRESHOLD.
 *
 * Uses `git log -z` so paths with newlines or quotes don't fragment the
 * parse. Returns sorted by touch count desc.
 */
async function detectHotFiles(projectPath: string): Promise<HotFile[]> {
  // -z: NUL-separate paths inside each commit; --name-only without
  //   --diff-filter so we count any change (add/modify/rename).
  // --pretty=format:: empty so each commit emits only its file list.
  // Typed chokepoint: timeout/spawn throw into the outer try (Stop stays
  // best-effort); typed exit → empty list (no history), never a hang.
  const res = await runGit(
    ['log', `--since=${WINDOW_DAYS}.days.ago`, '--name-only', '--pretty=format:', '-z'],
    { cwd: projectPath, maxBuffer: 16 * 1024 * 1024, timeoutMs: 15_000 }
  )
  if (!res.ok) {
    if (res.kind === 'exit') return []
    throwProc(res)
  }

  const counts = new Map<string, number>()
  for (const raw of res.stdout.split('\0')) {
    const file = raw.trim()
    if (!file) continue
    if (isIgnored(file)) continue
    counts.set(file, (counts.get(file) ?? 0) + 1)
  }

  const hot: HotFile[] = []
  for (const [file, touches] of counts) {
    if (touches < HOT_THRESHOLD) continue
    hot.push({ path: file, touches })
  }
  hot.sort((a, b) => b.touches - a.touches)
  return hot
}

function isIgnored(file: string): boolean {
  const base = path.basename(file)
  for (const re of IGNORE_PATTERNS) {
    if (re.test(file) || re.test(base)) return true
  }
  return false
}

// Recurring bug detection

interface RecurringBug {
  topic: string
  occurrences: number
}

interface GotchaRow {
  data: string
  timestamp: string
}

/**
 * Walk the last RECURRING_WINDOW_DAYS of `gotcha` memory entries.
 * Group by `topic` tag (or by `area` tag if topic is missing). Any
 * group with RECURRING_THRESHOLD+ entries is a recurring bug pattern.
 *
 * Conservative: skips entries without a `topic` or `area` tag — those
 * are too noisy to group reliably.
 */
function detectRecurringBugs(projectId: string): RecurringBug[] {
  try {
    const { prjctDb } = require('../storage/database') as typeof import('../storage/database')
    const cutoff = new Date(Date.now() - RECURRING_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString()
    const rows = prjctDb.query<GotchaRow>(
      projectId,
      "SELECT data, timestamp FROM events WHERE type = 'memory.remember.gotcha' AND timestamp >= ? ORDER BY id DESC LIMIT 500",
      cutoff
    )
    const counts = new Map<string, number>()
    for (const row of rows) {
      const parsed: unknown = (() => {
        try {
          return JSON.parse(row.data)
        } catch {
          return null
        }
      })()
      if (!parsed || typeof parsed !== 'object') continue
      const tags = (parsed as { tags?: Record<string, unknown> }).tags
      if (!tags) continue
      // Skip auto-captured gotchas — they'd inflate the count without
      // adding signal. We only care about user-asserted gotchas.
      if (tags.source === 'transcript-auto') continue
      const topic = typeof tags.topic === 'string' ? tags.topic : undefined
      const area = typeof tags.area === 'string' ? tags.area : undefined
      const key = topic ?? area
      if (!key) continue
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
    const out: RecurringBug[] = []
    for (const [topic, occurrences] of counts) {
      if (occurrences < RECURRING_THRESHOLD) continue
      out.push({ topic, occurrences })
    }
    out.sort((a, b) => b.occurrences - a.occurrences)
    return out
  } catch {
    return []
  }
}

// Tech-debt growth detection

interface DebtSnapshot {
  totalCount: number
}

/**
 * Count TODO/FIXME/XXX markers across the working tree using `git
 * grep` (so we automatically respect .gitignore + skip binaries). Only
 * counts the markers themselves, not surrounding context — keeps the
 * comparison meaningful turn-over-turn.
 */
async function measureTechDebt(projectPath: string): Promise<DebtSnapshot> {
  const res = await runGit(['grep', '-cE', '\\b(TODO|FIXME|XXX)\\b'], {
    cwd: projectPath,
    maxBuffer: 16 * 1024 * 1024,
  })
  if (!res.ok) {
    // git grep exit 1 = no matches — the one legitimate domain negative.
    if (exitCodeMeans(res, 1)) return { totalCount: 0 }
    throwProc(res)
  }
  const total = res.stdout.split('\n').reduce((sum, line) => {
    // git grep -c emits "<file>:<count>" per file
    const idx = line.lastIndexOf(':')
    if (idx <= 0) return sum
    const count = Number.parseInt(line.slice(idx + 1), 10)
    return Number.isFinite(count) ? sum + count : sum
  }, 0)
  return { totalCount: total }
}

interface DebtMemoryRow {
  data: string
}

/**
 * Read the most recent tech-debt snapshot we persisted. Returns 0 if
 * we've never measured (first run); the comparison gates on previous>0
 * so first-run never flags noise.
 */
function collectPreviousDebtSnapshot(projectId: string): number {
  try {
    const { prjctDb } = require('../storage/database') as typeof import('../storage/database')
    const rows = prjctDb.query<DebtMemoryRow>(
      projectId,
      "SELECT data FROM events WHERE type = 'memory.remember.learning' ORDER BY id DESC LIMIT 50"
    )
    for (const row of rows) {
      const parsed: unknown = (() => {
        try {
          return JSON.parse(row.data)
        } catch {
          return null
        }
      })()
      if (!parsed || typeof parsed !== 'object') continue
      const tags = (parsed as { tags?: Record<string, unknown> }).tags
      if (!tags || tags.source !== TECH_DEBT_SOURCE_TAG) continue
      const total = typeof tags.total === 'string' ? Number.parseInt(tags.total, 10) : 0
      if (Number.isFinite(total)) return total
    }
  } catch {
    /* fall through */
  }
  return 0
}

// Dedup against previously persisted insights (per detector)

interface MemoryRow {
  data: string
}

/**
 * Pull recent auto-persisted hot-file insights and return the set of
 * file paths already marked. Window dedup: we treat any insight in the
 * last WINDOW_DAYS as "still valid" so we don't re-persist on every
 * Stop hook call. The next window will let us re-mark naturally.
 */
function collectAlreadyMarkedHotFiles(projectId: string): Set<string> {
  const out = new Set<string>()
  try {
    const { prjctDb } = require('../storage/database') as typeof import('../storage/database')
    const rows = prjctDb.query<MemoryRow>(
      projectId,
      "SELECT data FROM events WHERE type = 'memory.remember.learning' ORDER BY id DESC LIMIT 200"
    )
    const cutoffMs = Date.now() - WINDOW_DAYS * 24 * 60 * 60 * 1000
    for (const row of rows) {
      const parsed: unknown = (() => {
        try {
          return JSON.parse(row.data)
        } catch {
          return null
        }
      })()
      if (!parsed || typeof parsed !== 'object') continue
      const tags = (parsed as { tags?: Record<string, unknown> }).tags
      if (!tags || tags.source !== HOT_FILE_SOURCE_TAG) continue
      // Tags carry the marker; the row's timestamp is the event's
      // outer field, not in `data`. Conservative: if we have a hit on
      // source+pattern+file, treat as marked regardless of age and let
      // the LIMIT 200 window handle staleness.
      const file = tags.file
      const ts = (parsed as { rememberedAt?: unknown }).rememberedAt
      if (typeof file !== 'string') continue
      if (typeof ts === 'string') {
        const t = Date.parse(ts)
        if (!Number.isNaN(t) && t < cutoffMs) continue
      }
      out.add(file)
    }
  } catch {
    // Best-effort: a missing dedup index just means a duplicate this
    // turn. The user can prune.
  }
  return out
}

/**
 * Same shape as collectAlreadyMarkedHotFiles, but for recurring-bug
 * insights. Keyed by `topic` (the gotcha tag we grouped on).
 */
function collectAlreadyMarkedRecurringBugs(projectId: string): Set<string> {
  const out = new Set<string>()
  try {
    const { prjctDb } = require('../storage/database') as typeof import('../storage/database')
    const rows = prjctDb.query<MemoryRow>(
      projectId,
      "SELECT data FROM events WHERE type = 'memory.remember.learning' ORDER BY id DESC LIMIT 200"
    )
    const cutoffMs = Date.now() - RECURRING_WINDOW_DAYS * 24 * 60 * 60 * 1000
    for (const row of rows) {
      const parsed: unknown = (() => {
        try {
          return JSON.parse(row.data)
        } catch {
          return null
        }
      })()
      if (!parsed || typeof parsed !== 'object') continue
      const tags = (parsed as { tags?: Record<string, unknown> }).tags
      if (!tags || tags.source !== RECURRING_BUG_SOURCE_TAG) continue
      const topic = tags.topic
      const ts = (parsed as { rememberedAt?: unknown }).rememberedAt
      if (typeof topic !== 'string') continue
      if (typeof ts === 'string') {
        const t = Date.parse(ts)
        if (!Number.isNaN(t) && t < cutoffMs) continue
      }
      out.add(topic)
    }
  } catch {
    /* best-effort */
  }
  return out
}

// Test exports

export const _internal = {
  detectHotFiles,
  detectRecurringBugs,
  measureTechDebt,
  isIgnored,
  IGNORE_PATTERNS,
  HOT_THRESHOLD,
  WINDOW_DAYS,
  RECURRING_WINDOW_DAYS,
  RECURRING_THRESHOLD,
  TECH_DEBT_GROWTH_THRESHOLD,
}
