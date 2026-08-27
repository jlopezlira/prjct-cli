/**
 * `prjct guard <file>` — ANTICIPATION primitive, provider-agnostic.
 *
 * Surfaces the *preventive* memory recorded against a file — gotchas,
 * anti-patterns, recurring-bugs — so the trap is seen before it's stepped in.
 * This is pillar 3 (anticipation) of the RAG north star: "anticipar, prevenir
 * bugs, conocerse para que el dev y el LLM sean uno mismo".
 *
 * Pull, not push: this is the CLI face of the same intelligence behind the
 * `prjct_guard` MCP tool. The agent (Claude or Codex) asks for a file's traps
 * on demand instead of us injecting them into every turn's context. Keeping
 * anticipation pull-based is what stops it from bloating the context window.
 *
 * Quiet by design: prints "clear to edit" (exit 0) when nothing genuinely
 * preventive matches, so it never becomes noise.
 */

import type { MemoryEntry } from '../memory/entries'
import { deriveTitle, flatDetail, preventiveLabel } from '../memory/format'
import { projectMemory } from '../memory/project-memory'
import { resolveCallerIdentity } from '../services/agent-identity'
import {
  buildSourceInspectionBrief,
  markSourceInspected,
  markSourceInspectionToken,
} from '../services/source-first-gate'
import { recordSurfacedForActiveTask } from '../services/usefulness/surface-attribution'
import type { MdOption } from '../types/cli'
import type { CommandResult } from '../types/commands'
import out from '../utils/output'
import { PrjctCommandsBase } from './base'
import { requireProject } from './guards'

interface GuardOptions extends MdOption {
  limit?: number
  /** Diff range for CI/PR mode (e.g. `main...HEAD`); overrides the file arg. */
  diff?: string
  /** With --diff: exit non-zero when any trap matches (gate mode for CI). */
  strict?: boolean
}

export class GuardCommands extends PrjctCommandsBase {
  async guard(
    input: string | null = null,
    projectPath: string = process.cwd(),
    options: GuardOptions = {}
  ): Promise<CommandResult> {
    // PR/CI mode: `prjct guard --diff main...HEAD` sweeps EVERY file the
    // range touches through the preventive recall — team-level anticipation
    // with zero LLM cost (pure indexed lookup). `--strict` turns it into a
    // gate (non-zero exit when traps match) for CI.
    if (options.diff) return this.guardDiff(options.diff, projectPath, options)

    const file = (input ?? '').trim().split(/\s+/).filter(Boolean)[0]
    if (!file) {
      const msg =
        'Usage: prjct guard <file> — surfaces preventive memory before you edit it. PR mode: prjct guard --diff <range> [--strict].'
      if (options.md) console.log(`> ${msg}`)
      else out.fail(msg)
      return { success: false, error: 'Missing file argument' }
    }

    const guard = await requireProject(projectPath, options)
    if (!guard.ok) return guard.result

    const limit = typeof options.limit === 'number' && options.limit > 0 ? options.limit : 3
    const hits: MemoryEntry[] = (() => {
      try {
        return projectMemory.recallForFile(guard.value, file, limit)
      } catch {
        return []
      }
    })()

    // Push-path ship attribution (see surface-attribution.ts): a guard
    // that surfaced a trap during a task that ships earned its keep.
    void recordSurfacedForActiveTask(
      guard.value,
      projectPath,
      hits.map((e) => e.id)
    )

    const base = file.split('/').pop() ?? file

    // World-model impact: related files via import/co-change (best-effort).
    const { impactBlock, impactLine } = await import('../services/world-model-impact')
      .then(({ breakImpact, formatImpactMd }) => {
        const impact = breakImpact(guard.value, [file], 6)
        return { impactBlock: formatImpactMd(impact), impactLine: impact.line }
      })
      .catch(() => ({ impactBlock: '', impactLine: '' }))
    const sourceBrief = await buildSourceInspectionBrief(guard.value, projectPath, file)

    // `guard` is the provider-agnostic inspection handshake for agents whose
    // host exposes shell reads instead of a first-class Read tool (notably
    // Codex). Await the durable stamp before printing success so an immediate
    // Edit retry cannot race it.
    await markSourceInspected({
      projectId: guard.value,
      projectPath,
      sessionId: resolveCallerIdentity('guard').sessionId,
      filePath: file,
    })
    const sourceToken = process.env.PRJCT_SOURCE_INSPECTION?.trim()
    if (sourceToken) {
      await markSourceInspectionToken({
        projectId: guard.value,
        projectPath,
        token: sourceToken,
        filePath: file,
      })
    }

    if (hits.length === 0) {
      const msg = `No preventive memory recorded against \`${base}\` — clear to edit.`
      if (options.md) {
        console.log([`> ${msg}`, impactBlock, sourceBrief].filter(Boolean).join('\n\n'))
      } else {
        out.done(`No preventive memory for ${base} — clear to edit.`)
        if (impactLine) out.info(impactLine)
      }
      return { success: true, file, hits: 0, impact: impactLine || undefined }
    }

    if (options.md) {
      const lines = [
        `# prjct: heads up before editing \`${base}\``,
        '',
        'Preventive memory recorded against this file — check before you change it:',
        '',
      ]
      for (const e of hits) {
        lines.push(
          `- **[${preventiveLabel(e)}] ${deriveTitle(e)}** — ${flatDetail(e.content)}  \`${e.id}\``
        )
      }
      lines.push('', '> Surfaced as prevention. Apply if relevant; ignore if not.')
      if (impactBlock) lines.push('', impactBlock)
      if (sourceBrief) lines.push('', sourceBrief)
      console.log(lines.join('\n'))
    } else {
      out.info(
        `⚠ ${hits.length} preventive memory entr${hits.length === 1 ? 'y' : 'ies'} for ${base}:`
      )
      for (const e2 of hits) {
        out.info(
          `  • [${preventiveLabel(e2)}] ${deriveTitle(e2)} — ${flatDetail(e2.content, 120)} (${e2.id})`
        )
      }
      if (impactLine) out.info(impactLine)
    }

    return { success: true, file, hits: hits.length, impact: impactLine || undefined }
  }

