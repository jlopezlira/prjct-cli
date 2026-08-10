/**
 * `prjct lean` — the anti-over-engineering surface (prjct-native ponytail).
 *
 * One registered verb, subcommand-parsed (same shape as `prjct seed`), so
 * the whole capability is a single file and a single routing entry — the
 * leanest wiring the manifest allows, which is the point.
 *
 *   prjct lean                       → show active intensity + a summary
 *   prjct lean off|lite|full|ultra   → set intensity (writes config.lean)
 *   prjct lean review [--md]         → flag over-engineering in the diff
 *   prjct lean audit  [--md]         → repo view over stored LLM analysis
 *   prjct lean debt   [--md]         → ledger of deferred `lean:` simplifications
 *
 * review/audit/debt are strictly read-only / advisory — same Tier-1
 * contract as `review-risk` / `health` / `retro`. They never gate, never
 * touch source, never run git mutations. The heuristic gives an immediate
 * signal; the host model does the deep judgement and persists findings via
 * `prjct remember over-engineering`. The ladder + non-negotiables live in
 * the skill's `workflows.md`, pulled on demand.
 */

import configManager from '../infrastructure/config-manager'
import { projectMemory } from '../memory/project-memory'
import llmAnalysisStorage from '../storage/llm-analysis-storage'
import type { MdOption } from '../types/cli'
import type { CommandResult } from '../types/commands'
import type { LocalConfig } from '../types/config'
import { getErrorMessage } from '../types/fs'
import { execFileAsync } from '../utils/exec'
import { failHard, failWith } from '../utils/md-aware'
import { mdOutput } from '../utils/md-formatter'
import out from '../utils/output'
import { PrjctCommandsBase } from './base'

type LeanMode = 'off' | 'lite' | 'full' | 'ultra'
const LEAN_MODES: readonly LeanMode[] = ['off', 'lite', 'full', 'ultra']

// What `lean:` annotation comments mark: a deliberate simplification plus
// its upgrade path. `debt` harvests them; the detector tracks their growth.
const LEAN_MARKER = 'lean:'

// Cap the unified diff handed to the host model. A review payload past this
// is itself a smell (the change is too big to review in one pass) — the
// truncation note tells the model to split it.
const MAX_DIFF_CHARS = 24_000

// Advisory thresholds for the heuristic pre-scan. Deliberately blunt: a
// wrong nudge costs a glance, not a block. Same philosophy as review-risk.
const MANY_NEW_FILES = 5

/** The lean rubric the host model applies — the decision ladder, condensed.
 *  Kept here (not in the always-in-context skill body) so it costs tokens
 *  only when a review actually runs. */
const LEAN_REVIEW_RUBRIC = [
  'Apply the lean decision ladder to this diff, in order:',
  '1. Does this need to exist at all? (YAGNI — delete beats add)',
  '2. Does the standard library already provide it?',
  '3. Is there a native platform feature for it?',
  '4. Does an already-installed dependency cover it? (never add one for a trivial need)',
  '5. Can it be one line? Only then write minimal code.',
  'Flag: speculative abstractions (interface/factory with one implementation),',
  'premature config, needless new dependencies, clever over boring.',
  'NON-NEGOTIABLE — never flag away: input/trust-boundary validation, data-loss',
  'handling, security, accessibility, edge-case correctness, explicitly-asked scope.',
].join('\n')

interface DiffSmells {
  loc: number
  addedFiles: number
  newDeps: number
  leanMarkers: number
}

export class LeanCommands extends PrjctCommandsBase {
  async lean(
    input: string | null = null,
    projectPath: string = process.cwd(),
    options: MdOption = {}
  ): Promise<CommandResult> {
    const parts = (input ?? '').trim().split(/\s+/).filter(Boolean)
    const sub = (parts[0] ?? '').toLowerCase()

    if (!sub || sub === 'status' || sub === 'show') {
      return this.showStatus(projectPath, options)
    }
    if ((LEAN_MODES as readonly string[]).includes(sub)) {
      return this.setMode(sub as LeanMode, projectPath, options)
    }
    switch (sub) {
      case 'review':
        return this.review(projectPath, options)
      case 'audit':
        return this.audit(projectPath, options)
      case 'debt':
        return this.debt(projectPath, options)
      default:
        return failWith(
          `Unknown lean subcommand "${sub}". Use: review, audit, debt, or ${LEAN_MODES.join('|')}.`,
          options
        )
    }
  }

