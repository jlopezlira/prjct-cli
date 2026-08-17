/**
 * MCP Memory Tools (v2).
 *
 * Thin wrapper over `projectMemory` — the single source of truth for
 * project memory in v2. The pre-v2 surface (14 tools backed by
 * SemanticMemories + PatternStore + MemorySystem) was collapsed in
 * Phase C: those layers duplicated what `projectMemory` already does
 * and made the API confusing for Claude (which to call?).
 *
 * Tools exposed (5 total):
 *   - prjct_mem_save   — persist a memory entry
 *   - prjct_mem_list   — recall with optional topic / types / tags
 *   - prjct_mem_similar — fuzzy match against a description
 *   - prjct_mem_forget — remove an entry by id
 *   - prjct_guard      — ANTICIPATION: preventive memory for a file, on demand
 *
 * `prjct_guard` is the pull-based form of pillar 3 (anticipation): an
 * agent asks "what should I know before editing this file?" and gets back
 * only the gotchas / anti-patterns / recurring-bugs recorded against it.
 * Provider-agnostic — Codex (no hooks) and Claude both reach it here,
 * instead of pushing the warning into every turn's context.
 *
 * `prjct capture` / `prjct remember` from the CLI call the same
 * `projectMemory` API, so whatever the human types in the terminal
 * is visible here too, and vice versa.
 */
import type { McpServer } from '@modelcontextprotocol/server'
import { z } from 'zod'
import { enrichedRecall } from '../../memory/enriched-recall'
import { BASE_MEMORY_TYPES, type MemoryType } from '../../memory/entries'
import { formatMemoryMd } from '../../memory/format'
import { projectMemory } from '../../memory/project-memory'
import { evaluateMemoryContent } from '../../services/trust-boundary'
import { recordSurfacedForActiveTask } from '../../services/usefulness/surface-attribution'
import { optionalProjectPath, resolveProjectId, resolveProjectPath } from '../resolve'
import { safeMcpCall } from './error-handler'

// MCP SDK TS2589 workaround: cast server to any to avoid deep type
// instantiation during tool registration.
type S = any

const TYPE_DESCRIPTIONS = `Base types: ${BASE_MEMORY_TYPES.join(', ')}. Any lowercase identifier is accepted (e.g. "recipe", "okr").`

/**
 * @param options.extended — standard+ only: typed record verbs (decision/gotcha/…)
 *   that alias mem_save. Keep them off core ListTools to cut schema tokens.
 */
