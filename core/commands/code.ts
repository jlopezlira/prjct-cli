/**
 * `prjct code` — structural code intelligence surface (symbol graph).
 *
 * One registered verb, subcommand-parsed (same shape as lean/tdd):
 *   prjct code                     → index stats + optional CBM status
 *   prjct code symbols [pattern]   → search symbols
 *   prjct code trace <name>        → inbound/outbound call path
 *   prjct code impact              → detect_changes (git diff blast + risk)
 *   prjct code architecture        → structural overview (one-shot)
 *   prjct code export              → cache under ~/.prjct-cli/projects/<id>/
 *   prjct code import              → restore SQLite from that per-project cache
 *   prjct code push-graph          → upload full structural graph to cloud 3D
 *   prjct code reindex             → rebuild symbol graph now
 *   prjct code dead                → zero-caller symbols (excl. entries)
 *   prjct code cbm [cli <tool> …]  → optional CBM bridge status / execute
 */

import {
  hasSymbolIndex,
  indexSymbols,
  listAllSymbols,
  loadMeta,
  searchSymbols,
  tracePath,
} from '../domain/symbol-graph'
import configManager from '../infrastructure/config-manager'
import {
  buildArchitectureSnapshot,
  formatArchitectureMd,
  formatArchitectureText,
} from '../services/architecture-snapshot'
import { cbmCli, cbmFallback, detectCbm, formatCbmStatus } from '../services/cbm-bridge'
import {
  exportCodeGraphArtifact,
  importCodeGraphArtifact,
  maybeExportAfterIndex,
  maybeUploadCodeGraphToCloud,
  shouldAutoUploadCodeGraph,
} from '../services/code-graph-artifact'
import { findDeadCode, formatDeadCodeMd, formatDeadCodeText } from '../services/dead-code'
import {
  detectChanges,
  formatDetectChangesMd,
  formatDetectChangesText,
} from '../services/detect-changes'
import type { MdOption } from '../types/cli'
import type { CommandResult } from '../types/commands'
import { getErrorMessage } from '../types/fs'
import { failHard, failWith } from '../utils/md-aware'
import { mdOutput } from '../utils/md-formatter'
import out from '../utils/output'
import { PrjctCommandsBase } from './base'
import { requireProject } from './guards'

export class CodeCommands extends PrjctCommandsBase {
  async code(
    input: string | null = null,
    projectPath: string = process.cwd(),
    options: MdOption = {}
  ): Promise<CommandResult> {
    try {
      const parts = (input ?? '').trim().split(/\s+/).filter(Boolean)
      const sub = (parts[0] ?? '').toLowerCase()
      const rest = parts.slice(1).join(' ')

      if (!sub || sub === 'status' || sub === 'stats') {
        return this.showStats(projectPath, options)
      }
      if (sub === 'symbols' || sub === 'search') {
        return this.symbols(rest, projectPath, options)
      }
      if (sub === 'trace') {
        return this.trace(rest, projectPath, options)
      }
      if (sub === 'impact' || sub === 'detect' || sub === 'changes') {
        return this.impact(projectPath, options)
      }
      if (sub === 'architecture' || sub === 'arch') {
        return this.architecture(projectPath, options)
      }
      if (sub === 'export') {
        return this.exportArtifact(projectPath, options)
      }
      if (sub === 'import' || sub === 'bootstrap') {
        return this.importArtifact(projectPath, options)
      }
      if (sub === 'push-graph' || sub === 'push' || sub === 'upload-graph') {
        return this.pushGraph(projectPath, options)
      }
      if (sub === 'reindex' || sub === 'index') {
        return this.reindex(projectPath, options)
      }
      if (sub === 'dead') {
        return this.dead(projectPath, options)
      }
      if (sub === 'cbm') {
        return this.cbmCmd(rest, options)
      }
      return failWith(
        `Unknown code subcommand "${sub}". Use: symbols | trace | impact | architecture | dead | export | import | push-graph | reindex | cbm`,
        options
      )
    } catch (error) {
      return failHard(getErrorMessage(error), options)
    }
  }

