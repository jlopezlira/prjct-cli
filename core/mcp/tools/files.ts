/**
 * MCP File Tools (3 tools)
 *
 * Wraps existing context tools: files-tool, signatures-tool, state-storage.
 */
import type { McpServer } from '@modelcontextprotocol/server'
import { z } from 'zod'
import { stateStorage } from '../../storage/state-storage'
import { findRelevantFiles } from '../../tools/context/files-tool'
import { extractSignatures } from '../../tools/context/signatures-tool'
import { boundedLimit, optionalProjectPath, resolveProjectId, resolveProjectPath } from '../resolve'
import { safeMcpCall } from './error-handler'

// MCP SDK TS2589 workaround: cast server to avoid deep type instantiation
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type S = any

export function registerFileTools(server: McpServer) {
  const s: S = server

  s.registerTool(
    'prjct_relevant_files',
    {
      description:
        'MUST call before Grep/Glob tree walks. Resolves a constrained work scope via prjct: memory (FTS + semantic embeddings when enabled) + code BM25 + symbol graph + import graph + co-change. Prefer this over scanning the repo. For call chains use prjct_trace_path.',
      inputSchema: z.object({
        projectPath: optionalProjectPath,
        query: z.string().describe('Task or query to find relevant files for'),
        maxFiles: boundedLimit(10, 25).describe('Max files to return'),
      }),
    },
    safeMcpCall(
      'prjct_relevant_files',
      async (args: { projectPath: string; query: string; maxFiles: number }) => {
        // Prefer unified work-scope (memory vector/FTS + index + graph).
        try {
          const projectId = await resolveProjectId(args.projectPath)
          if (projectId) {
            const { resolveWorkScope, formatWorkScopeBlock } = await import(
              '../../services/work-scope'
            )
            const scope = await resolveWorkScope(
              resolveProjectPath(args.projectPath),
              projectId,
              args.query,
              args.maxFiles
            )
            if (scope.files.length > 0) {
              return {
                content: [
                  {
                    type: 'text',
                    text: [
                      formatWorkScopeBlock(scope.files, {
                        indexesReady: scope.indexesReady,
                        memorySeeds: scope.sources.memorySeeds,
                      }),
                      '',
                      `_sources: memorySeeds=${scope.sources.memorySeeds} indexHits=${scope.sources.indexHits} graphNeighbors=${scope.sources.graphNeighbors}_`,
                    ].join('\n'),
                  },
                ],
              }
            }
          }
        } catch {
          /* fall through to live scan */
        }

        // Fallback: live path scan (only when indexes/memory empty).
        const result = await findRelevantFiles(args.query, resolveProjectPath(args.projectPath), {
          maxFiles: args.maxFiles,
          minScore: 0.1,
        })

        if (result.files.length === 0) {
          return {
            content: [
              {
                type: 'text',
                text: 'No relevant files found. Run `prjct sync` to rebuild indexes, then retry. Prefer `prjct context memory <topic>` over Grep/Glob.',
              },
            ],
          }
        }

        const lines = result.files.map(
          (f) => `- \`${f.path}\` (score: ${Math.round(f.score * 100)}%) — ${f.reasons.join(', ')}`
        )
        const text = `## Relevant Files (fallback scan ${result.files.length}/${result.metrics.filesScanned})\n\n> Prefer re-running after \`prjct sync\` so memory+BM25+graph scope is used.\n\n${lines.join('\n')}`
        return { content: [{ type: 'text', text }] }
      }
    )
  )

  s.registerTool(
    'prjct_signatures',
    {
      description:
        'Function/class signatures of a file without bodies (~90% fewer tokens). Use to map an unfamiliar file before deciding whether to Read it fully.',
      inputSchema: z.object({
        projectPath: optionalProjectPath,
        filePath: z.string().describe('Relative file path to extract signatures from'),
      }),
    },
    safeMcpCall('prjct_signatures', async (args: { projectPath: string; filePath: string }) => {
      const result = await extractSignatures(args.filePath, args.projectPath)

      if (result.signatures.length === 0) {
        return {
          content: [
            {
              type: 'text',
              text: result.fallback
                ? `No signatures extracted: ${result.fallbackReason}`
                : 'No signatures found.',
            },
          ],
        }
      }

      const lines = result.signatures.map(
        (s) =>
          `${s.exported ? 'export ' : ''}${s.type} ${s.name}: ${s.signature}${s.docstring ? ` // ${s.docstring}` : ''}`
      )
      const compression = result.metrics?.compression
        ? ` (${Math.round(result.metrics.compression * 100)}% reduction)`
        : ''
      const text = `## ${result.file} (${result.language})\n\`\`\`\n${lines.join('\n')}\n\`\`\`${compression}`
      return { content: [{ type: 'text', text }] }
    })
  )

  s.registerTool(
    'prjct_history',
    {
      description:
        'Recently completed tasks and how they ended. Use to learn what was just done before continuing related work.',
      inputSchema: z.object({
        projectPath: optionalProjectPath,
        limit: boundedLimit(10, 50).describe('Max results'),
      }),
    },
    safeMcpCall('prjct_history', async (args: { projectPath: string; limit: number }) => {
      const projectId = await resolveProjectId(args.projectPath)
      const history = await stateStorage.getTaskHistory(projectId)

      if (history.length === 0) {
        return { content: [{ type: 'text', text: 'No task history.' }] }
      }

      const recent = history.slice(-args.limit).reverse()
      const lines = recent.map((t) => {
        const parts = [`- **${t.title}**`]
        if (t.completedAt) parts.push(`completed: ${t.completedAt}`)
        if (t.classification) parts.push(`type: ${t.classification}`)
        return parts.join(' | ')
      })

      const text = `## Task History (${history.length} total)\n\n${lines.join('\n')}`
      return { content: [{ type: 'text', text }] }
    })
  )
}