  /** Show the effective intensity + a one-screen orientation. */
  private async showStatus(projectPath: string, options: MdOption): Promise<CommandResult> {
    const config = await configManager.readConfig(projectPath).catch(() => null)
    if (!config?.projectId)
      return failHard('No prjct project here — run `prjct init` first.', options)

    const mode = effectiveMode(config)
    const summary = [
      `Mode: ${mode}${mode === 'off' ? ' (guidance + lean-debt detector dormant)' : ''}`,
      'Set:    prjct lean off|lite|full|ultra',
      'Review: prjct lean review   — over-engineering in the current diff',
      'Audit:  prjct lean audit    — repo-wide, over stored analysis',
      'Debt:   prjct lean debt     — deferred `lean:` simplifications',
    ]
    if (options.md) {
      console.log(mdOutput('## Lean', `> **Mode**: \`${mode}\``, summary.slice(1).join('\n')))
    } else {
      out.info(`Lean — ${summary.join('\n  ')}`)
    }
    return { success: true, mode }
  }

  /** Persist the intensity to `config.lean.mode`. */
  private async setMode(
    mode: LeanMode,
    projectPath: string,
    options: MdOption
  ): Promise<CommandResult> {
    const config = await configManager.readConfig(projectPath).catch(() => null)
    if (!config?.projectId)
      return failHard('No prjct project here — run `prjct init` first.', options)

    config.lean = { mode }
    await configManager.writeConfig(projectPath, config)

    const msg =
      mode === 'off'
        ? 'Lean mode off — guidance and the lean-debt detector are dormant.'
        : `Lean mode → ${mode}. Guidance biases toward YAGNI/KISS; the Stop-hook lean-debt detector is armed.`
    if (options.md) console.log(mdOutput('## Lean', `> ${msg}`))
    else out.done(msg)
    return { success: true, mode }
  }

  /**
   * Advisory review of the current changeset. Computes the diff vs the
   * default-branch merge-base (falling back to uncommitted work), runs a
   * blunt heuristic pre-scan, and emits an LLM handoff payload for the deep
   * pass. Read-only — nothing is written, nothing is gated.
   */
  private async review(projectPath: string, options: MdOption): Promise<CommandResult> {
    try {
      const config = await configManager.readConfig(projectPath).catch(() => null)
      if (!config?.projectId)
        return failHard('No prjct project here — run `prjct init` first.', options)

      const collected = await collectReviewDiff(projectPath)
      if (!collected || (!collected.diff.trim() && !collected.nameStatus.trim())) {
        const msg =
          'lean review: no changeset to review (nothing ahead of base, no working changes).'
        console.log(options.md ? mdOutput('## Lean review', `> ${msg}`) : msg)
        return { success: true, smells: emptySmells() }
      }

      const smells = scanDiffSmells(collected.diff, collected.nameStatus)
      const flags = leanFlags(smells)
      const clippedDiff =
        collected.diff.length > MAX_DIFF_CHARS
          ? `${collected.diff.slice(0, MAX_DIFF_CHARS)}\n… [diff truncated — too large for one review pass; split it]`
          : collected.diff

      if (options.md) {
        console.log(
          mdOutput(
            '## Lean review',
            `> Base: \`${collected.base ?? 'working tree (no base branch)'}\``,
            `### Heuristic smells\n${formatSmells(smells, flags)}`,
            `### Rubric\n${LEAN_REVIEW_RUBRIC}`,
            `### Diff\n\`\`\`diff\n${clippedDiff}\n\`\`\``,
            '> Persist each finding: `prjct remember over-engineering "<issue + leaner fix>" --tags workflow:lean`'
          )
        )
      } else {
        out.info(`Lean review (base ${collected.base ?? 'working tree'}):`)
        console.log(formatSmells(smells, flags))
        console.log('\nApply the lean ladder, then persist findings via:')
        console.log('  prjct remember over-engineering "<issue + leaner fix>" --tags workflow:lean')
      }
      return { success: true, smells, flags, base: collected.base }
    } catch (error) {
      return failHard(getErrorMessage(error), options)
    }
  }