  private async showStats(projectPath: string, options: MdOption): Promise<CommandResult> {
    const proj = await requireProject(projectPath, options)
    if (!proj.ok) return proj.result
    const meta = loadMeta(proj.value)
    const ready = hasSymbolIndex(proj.value)
    const cbm = await detectCbm().catch(() => null)
    const cbmLine = cbm ? formatCbmStatus(cbm) : null
    if (options.md) {
      console.log(
        mdOutput(
          '## Code symbol graph',
          ready
            ? [
                `- **Symbols**: ${meta?.symbolCount ?? '?'}`,
                `- **Edges**: ${meta?.edgeCount ?? '?'}`,
                `- **Files**: ${meta?.fileCount ?? '?'}`,
                `- **Built**: ${meta?.builtAt ?? 'unknown'}`,
                cbmLine ? `- **${cbmLine}**` : '',
                '',
                'Commands: `symbols` · `trace` · `impact` · `architecture` · `dead` · `export` · `import` · `reindex` · `cbm`',
              ]
                .filter(Boolean)
                .join('\n')
            : [
                '> No symbol index yet. Run `prjct sync` or `prjct code reindex`.',
                cbmLine ? `> ${cbmLine}` : '',
              ]
                .filter(Boolean)
                .join('\n')
        )
      )
    } else {
      if (!ready) {
        out.info('Code graph: empty — run `prjct sync` or `prjct code reindex`')
      } else {
        out.info(
          `Code graph: ${meta?.symbolCount ?? 0} symbols · ${meta?.edgeCount ?? 0} edges · ${meta?.fileCount ?? 0} files (built ${meta?.builtAt ?? '?'})`
        )
        out.info(
          '  symbols | trace | impact | architecture | dead | export | import | reindex | cbm'
        )
      }
      if (cbmLine) out.info(`  ${cbmLine}`)
    }
    return { success: true, ready, meta, cbm }
  }

