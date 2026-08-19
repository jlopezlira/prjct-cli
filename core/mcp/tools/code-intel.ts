/**
 * MCP Code Intelligence Tools
 *
 * Exposes import graph, co-change analysis, change propagation,
 * symbol search/trace, detect_changes, and combined related-context.
 */
import type { McpServer } from '@modelcontextprotocol/server'
import { z } from 'zod'
import { affectedDomains, propagateChanges } from '../../domain/change-propagator'
import {
  scoreFromSeeds as cochangeScore,
  indexCoChanges,
  loadMatrix,
} from '../../domain/git-cochange'
import { scoreFromSeeds as importScore, indexImports, loadGraph } from '../../domain/import-graph'
import { hasSymbolIndex, loadMeta, searchSymbols, tracePath } from '../../domain/symbol-graph'
import {
  buildArchitectureSnapshot,
  formatArchitectureMd,
} from '../../services/architecture-snapshot'
import { findDeadCode, formatDeadCodeMd } from '../../services/dead-code'
import { detectChanges, formatDetectChangesMd } from '../../services/detect-changes'
import { boundedLimit, optionalProjectPath, resolveProjectId, resolveProjectPath } from '../resolve'
import { safeMcpCall } from './error-handler'
import { gatedTextResult } from './gated-result'

// MCP SDK TS2589 workaround: cast server to avoid deep type instantiation
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type S = any