  /**
   * Repo-wide view. Reuses the stored LLM analysis (`prjct sync` already
   * produces antiPatterns + refactorSuggestions) and frames the
   * simplification-shaped findings as lean candidates. No re-analysis here.
   */
  private async audit(projectPath: string, options: MdOption): Promise<CommandResult> {
    try {
      const config = await configManager.readConfig(projectPath).catch(() => null)
      if (!config?.projectId)
        return failHard('No prjct project here — run `prjct init` first.', options)

      const analysis = llmAnalysisStorage.getActive(config.projectId)
      if (!analysis) {
        const msg = 'lean audit: no stored analysis yet. Run `prjct sync` first, then re-run.'
        console.log(options.md ? mdOutput('## Lean audit', `> ${msg}`) : msg)
        return { success: true, antiPatterns: 0, refactors: 0 }
      }

      const overEng = analysis.antiPatterns.filter((a) =>
        OVER_ENGINEERING_RE.test(`${a.issue} ${a.reasoning} ${a.suggestion}`)
      )
      const refactors = analysis.refactorSuggestions

      if (options.md) {
        const apSection =
          overEng.length > 0
            ? `### Over-engineering anti-patterns (${overEng.length})\n${overEng
                .map(
                  (a) =>
                    `- **${a.issue}** (${a.severity}) — ${a.suggestion} [${a.files.join(', ')}]`
                )
                .join('\n')}`
            : '### Over-engineering anti-patterns\n> none flagged in the stored analysis.'
        const refSection =
          refactors.length > 0
            ? `### Simplification candidates (${refactors.length})\n${refactors
                .map(
                  (r) => `- ${r.description} — ${r.benefit} (${r.effort}) [${r.files.join(', ')}]`
                )
                .join('\n')}`
            : '### Simplification candidates\n> none in the stored analysis.'
        console.log(mdOutput('## Lean audit', apSection, refSection))
      } else {
        out.info(
          `Lean audit — ${overEng.length} over-engineering anti-patterns, ${refactors.length} simplification candidates`
        )
        for (const a of overEng) out.info(`  • ${a.issue} (${a.severity}) — ${a.suggestion}`)
        for (const r of refactors) out.info(`  • ${r.description} — ${r.benefit}`)
      }
      return { success: true, antiPatterns: overEng.length, refactors: refactors.length }
    } catch (error) {
      return failHard(getErrorMessage(error), options)
    }
  }

  /**
   * The deferred-simplification ledger: `lean-debt` / `over-engineering`
   * memories plus every `lean:` annotation marker still in source. The
   * marks are promises to simplify later — this surfaces what's owed.
   */
  private async debt(projectPath: string, options: MdOption): Promise<CommandResult> {
    try {
      const config = await configManager.readConfig(projectPath).catch(() => null)
      if (!config?.projectId)
        return failHard('No prjct project here — run `prjct init` first.', options)

      const memories = projectMemory.recall(config.projectId, {
        types: ['lean-debt', 'over-engineering'],
        limit: 100,
        dedupeByKey: false,
      })
      const markers = await scanLeanMarkers(projectPath)

      if (options.md) {
        const memSection =
          memories.length > 0
            ? `### Logged lean debt (${memories.length})\n${memories
                .map((m) => `- ${m.content.split('\n')[0]}`)
                .join('\n')}`
            : '### Logged lean debt\n> none logged.'
        const markSection =
          markers.length > 0
            ? `### \`lean:\` markers in source (${markers.length})\n${markers
                .map((m) => `- \`${m}\``)
                .join('\n')}`
            : '### `lean:` markers in source\n> none found.'
        console.log(mdOutput('## Lean debt', memSection, markSection))
      } else {
        out.info(
          `Lean debt — ${memories.length} logged, ${markers.length} \`lean:\` markers in source`
        )
        for (const m of memories) out.info(`  • ${m.content.split('\n')[0]}`)
        for (const mk of markers) out.info(`  · ${mk}`)
      }
      return { success: true, logged: memories.length, markers: markers.length }
    } catch (error) {
      return failHard(getErrorMessage(error), options)
    }
  }
}

// Effective mode resolution

/** Config wins; `PRJCT_LEAN_MODE` env is the fallback default (ponytail
 *  parity). Unrecognised values collapse to `off`. */
function effectiveMode(config: LocalConfig | null): LeanMode {
  const fromConfig = config?.lean?.mode
  if (fromConfig && (LEAN_MODES as readonly string[]).includes(fromConfig)) return fromConfig
  const fromEnv = process.env.PRJCT_LEAN_MODE?.toLowerCase()
  if (fromEnv && (LEAN_MODES as readonly string[]).includes(fromEnv)) return fromEnv as LeanMode
  return 'off'
}

// Git helpers — read-only, mirror review-risk's blunt-changeset approach.

async function safeGit(projectPath: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', args, {
      cwd: projectPath,
      maxBuffer: 32 * 1024 * 1024,
    })
    return stdout
  } catch {
    return null
  }
}

async function resolveBase(projectPath: string): Promise<string | null> {
  const originHead = (
    await safeGit(projectPath, ['rev-parse', '--abbrev-ref', 'origin/HEAD'])
  )?.trim()
  const findLocalDefault = async (candidates: string[]): Promise<string> => {
    const [candidate, ...rest] = candidates
    if (!candidate) return ''
    return (await safeGit(projectPath, ['rev-parse', '--verify', '--quiet', candidate])) !== null
      ? candidate
      : findLocalDefault(rest)
  }
  const defaultRef =
    originHead && originHead !== 'origin/HEAD'
      ? originHead
      : await findLocalDefault(['main', 'master'])
  if (!defaultRef) return null
  const base = (await safeGit(projectPath, ['merge-base', defaultRef, 'HEAD']))?.trim()
  return base || null
}