  private async symbols(
    pattern: string,
    projectPath: string,
    options: MdOption
  ): Promise<CommandResult> {
    const proj = await requireProject(projectPath, options)
    if (!proj.ok) return proj.result
    if (!hasSymbolIndex(proj.value)) {
      return failWith('No symbol index — run `prjct sync` or `prjct code reindex` first.', options)
    }
    const q = pattern.trim()
    const effective = q
      ? searchSymbols(proj.value, q, { limit: 40 })
      : listAllSymbols(proj.value)
          .filter((s) => s.exported)
          .slice(0, 40)

    if (effective.length === 0 && q) {
      const fb = await cbmFallback('search', projectPath, { pattern: q })
      if (fb) {
        console.log(fb.text)
        return { success: true, count: 0, source: 'cbm', symbols: [] }
      }
    }

    if (options.md) {
      const lines = [
        `## Symbols${q ? `: \`${q}\`` : ' (exported sample)'}`,
        '',
        `| Kind | Name | File | Line |`,
        `|---|---|---|---:|`,
      ]
      for (const s of effective) {
        lines.push(`| ${s.kind} | \`${s.name}\` | \`${s.file}\` | ${s.startLine} |`)
      }
      if (effective.length === 0) lines.push('| — | _no matches_ | | |')
      console.log(lines.join('\n'))
    } else {
      if (effective.length === 0) out.info('No symbols matched.')
      else {
        out.info(`${effective.length} symbol(s)${q ? ` matching "${q}"` : ''}:`)
        for (const s of effective) {
          out.info(`  ${s.kind.padEnd(9)} ${s.name}  ${s.file}:${s.startLine}`)
        }
      }
    }
    return { success: true, count: effective.length, symbols: effective }
  }

  private async trace(
    name: string,
    projectPath: string,
    options: MdOption
  ): Promise<CommandResult> {
    const proj = await requireProject(projectPath, options)
    if (!proj.ok) return proj.result
    const fn = name.trim()
    if (!fn) {
      return failWith('Usage: prjct code trace <functionOrClassName>', options)
    }
    const hasNative = hasSymbolIndex(proj.value)
    const result = hasNative ? tracePath(proj.value, fn, { direction: 'both', depth: 3 }) : null
    const weak =
      !result ||
      (result.inbound.length === 0 && result.outbound.length === 0 && result.root.length === 0)

    if (weak) {
      const fb = await cbmFallback('trace', projectPath, { name: fn })
      if (fb) {
        console.log(fb.text)
        return { success: true, source: 'cbm', inbound: 0, outbound: 0 }
      }
    }

    if (!result) {
      return failWith(
        hasNative
          ? `No symbol named "${fn}". Try \`prjct code symbols ${fn}\`${(await detectCbm()).available ? ' or index the repo in CBM for polyglot depth' : ''}.`
          : 'No symbol index — run `prjct sync` or `prjct code reindex` first.',
        options
      )
    }
    if (options.md) {
      const lines = [
        `## Trace: \`${fn}\``,
        '',
        '### Roots',
        ...result.root.map((r) => `- \`${r.kind}\` **${r.name}** — \`${r.file}:${r.startLine}\``),
        '',
        `### Inbound callers (${result.inbound.length})`,
        ...(result.inbound.length === 0
          ? ['_none_']
          : result.inbound.map(
              (h) =>
                `- d${h.depth} \`${h.symbol.name}\` (${h.symbol.kind}) — \`${h.symbol.file}:${h.symbol.startLine}\``
            )),
        '',
        `### Outbound callees (${result.outbound.length})`,
        ...(result.outbound.length === 0
          ? ['_none_']
          : result.outbound.map(
              (h) =>
                `- d${h.depth} \`${h.symbol.name}\` (${h.symbol.kind}) — \`${h.symbol.file}:${h.symbol.startLine}\``
            )),
      ]
      console.log(lines.join('\n'))
    } else {
      out.info(`Trace ${fn}:`)
      for (const r of result.root) {
        out.info(`  root: ${r.kind} ${r.name} @ ${r.file}:${r.startLine}`)
      }
      out.info(`  inbound (${result.inbound.length}):`)
      for (const h of result.inbound.slice(0, 20)) {
        out.info(`    d${h.depth} ${h.symbol.name} ← ${h.symbol.file}`)
      }
      out.info(`  outbound (${result.outbound.length}):`)
      for (const h of result.outbound.slice(0, 20)) {
        out.info(`    d${h.depth} ${h.symbol.name} → ${h.symbol.file}`)
      }
    }
    return {
      success: true,
      source: 'native',
      root: result.root,
      inbound: result.inbound.length,
      outbound: result.outbound.length,
    }
  }

  private async impact(projectPath: string, options: MdOption): Promise<CommandResult> {
    const proj = await requireProject(projectPath, options)
    if (!proj.ok) return proj.result
    const result = await detectChanges(projectPath, proj.value, { source: 'auto' })
    console.log(options.md ? formatDetectChangesMd(result) : formatDetectChangesText(result))
    return { success: true, ...result }
  }

  private async architecture(projectPath: string, options: MdOption): Promise<CommandResult> {
    const proj = await requireProject(projectPath, options)
    if (!proj.ok) return proj.result
    const snap = buildArchitectureSnapshot(proj.value)
    if (!snap.ready || snap.symbols === 0) {
      const fb = await cbmFallback('architecture', projectPath)
      if (fb) {
        console.log(fb.text)
        return { success: true, source: 'cbm', ready: false }
      }
    }
    console.log(options.md ? formatArchitectureMd(snap) : formatArchitectureText(snap))
    return { success: true, source: 'native', ...snap }
  }

  private async exportArtifact(projectPath: string, options: MdOption): Promise<CommandResult> {
    const proj = await requireProject(projectPath, options)
    if (!proj.ok) return proj.result
    if (!hasSymbolIndex(proj.value)) {
      return failWith('No symbol index — run `prjct code reindex` first.', options)
    }
    const exp = await exportCodeGraphArtifact(proj.value)
    if (!exp) return failWith('Export failed.', options)
    const msg = `Cached ${exp.symbols} symbols · ${exp.edges} edges → ${exp.path} (${exp.bytes} bytes gzip) [per-project, not in client repo]`
    if (options.md) console.log(mdOutput('## Code graph cache', `> ${msg}`))
    else out.success(msg)
    return { success: true, ...exp }
  }

  private async importArtifact(projectPath: string, options: MdOption): Promise<CommandResult> {
    const proj = await requireProject(projectPath, options)
    if (!proj.ok) return proj.result
    const imp = await importCodeGraphArtifact(proj.value)
    if (!imp.imported) {
      return failWith(imp.reason ?? 'Import failed', options)
    }
    const msg = `Restored ${imp.symbols} symbols · ${imp.edges} edges from per-project cache`
    if (options.md) console.log(mdOutput('## Code graph restore', `> ${msg}`))
    else out.success(msg)
    return { success: true, ...imp }
  }

  private async pushGraph(projectPath: string, options: MdOption): Promise<CommandResult> {
    const proj = await requireProject(projectPath, options)
    if (!proj.ok) return proj.result
    if (!hasSymbolIndex(proj.value)) {
      return failWith('No symbol index — run `prjct code reindex` first.', options)
    }
    const res = await maybeUploadCodeGraphToCloud(proj.value)
    if (!res.uploaded) {
      return failWith(
        res.reason ?? 'Cloud upload failed (login with `prjct login` if offline).',
        options
      )
    }
    const msg = `Uploaded full structural graph · ${res.nodes ?? 0} nodes · ${res.links ?? 0} links (Function/Class/File + CALLS/IMPORTS — uncapped)`
    if (options.md) console.log(mdOutput('## Code graph cloud', `> ${msg}`))
    else out.success(msg)
    return { success: true, ...res }
  }

  private async reindex(projectPath: string, options: MdOption): Promise<CommandResult> {
    const proj = await requireProject(projectPath, options)
    if (!proj.ok) return proj.result
    const meta = await indexSymbols(projectPath, proj.value)
    const config = await configManager.readConfig(projectPath).catch(() => null)
    await maybeExportAfterIndex(proj.value, {
      uploadToCloud: shouldAutoUploadCodeGraph(config),
    })
    const msg = `Indexed ${meta.symbolCount} symbols · ${meta.edgeCount} edges · ${meta.fileCount} files`
    if (options.md) console.log(mdOutput('## Code reindex', `> ${msg}`))
    else out.success(msg)
    return { success: true, meta }
  }

  private async dead(projectPath: string, options: MdOption): Promise<CommandResult> {
    const proj = await requireProject(projectPath, options)
    if (!proj.ok) return proj.result
    const result = findDeadCode(proj.value, { limit: 50 })
    console.log(options.md ? formatDeadCodeMd(result) : formatDeadCodeText(result))
    return { success: true, count: result.dead.length, ...result }
  }

  private async cbmCmd(rest: string, options: MdOption): Promise<CommandResult> {
    const parts = rest.trim().split(/\s+/).filter(Boolean)
    if (parts[0] === 'cli' && parts[1]) {
      const tool = parts[1]!
      let args: Record<string, unknown> = {}
      const jsonArg = parts.slice(2).join(' ')
      if (jsonArg) {
        try {
          args = JSON.parse(jsonArg) as Record<string, unknown>
        } catch {
          return failWith('cbm cli args must be JSON object', options)
        }
      }
      const r = await cbmCli(tool, args)
      if (!r.ok) {
        return failWith(r.error ?? r.stderr ?? 'CBM cli failed', options)
      }
      console.log(r.stdout || r.stderr)
      return { success: true, stdout: r.stdout }
    }
    const s = await detectCbm()
    const line = formatCbmStatus(s)
    if (options.md) {
      console.log(
        mdOutput(
          '## CBM bridge',
          `> ${line}`,
          s.available
            ? 'Execute: `prjct code cbm cli <tool> \'{"key":"val"}\'` (see CBM docs for tools).'
            : ''
        )
      )
    } else {
      out.info(line)
      if (s.available) {
        out.info("  Execute: prjct code cbm cli <tool> '{\"…}'")
      }
    }
    return { success: true, ...s }
  }
}