  /**
   * PR/CI sweep: run preventive recall over every file a diff range touches.
   * Pure indexed recall (no LLM) — cheap enough for a pre-merge gate. Exit
   * semantics: success unless `--strict` AND traps matched.
   */
  private async guardDiff(
    range: string,
    projectPath: string,
    options: GuardOptions
  ): Promise<CommandResult> {
    const guard = await requireProject(projectPath, options)
    if (!guard.ok) return guard.result

    const diffResult = await (async () => {
      try {
        const { execFileAsync } = await import('../utils/exec')
        const r = await execFileAsync('git', ['diff', '--name-only', range], {
          cwd: projectPath,
          timeout: 10000,
        })
        return { ok: true as const, files: r.stdout.split('\n').filter(Boolean) }
      } catch (error) {
        return { ok: false as const, error }
      }
    })()
    if (!diffResult.ok) {
      const msg = `Could not diff \`${range}\`: ${diffResult.error instanceof Error ? diffResult.error.message.split('\n')[0] : 'git error'}`
      if (options.md) console.log(`> ${msg}`)
      else out.fail(msg)
      return { success: false, error: 'git diff failed' }
    }
    const { files } = diffResult
    if (files.length === 0) {
      const msg = `No files changed in \`${range}\` — nothing to guard.`
      if (options.md) console.log(`> ${msg}`)
      else out.done(msg)
      return { success: true, files: 0, hits: 0 }
    }

    const perFileLimit = typeof options.limit === 'number' && options.limit > 0 ? options.limit : 2
    const findings: Array<{ file: string; entry: MemoryEntry }> = []
    const surfacedIds: string[] = []
    for (const file of files) {
      const hits: MemoryEntry[] = (() => {
        try {
          return projectMemory.recallForFile(guard.value, file, perFileLimit, {
            preventiveOnly: true,
          })
        } catch {
          return []
        }
      })()
      for (const entry of hits) {
        findings.push({ file, entry })
        surfacedIds.push(entry.id)
      }
    }
    void recordSurfacedForActiveTask(guard.value, projectPath, surfacedIds)

    if (findings.length === 0) {
      const msg = `Swept ${files.length} changed file(s) in \`${range}\` — no known traps. Clear.`
      if (options.md) console.log(`> ✅ ${msg}`)
      else out.done(msg)
      return { success: true, files: files.length, hits: 0 }
    }

    if (options.md) {
      const lines = [
        `# prjct guard — ${findings.length} known trap(s) in \`${range}\``,
        '',
        `Preventive memory matched ${new Set(findings.map((f) => f.file)).size} of ${files.length} changed file(s):`,
        '',
      ]
      for (const f2 of findings) {
        lines.push(
          `- \`${f2.file}\` — [${preventiveLabel(f2.entry)}] ${deriveTitle(f2.entry)} — ${flatDetail(f2.entry.content, 140)} (\`${f2.entry.id}\`)`
        )
      }
      lines.push('', 'Resolve any id with `prjct search <id>`.')
      console.log(lines.join('\n'))
    } else {
      out.info(`⚠ ${findings.length} known trap(s) across ${files.length} changed file(s):`)
      for (const f3 of findings) {
        out.info(`  • ${f3.file} — ${deriveTitle(f3.entry)} (${f3.entry.id})`)
      }
    }

    // Gate semantics only under --strict: advisory by default.
    return {
      success: !options.strict,
      ...(options.strict ? { error: `${findings.length} known trap(s) matched the diff` } : {}),
      files: files.length,
      hits: findings.length,
    }
  }
}