interface CollectedDiff {
  base: string | null
  nameStatus: string
  diff: string
}

/**
 * Everything new since the base branch (committed + working-tree). Falls
 * back to uncommitted changes when there is no comparable base.
 */
async function collectReviewDiff(projectPath: string): Promise<CollectedDiff | null> {
  const base = await resolveBase(projectPath)
  const ref = base ?? 'HEAD'
  const nameStatus = (await safeGit(projectPath, ['diff', '--name-status', ref])) ?? ''
  const diff = (await safeGit(projectPath, ['diff', ref])) ?? ''
  return { base: base ? base.slice(0, 7) : null, nameStatus, diff }
}

/** Scan the working tree for `lean:` markers via git grep (respects
 *  .gitignore, skips binaries). Returns `file:line` strings. */
async function scanLeanMarkers(projectPath: string): Promise<string[]> {
  const out = await safeGit(projectPath, ['grep', '-nI', '-e', LEAN_MARKER])
  if (!out) return []
  return out
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      // git grep emits `<file>:<line>:<text>` — keep file:line, drop body.
      const m = l.match(/^([^:]+):(\d+):/)
      return m ? `${m[1]}:${m[2]}` : l
    })
    .slice(0, 100)
}

// Heuristic pre-scan — pure, deterministic, unit-tested via _internal.

const NEW_DEP_RE = /^\+\s*"[\w@/.-]+"\s*:\s*"[\^~>=<\dvx*]/
const OVER_ENGINEERING_RE =
  /over-?engineer|speculative|abstraction|premature|yagni|boilerplate|needless/i

function emptySmells(): DiffSmells {
  return { loc: 0, addedFiles: 0, newDeps: 0, leanMarkers: 0 }
}

/**
 * Count blunt over-engineering smells in a unified diff + name-status:
 *  - loc: added/removed lines
 *  - addedFiles: files with status A
 *  - newDeps: dependency-shaped additions inside a package.json hunk
 *  - leanMarkers: `lean:` annotations introduced by this change
 */
function scanDiffSmells(diff: string, nameStatus: string): DiffSmells {
  const smells = emptySmells()

  for (const line of nameStatus.split('\n')) {
    if (/^A\s/.test(line)) smells.addedFiles += 1
  }

  const diffState = { inPackageJson: false }
  for (const line2 of diff.split('\n')) {
    if (line2.startsWith('+++ ')) {
      diffState.inPackageJson = /\/package\.json$|^\+\+\+ b\/package\.json$/.test(line2)
      continue
    }
    if (line2.startsWith('+++') || line2.startsWith('---')) continue
    if (line2.startsWith('+') || line2.startsWith('-')) smells.loc += 1
    if (line2.startsWith('+')) {
      if (diffState.inPackageJson && NEW_DEP_RE.test(line2)) smells.newDeps += 1
      if (new RegExp(`\\b${LEAN_MARKER}`, 'i').test(line2)) smells.leanMarkers += 1
    }
  }
  return smells
}

/** Turn smells into advisory one-liners. Empty array = nothing notable. */
function leanFlags(s: DiffSmells): string[] {
  const flags: string[] = []
  if (s.newDeps > 0)
    flags.push(`${s.newDeps} new dependency(ies) — verify none replaces a stdlib/native/one-liner.`)
  if (s.addedFiles >= MANY_NEW_FILES)
    flags.push(
      `${s.addedFiles} new files — check for speculative abstraction / premature structure.`
    )
  if (s.leanMarkers > 0)
    flags.push(
      `${s.leanMarkers} new \`lean:\` marker(s) — deferred simplifications; track via \`prjct lean debt\`.`
    )
  return flags
}

function formatSmells(s: DiffSmells, flags: string[]): string {
  const lines = [
    `- LOC changed: ${s.loc}`,
    `- New files: ${s.addedFiles}`,
    `- New deps: ${s.newDeps}`,
    `- New \`lean:\` markers: ${s.leanMarkers}`,
  ]
  if (flags.length > 0) {
    lines.push('', 'Flags:')
    for (const f of flags) lines.push(`  - ${f}`)
  } else {
    lines.push(
      '',
      '_No blunt smells — the heuristic is clean; the rubric pass may still find subtler over-engineering._'
    )
  }
  return lines.join('\n')
}

/** Exported for unit tests — pure deterministic core. */
export const _internal = {
  effectiveMode,
  scanDiffSmells,
  leanFlags,
  LEAN_MODES,
  MANY_NEW_FILES,
  OVER_ENGINEERING_RE,
}