export function registerMemoryTools(server: McpServer, options: { extended?: boolean } = {}) {
  const s: S = server

  s.registerTool(
    'prjct_mem_save',
    {
      description:
        'Save durable project memory in English. Use tags.topic for evolving subjects; matching topics supersede older entries.',
      inputSchema: z.object({
        projectPath: optionalProjectPath,
        type: z.string().describe('e.g. fact, decision, learning, or a custom type'),
        content: z.string(),
        tags: z
          .record(z.string(), z.string())
          .optional()
          .describe('k:v metadata, e.g. {domain: "auth"}'),
        source: z.string().optional().describe('Originating task id'),
        force: z.boolean().optional().describe('Allow content rejected as secret-like'),
      }),
    },
    safeMcpCall(
      'prjct_mem_save',
      async (args: {
        projectPath: string
        type: string
        content: string
        tags?: Record<string, string>
        source?: string
        force?: boolean
      }) => {
        await resolveProjectId(args.projectPath)

        const typeStr = args.type.toLowerCase().trim()
        if (!typeStr || !/^[a-z][a-z0-9-]*$/.test(typeStr)) {
          return {
            content: [
              {
                type: 'text',
                text: `Invalid type '${args.type}'. Lowercase letters + dashes only. ${TYPE_DESCRIPTIONS}`,
              },
            ],
          }
        }

        const trust = evaluateMemoryContent(args.content, { force: args.force })
        if (!trust.allow) {
          return {
            content: [
              {
                type: 'text',
                text:
                  trust.kind === 'secrets'
                    ? `Refused — content looks like a secret (${trust.hits.join(', ')}). Re-call with force=true if intentional.`
                    : trust.kind === 'prompt_injection'
                      ? `Refused — content looks like prompt injection (${trust.hits.join(', ')}). Memory entries are inlined into LLM context. Re-call with force=true if intentional.`
                      : `Refused — ${trust.denyMessage}`,
              },
            ],
          }
        }

        const projectPath = resolveProjectPath(args.projectPath)
        await projectMemory.remember(resolveProjectPath(projectPath), {
          type: typeStr,
          content: args.content,
          tags: args.tags ?? {},
          source: args.source,
          force: args.force,
        })
        return {
          content: [{ type: 'text', text: `Saved ${typeStr}: ${args.content.slice(0, 80)}` }],
        }
      }
    )
  )

  s.registerTool(
    'prjct_mem_list',
    {
      description:
        'Recall ranked memory as compact, resolvable cues. Filter by topic, types, tags, or limit.',
      inputSchema: z.object({
        projectPath: optionalProjectPath,
        topic: z.string().optional().describe('Keyword to match over content + tag values'),
        types: z.array(z.string()).optional(),
        tags: z.record(z.string(), z.string()).optional().describe('Exact k:v match'),
        limit: z.number().optional().default(25),
      }),
    },
    safeMcpCall(
      'prjct_mem_list',
      async (args: {
        projectPath: string
        topic?: string
        types?: string[]
        tags?: Record<string, string>
        limit?: number
      }) => {
        const projectId = await resolveProjectId(args.projectPath)
        // Same pipeline as `prjct context memory` (FTS-first, semantic
        // blend, usefulness rerank, link expansion, ship attribution).
        // Subagents reach memory through THIS tool — a plain recency
        // recall here gave them strictly worse retrieval than the CLI.
        const entries = await enrichedRecall(resolveProjectPath(args.projectPath), projectId, {
          topic: args.topic,
          types: args.types as MemoryType[] | undefined,
          tags: args.tags,
          limit: args.limit,
        })
        return {
          content: [
            { type: 'text', text: formatMemoryMd(entries, { boundary: 'llm', compact: true }) },
          ],
        }
      }
    )
  )

  s.registerTool(
    'prjct_mem_similar',
    {
      description:
        'Find ranked memory related to a free-text description; returns compact, resolvable cues.',
      inputSchema: z.object({
        projectPath: optionalProjectPath,
        description: z.string(),
        limit: z.number().optional().default(10),
      }),
    },
    safeMcpCall(
      'prjct_mem_similar',
      async (args: { projectPath: string; description: string; limit?: number }) => {
        const projectId = await resolveProjectId(args.projectPath)
        // enrichedRecall with the description as topic: BM25 + semantic
        // beat the old shared-keyword `similar()` heuristic. Link
        // expansion off — similarity asks "does this exist?", not "give
        // me its whole neighborhood".
        const entries = await enrichedRecall(resolveProjectPath(args.projectPath), projectId, {
          topic: args.description,
          limit: args.limit ?? 10,
          expandLinks: false,
        })
        if (entries.length === 0) {
          return { content: [{ type: 'text', text: 'No similar memories found.' }] }
        }
        return {
          content: [
            { type: 'text', text: formatMemoryMd(entries, { boundary: 'llm', compact: true }) },
          ],
        }
      }
    )
  )

  s.registerTool(
    'prjct_guard',
    {
      description:
        'Before editing a file, retrieve preventive gotchas and recurring failures. Empty means clear to edit.',
      inputSchema: z.object({
        projectPath: optionalProjectPath,
        file: z.string().describe('Absolute or repo-relative path'),
        limit: z.number().optional().default(3),
      }),
    },
    safeMcpCall(
      'prjct_guard',
      async (args: { projectPath: string; file: string; limit?: number }) => {
        const projectId = await resolveProjectId(args.projectPath)
        const hits = projectMemory.recallForFile(projectId, args.file, args.limit ?? 3)
        // Push-path ship attribution (see surface-attribution.ts).
        void recordSurfacedForActiveTask(
          projectId,
          args.projectPath,
          hits.map((e) => e.id)
        )
        if (hits.length === 0) {
          const base = args.file.split('/').pop() ?? args.file
          return {
            content: [{ type: 'text', text: `No preventive memory for ${base} — clear to edit.` }],
          }
        }
        return { content: [{ type: 'text', text: formatMemoryMd(hits, { boundary: 'llm' }) }] }
      }
    )
  )

  s.registerTool(
    'prjct_mem_forget',
    {
      description: 'Delete a memory by stable id from prjct_mem_list.',
      inputSchema: z.object({
        projectPath: optionalProjectPath,
        id: z.string().describe('e.g. "mem_42" or "ship_7"'),
      }),
    },
    safeMcpCall('prjct_mem_forget', async (args: { projectPath?: string; id: string }) => {
      const projectId = await resolveProjectId(args.projectPath)
      const removed = projectMemory.forget(projectId, args.id)
      return {
        content: [
          {
            type: 'text',
            text: removed
              ? `✓ forgot ${args.id} — removed from recall, search, and embeddings.`
              : `_No memory entry with id ${args.id} (already gone, or not a remember entry)._`,
          },
        ],
      }
    })
  )

  // --- Typed memory verbs (standard+) — alias mem_save; keep off core ListTools. ---
  if (!options.extended) return

  async function saveTyped(
    projectPath: string | undefined,
    type: MemoryType,
    content: string,
    tags: Record<string, string> = {}
  ): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
    const path = resolveProjectPath(projectPath)
    await resolveProjectId(path)
    const trust = evaluateMemoryContent(content)
    if (!trust.allow) {
      return {
        content: [
          {
            type: 'text',
            text:
              trust.kind === 'secrets'
                ? `Refused — content looks like a secret (${trust.hits.join(', ')}). Use prjct_mem_save with force=true if intentional.`
                : trust.kind === 'prompt_injection'
                  ? `Refused — content looks like prompt injection (${trust.hits.join(', ')}). Use prjct_mem_save with force=true if intentional.`
                  : `Refused — ${trust.denyMessage}`,
          },
        ],
      }
    }
    await projectMemory.remember(path, { type, content, tags })
    return { content: [{ type: 'text', text: `Saved ${type}: ${content.slice(0, 80)}` }] }
  }

  s.registerTool(
    'prjct_record_decision',
    {
      description:
        'Record a DECISION: what was decided, why, and alternatives. Author in ENGLISH. (Or use prjct_mem_save type=decision.)',
      inputSchema: z.object({
        projectPath: optionalProjectPath,
        decision: z.string().describe('What was decided'),
        rationale: z.string().optional().describe('Why'),
        alternatives: z.array(z.string()).optional().describe('Rejected options'),
      }),
    },
    safeMcpCall(
      'prjct_record_decision',
      async (args: {
        projectPath?: string
        decision: string
        rationale?: string
        alternatives?: string[]
      }) => {
        const parts = [args.decision]
        if (args.rationale) parts.push(`\nWhy: ${args.rationale}`)
        if (args.alternatives?.length)
          parts.push(`\nAlternatives considered: ${args.alternatives.join('; ')}`)
        return saveTyped(args.projectPath, 'decision', parts.join(''))
      }
    )
  )

  s.registerTool(
    'prjct_record_gotcha',
    {
      description:
        'Record a GOTCHA (trap + fix). Tag file for prjct_guard. (Or prjct_mem_save type=gotcha.)',
      inputSchema: z.object({
        projectPath: optionalProjectPath,
        symptom: z.string().describe('What goes wrong'),
        fix: z.string().describe('How to avoid/fix'),
        file: z.string().optional().describe('File path for guard'),
      }),
    },
    safeMcpCall(
      'prjct_record_gotcha',
      async (args: { projectPath?: string; symptom: string; fix: string; file?: string }) => {
        return saveTyped(
          args.projectPath,
          'gotcha',
          `${args.symptom}\nFix: ${args.fix}`,
          args.file ? { file: args.file } : {}
        )
      }
    )
  )

  s.registerTool(
    'prjct_record_learning',
    {
      description:
        'Record a LEARNING + evidence. Author in ENGLISH. (Or prjct_mem_save type=learning.)',
      inputSchema: z.object({
        projectPath: optionalProjectPath,
        claim: z.string().describe('What was learned'),
        evidence: z.string().optional().describe('Supporting observation'),
      }),
    },
    safeMcpCall(
      'prjct_record_learning',
      async (args: { projectPath?: string; claim: string; evidence?: string }) => {
        const content = args.evidence ? `${args.claim}\nEvidence: ${args.evidence}` : args.claim
        return saveTyped(args.projectPath, 'learning', content)
      }
    )
  )

  s.registerTool(
    'prjct_record_fact',
    {
      description:
        'Record a FACT about a subject. Author in ENGLISH. (Or prjct_mem_save type=fact.)',
      inputSchema: z.object({
        projectPath: optionalProjectPath,
        subject: z.string().describe('Subject'),
        statement: z.string().describe('The fact'),
      }),
    },
    safeMcpCall(
      'prjct_record_fact',
      async (args: { projectPath?: string; subject: string; statement: string }) => {
        return saveTyped(args.projectPath, 'fact', `${args.subject}: ${args.statement}`, {
          subject: args.subject,
        })
      }
    )
  )

  s.registerTool(
    'prjct_capture_inbox',
    {
      description: 'Quick INBOX capture for later triage. (Or prjct_mem_save type=inbox.)',
      inputSchema: z.object({
        projectPath: optionalProjectPath,
        text: z.string().describe('Note text'),
      }),
    },
    safeMcpCall('prjct_capture_inbox', async (args: { projectPath?: string; text: string }) => {
      return saveTyped(args.projectPath, 'inbox', args.text)
    })
  )
}