export function registerCodeIntelTools(server: McpServer) {
  const s: S = server

  s.registerTool(
    'prjct_impact_analysis',
    {
      description:
        'Blast radius + risk for changed files (or git working tree / committed range). Prefer over manual Grep for review scope.',
      inputSchema: z.object({
        projectPath: optionalProjectPath,
        changedFiles: z
          .array(z.string())
          .optional()
          .describe(
            'Changed file paths relative to project root. Omit to auto-detect from git working tree / committed range.'
          ),
      }),
    },
    safeMcpCall(
      'prjct_impact_analysis',
      async (args: { projectPath: string; changedFiles?: string[] }) => {
        const projectId = await resolveProjectId(args.projectPath)
        const projectPath = resolveProjectPath(args.projectPath)

        // Prefer full detect_changes (risk + call-graph) when no explicit list,
        // or when symbol index is available for richer analysis.
        if (!args.changedFiles?.length || hasSymbolIndex(projectId)) {
          const detected = await detectChanges(projectPath, projectId, {
            files: args.changedFiles,
            source: 'auto',
          })
          if (detected.changedFiles.length > 0 || !args.changedFiles?.length) {
            return {
              content: [{ type: 'text', text: formatDetectChangesMd(detected) }],
            }
          }
        }

        const changed = args.changedFiles ?? []
        const diff = {
          added: [] as string[],
          modified: changed,
          deleted: [] as string[],
          unchanged: [] as string[],
        }

        const propagated = propagateChanges(diff, projectId)
        const domains = affectedDomains(propagated.allAffected)

        const parts: string[] = ['## Impact Analysis']

        parts.push(`\n### Directly Changed (${propagated.directlyChanged.length})`)
        for (const f of propagated.directlyChanged) {
          parts.push(`- ${f}`)
        }

        if (propagated.affectedByImports.length > 0) {
          parts.push(`\n### Affected via Imports (${propagated.affectedByImports.length})`)
          for (const f2 of propagated.affectedByImports) {
            parts.push(`- ${f2}`)
          }
        }

        parts.push(`\n### Affected Domains`)
        parts.push(domains.size > 0 ? Array.from(domains).join(', ') : 'none detected')

        parts.push(`\nTotal affected: ${propagated.allAffected.length} files`)
        parts.push(
          '\n_Tip: run `prjct code reindex` for symbol-level risk + call-graph blast radius._'
        )

        return { content: [{ type: 'text', text: parts.join('\n') }] }
      }
    )
  )

  s.registerTool(
    'prjct_search_symbols',
    {
      description:
        'Search the structural symbol graph (functions, classes, routes). Run prjct sync first.',
      inputSchema: z.object({
        projectPath: optionalProjectPath,
        pattern: z.string().describe('Symbol name substring (case-insensitive)'),
        limit: boundedLimit(30, 100).describe('Max results'),
      }),
    },
    safeMcpCall(
      'prjct_search_symbols',
      async (args: { projectPath: string; pattern: string; limit: number }) => {
        const projectId = await resolveProjectId(args.projectPath)
        if (!hasSymbolIndex(projectId)) {
          return {
            content: [
              {
                type: 'text',
                text: 'No symbol index. Run `prjct sync` or `prjct code reindex`.',
              },
            ],
          }
        }
        const hits = searchSymbols(projectId, args.pattern, { limit: args.limit })
        if (hits.length === 0) {
          return { content: [{ type: 'text', text: `No symbols matching "${args.pattern}".` }] }
        }
        const lines = [
          `## Symbols: ${args.pattern}`,
          `Index: ${loadMeta(projectId)?.symbolCount ?? '?'} symbols`,
          '',
          ...hits.map(
            (s) =>
              `- **${s.name}** (${s.kind}${s.exported ? ', exported' : ''}) — \`${s.file}:${s.startLine}\``
          ),
        ]
        return { content: [{ type: 'text', text: lines.join('\n') }] }
      }
    )
  )

  s.registerTool(
    'prjct_trace_path',
    {
      description:
        'BFS call-path trace: who calls a function and what it calls. Prefer over Grep for "who uses X?".',
      inputSchema: z.object({
        projectPath: optionalProjectPath,
        functionName: z.string().describe('Function/class/method name to trace'),
        direction: z
          .enum(['inbound', 'outbound', 'both'])
          .optional()
          .default('both')
          .describe('inbound = callers, outbound = callees'),
        depth: boundedLimit(3, 5).describe('BFS depth 1-5'),
      }),
    },
    safeMcpCall(
      'prjct_trace_path',
      async (args: {
        projectPath: string
        functionName: string
        direction: 'inbound' | 'outbound' | 'both'
        depth: number
      }) => {
        const projectId = await resolveProjectId(args.projectPath)
        if (!hasSymbolIndex(projectId)) {
          return {
            content: [
              {
                type: 'text',
                text: 'No symbol index. Run `prjct sync` or `prjct code reindex`.',
              },
            ],
          }
        }
        const result = tracePath(projectId, args.functionName, {
          direction: args.direction,
          depth: args.depth,
        })
        if (!result) {
          return {
            content: [
              {
                type: 'text',
                text: `No symbol "${args.functionName}". Try prjct_search_symbols first.`,
              },
            ],
          }
        }
        const lines = [
          `## Trace: ${args.functionName}`,
          '',
          '### Roots',
          ...result.root.map((r) => `- ${r.kind} **${r.name}** \`${r.file}:${r.startLine}\``),
          '',
          `### Inbound (${result.inbound.length})`,
          ...(result.inbound.length
            ? result.inbound.map(
                (h) =>
                  `- d${h.depth} ${h.symbol.name} (${h.symbol.kind}) \`${h.symbol.file}:${h.symbol.startLine}\``
              )
            : ['_none_']),
          '',
          `### Outbound (${result.outbound.length})`,
          ...(result.outbound.length
            ? result.outbound.map(
                (h) =>
                  `- d${h.depth} ${h.symbol.name} (${h.symbol.kind}) \`${h.symbol.file}:${h.symbol.startLine}\``
              )
            : ['_none_']),
        ]
        return { content: [{ type: 'text', text: lines.join('\n') }] }
      }
    )
  )

  s.registerTool(
    'prjct_architecture',
    {
      description:
        'Structural architecture overview: languages, symbol kinds, packages, hotspots (call fan-in), routes, entry candidates. One shot — prefer over tree walks.',
      inputSchema: z.object({
        projectPath: optionalProjectPath,
        full: z.boolean().optional(),
      }),
    },
    safeMcpCall('prjct_architecture', async (args: { projectPath: string; full?: boolean }) => {
      const projectId = await resolveProjectId(args.projectPath)
      const snap = buildArchitectureSnapshot(projectId)
      const md = formatArchitectureMd(snap)
      // Index-derived and static between syncs — cap by default, gate repeats.
      const capped =
        !args.full && md.length > 4_000
          ? `${md.slice(0, 3_980).trimEnd()}\n_…truncated (full:true)_`
          : md
      return gatedTextResult(projectId, 'architecture', capped, args.full)
    })
  )

  s.registerTool(
    'prjct_dead_code',
    {
      description:
        'Find functions/methods/classes with zero inbound CALLS (excludes entry points, tests, types). Best-effort graph.',
      inputSchema: z.object({
        projectPath: optionalProjectPath,
        limit: boundedLimit(50, 100).describe('Max candidates'),
      }),
    },
    safeMcpCall('prjct_dead_code', async (args: { projectPath: string; limit: number }) => {
      const projectId = await resolveProjectId(args.projectPath)
      const result = findDeadCode(projectId, { limit: args.limit })
      return { content: [{ type: 'text', text: formatDeadCodeMd(result) }] }
    })
  )

  s.registerTool(
    'prjct_import_graph',
    {
      description:
        'Import graph stats + file neighbors (imports/importers). Pass a file for its neighbors, omit for graph stats.',
      inputSchema: z.object({
        projectPath: optionalProjectPath,
        file: z
          .string()
          .optional()
          .describe('File path to get neighbors for (omit for graph stats)'),
        rebuild: z.boolean().optional().default(false).describe('Force rebuild the import graph'),
      }),
    },
    safeMcpCall(
      'prjct_import_graph',
      async (args: { projectPath: string; file?: string; rebuild: boolean }) => {
        const projectId = await resolveProjectId(args.projectPath)

        const graph =
          (args.rebuild ? null : loadGraph(projectId)) ??
          (await indexImports(resolveProjectPath(args.projectPath), projectId))

        if (args.file) {
          const imports = graph.forward[args.file] || []
          const importers = graph.reverse[args.file] || []

          const parts = [
            `## Import Neighbors: ${args.file}`,
            `\n### Imports (${imports.length})`,
            ...imports.map((f) => `- ${f}`),
            `\n### Imported By (${importers.length})`,
            ...importers.map((f) => `- ${f}`),
          ]

          return { content: [{ type: 'text', text: parts.join('\n') }] }
        }

        const parts = [
          '## Import Graph Stats',
          `Files: ${graph.fileCount}`,
          `Edges: ${graph.edgeCount}`,
          `Built: ${graph.builtAt}`,
        ]

        return { content: [{ type: 'text', text: parts.join('\n') }] }
      }
    )
  )

  s.registerTool(
    'prjct_cochange',
    {
      description: 'Files that historically change together (Jaccard similarity from git history)',
      inputSchema: z.object({
        projectPath: optionalProjectPath,
        seedFiles: z.array(z.string()).describe('Seed files to find co-change partners for'),
        rebuild: z
          .boolean()
          .optional()
          .default(false)
          .describe('Force rebuild the co-change matrix'),
        maxResults: boundedLimit(10, 50).describe('Max results (default 10)'),
      }),
    },
    safeMcpCall(
      'prjct_cochange',
      async (args: {
        projectPath: string
        seedFiles: string[]
        rebuild: boolean
        maxResults: number
      }) => {
        const projectId = await resolveProjectId(args.projectPath)

        const index =
          (args.rebuild ? null : loadMatrix(projectId)) ??
          (await indexCoChanges(resolveProjectPath(args.projectPath), projectId))

        const scores = cochangeScore(args.seedFiles, index).slice(0, args.maxResults)

        if (scores.length === 0) {
          return { content: [{ type: 'text', text: 'No co-change partners found.' }] }
        }

        const parts = [
          `## Co-Change Partners`,
          `Seeds: ${args.seedFiles.join(', ')}`,
          `Commits analyzed: ${index.commitsAnalyzed}`,
          '',
        ]

        for (const s of scores) {
          parts.push(`- ${s.path} (similarity: ${Math.round(s.score * 100)}%)`)
        }

        return { content: [{ type: 'text', text: parts.join('\n') }] }
      }
    )
  )

  s.registerTool(
    'prjct_related_context',
    {
      description: 'Combined: import neighbors + co-change partners for seed files',
      inputSchema: z.object({
        projectPath: optionalProjectPath,
        seedFiles: z.array(z.string()).describe('Seed files to find related context for'),
        maxResults: boundedLimit(15, 50).describe('Max results (default 15)'),
      }),
    },
    safeMcpCall(
      'prjct_related_context',
      async (args: { projectPath: string; seedFiles: string[]; maxResults: number }) => {
        const projectId = await resolveProjectId(args.projectPath)

        // Gather import graph scores
        const graph = loadGraph(projectId)
        const importScores = graph ? importScore(args.seedFiles, graph) : []

        // Gather co-change scores
        const cochangeIndex = loadMatrix(projectId)
        const cochangeScores = cochangeIndex ? cochangeScore(args.seedFiles, cochangeIndex) : []

        // Merge scores: combine import + cochange, take max
        const merged = new Map<string, { importScore: number; cochangeScore: number }>()

        for (const s of importScores) {
          merged.set(s.path, { importScore: s.score, cochangeScore: 0 })
        }
        for (const s2 of cochangeScores) {
          const existing = merged.get(s2.path)
          if (existing) {
            existing.cochangeScore = s2.score
          } else {
            merged.set(s2.path, {
              importScore: 0,
              cochangeScore: s2.score,
            })
          }
        }

        // Sort by combined score (weighted average)
        const results = Array.from(merged.entries())
          .map(([path, scores]) => ({
            path,
            combined: scores.importScore * 0.6 + scores.cochangeScore * 0.4,
            importScore: scores.importScore,
            cochangeScore: scores.cochangeScore,
          }))
          .sort((a, b) => b.combined - a.combined)
          .slice(0, args.maxResults)

        if (results.length === 0) {
          return {
            content: [
              { type: 'text', text: 'No related files found. Run `prjct sync` to build indexes.' },
            ],
          }
        }

        const parts = [`## Related Context`, `Seeds: ${args.seedFiles.join(', ')}`, '']

        for (const r of results) {
          const sources: string[] = []
          if (r.importScore > 0) sources.push(`import: ${r.importScore.toFixed(2)}`)
          if (r.cochangeScore > 0) sources.push(`cochange: ${Math.round(r.cochangeScore * 100)}%`)
          parts.push(`- ${r.path} (${sources.join(', ')})`)
        }

        return { content: [{ type: 'text', text: parts.join('\n') }] }
      }
    )
  )
}
