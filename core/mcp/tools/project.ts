/**
 * MCP Project Tools.
 *
 * Outcome-backed tools (velocity, outcomes_search/similar/recent,
 * estimate_accuracy, velocity_detail) were removed alongside the
 * outcome-* subsystem — it had zero writers, so every one of them
 * returned "No outcome data yet" in practice. When a real outcome
 * feed lands (e.g. driven by the Stop hook capturing durations),
 * add the relevant tools back here.
 */
import type { McpServer } from '@modelcontextprotocol/server'
import { z } from 'zod'
import { formatLikelyFileForAgent } from '../../services/file-cue'
import { collectActiveTasks } from '../../services/task-overview'
import {
  formatRelatedContextForAgent,
  formatRiskForAgent,
  setTaskStatus,
  startTask,
} from '../../services/task-service'
import { recordTaskTokenUsage } from '../../services/work-cost-service'
import llmAnalysisStorage from '../../storage/llm-analysis-storage'
import { queueStorage } from '../../storage/queue-storage'
import { optionalProjectPath, resolveProjectId, resolveProjectPath } from '../resolve'
import { safeMcpCall } from './error-handler'

// MCP SDK TS2589 workaround: cast server to avoid deep type instantiation
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type S = any

/**
 * @param options.extended — standard/all tiers only: context_tiers + safe_artifacts
 *   stay off the default core surface so L0 MCP schema stays ≤20 tools.
 */
export function registerProjectTools(server: McpServer, options: { extended?: boolean } = {}) {
  const s: S = server

  // Core: managed session resume (high-value land→prime continuity).
  s.registerTool(
    'prjct_session_resume',
    {
      description:
        'Resume after a fresh window: active cycle, last hand-off, journal, and next actions.',
      inputSchema: z.object({
        projectPath: optionalProjectPath,
      }),
    },
    safeMcpCall('prjct_session_resume', async (args: { projectPath: string }) => {
      const projectId = await resolveProjectId(args.projectPath)
      const overview = await collectActiveTasks(projectId, resolveProjectPath(args.projectPath))
      const { loadSessionContinuity, loadLastSessionCloseContent, formatSessionResumeCard } =
        await import('../../services/session-continuity')
      const stamp = loadSessionContinuity(projectId)
      const current = overview.current
      const journal = current
        ? await import('../../storage/database').then(({ prjctDb }) =>
            prjctDb
              .query<{ content: string }>(
                projectId,
                'SELECT content FROM task_log WHERE task_id = ? ORDER BY id DESC LIMIT 3',
                current.id
              )
              .map((j) => j.content)
              .reverse()
          )
        : []
      const pendingHandoffCue = await import('../../services/agent-switch')
        .then(({ formatPendingHandoffCue }) => formatPendingHandoffCue(projectId))
        .catch(() => null)
      const md = formatSessionResumeCard({
        stamp,
        liveCycleDescription: overview.current?.description ?? null,
        liveCycleId: overview.current?.id ?? null,
        journal,
        sessionCloseContent: loadLastSessionCloseContent(projectId),
        pendingHandoffCue,
      })
      return { content: [{ type: 'text', text: md }] }
    })
  )

  s.registerTool(
    'prjct_task_status',
    {
      description: 'Read active work across worktrees plus queued work.',
      inputSchema: z.object({
        projectPath: optionalProjectPath,
      }),
    },
    safeMcpCall('prjct_task_status', async (args: { projectPath: string }) => {
      const projectId = await resolveProjectId(args.projectPath)
      const overview = await collectActiveTasks(projectId, resolveProjectPath(args.projectPath))
      const queue = await queueStorage.getActiveTasks(projectId)

      const parts: string[] = []
      if (overview.all.length === 0) {
        parts.push('No active work cycle.')
      } else if (overview.all.length === 1 && overview.current) {
        const v = overview.current
        parts.push(`## Active Work Cycle\n**${v.description}**`)
        parts.push(`Workspace: ${v.label}`)
        if (v.branch) parts.push(`Branch: ${v.branch}`)
        parts.push(`Started: ${v.startedAt}`)
      } else {
        parts.push(`## Active Tasks (${overview.all.length})`)
        for (const v of overview.all) {
          const here = v.isCurrent ? ' [this worktree]' : ''
          parts.push(`-${here} ${v.label}: ${v.description} — started ${v.startedAt}`)
        }
      }

      if (queue.length > 0) {
        parts.push(`\n## Queue (${queue.length} work items)`)
        for (const t of queue.slice(0, 10)) {
          parts.push(`- ${t.description} [${t.priority || 'medium'}]`)
        }
      }

      return { content: [{ type: 'text', text: parts.join('\n') }] }
    })
  )

  s.registerTool(
    'prjct_task_start',
    {
      description:
        'Start a gated work cycle and return predicted file risks and context. Link a spec only when durable intent is required.',
      inputSchema: z.object({
        projectPath: optionalProjectPath,
        description: z.string().describe('What the work cycle is — a short intent phrase'),
        linked_spec_id: z
          .string()
          .optional()
          .describe('Intent/spec id to link for high-stakes work (e.g. "spec_12")'),
        skip_hooks: z
          .boolean()
          .optional()
          .describe('Skip before/after workflow rules. Default false.'),
      }),
    },
    safeMcpCall(
      'prjct_task_start',
      async (args: {
        projectPath: string
        description: string
        linked_spec_id?: string
        skip_hooks?: boolean
      }) => {
        const projectId = await resolveProjectId(args.projectPath)
        const outcome = await startTask(
          projectId,
          resolveProjectPath(args.projectPath),
          args.description,
          {
            spec: args.linked_spec_id,
            skipHooks: args.skip_hooks,
          }
        )
        if (!outcome.ok) {
          return { content: [{ type: 'text', text: outcome.blocked ?? 'Work start was blocked.' }] }
        }
        const lines = [`✓ Work cycle started: ${outcome.description}`, `Id: ${outcome.taskId}`]
        if (outcome.branch) lines.push(`Branch: ${outcome.branch}`)
        if (outcome.linearId) lines.push(`Linear: ${outcome.linearId}`)
        if (outcome.linkedSpecId) lines.push(`Linked spec: ${outcome.linkedSpecId}`)
        if (outcome.harness) {
          lines.push(
            `Harness: ${outcome.harness.level} ${outcome.harness.kind}/${outcome.harness.risk}`
          )
          if (outcome.harness.expectedEvidence.length > 0) {
            lines.push(`Evidence: ${outcome.harness.expectedEvidence.join(', ')}`)
          }
        }
        if (outcome.instructions && outcome.instructions.length > 0) {
          lines.push('', 'Agent instructions:')
          for (const i of outcome.instructions) lines.push(`- ${i}`)
        }
        // Predictive risk FIRST (CLI parity): traps before related context / file map.
        const risks = outcome.risks ?? []
        if (risks.length > 0) {
          lines.push('', '⚠ Risk — what bit us in this area before (read before you edit):')
          for (const r of risks) lines.push(`- ${formatRiskForAgent(r)}`)
        }
        if (outcome.relatedContext && outcome.relatedContext.length > 0) {
          lines.push('', 'Related second-brain context (pull full bodies with prjct_search):')
          for (const hit of outcome.relatedContext.slice(0, 4)) {
            lines.push(`- ${formatRelatedContextForAgent(hit)}`)
          }
        }
        if (outcome.likelyFiles && outcome.likelyFiles.length > 0) {
          lines.push(
            '',
            'Work scope (prjct memory+index+graph) — MUST open these before Grep/Glob:'
          )
          for (const file of outcome.likelyFiles) {
            lines.push(`- ${formatLikelyFileForAgent(file)}`)
          }
          lines.push(
            'Expand only via prjct_guard / prjct_relevant_files / prjct_impact_analysis — do not tree-walk.'
          )
        } else {
          lines.push(
            '',
            'Work scope empty — MUST call prjct_relevant_files or prjct context memory before Grep/Glob (run prjct sync if indexes cold).'
          )
        }
        return { content: [{ type: 'text', text: lines.join('\n') }] }
      }
    )
  )

  s.registerTool(
    'prjct_task_set_status',
    {
      description:
        'Transition the active cycle status. Use prjct_cost_add instead for token usage.',
      inputSchema: z.object({
        projectPath: optionalProjectPath,
        status: z
          .enum(['done', 'completed', 'paused', 'active', 'resume', 'in_progress'])
          .describe('New status'),
      }),
    },
    safeMcpCall('prjct_task_set_status', async (args: { projectPath: string; status: string }) => {
      const projectId = await resolveProjectId(args.projectPath)
      const outcome = await setTaskStatus(
        projectId,
        resolveProjectPath(args.projectPath),
        args.status
      )
      if (!outcome.ok) {
        const text =
          outcome.reason === 'unsupported'
            ? outcome.message
            : 'No active work cycle to update. Start one with prjct_task_start.'
        return { content: [{ type: 'text', text }] }
      }
      const warnings = outcome.verificationWarnings ?? []
      const text = [`✓ status → ${outcome.status} (task ${outcome.taskId})`]
      if (warnings.length > 0) {
        text.push('', 'Harness warnings:')
        for (const warning of warnings) text.push(`- ${warning}`)
      }
      if (outcome.contextPrompt) text.push('', outcome.contextPrompt)
      return {
        content: [{ type: 'text', text: text.join('\n') }],
      }
    })
  )

  s.registerTool(
    'prjct_analysis',
    {
      description:
        'Read stored architecture, stack, conventions, risks, and insights. mode:"archive" includes superseded analyses.',
      inputSchema: z.object({
        projectPath: optionalProjectPath,
        mode: z
          .enum(['active', 'archive'])
          .optional()
          .describe('"active" (default) = current analysis; "archive" = superseded history'),
      }),
    },
    safeMcpCall(
      'prjct_analysis',
      async (args: { projectPath: string; mode?: 'active' | 'archive' }) => {
        const projectId = await resolveProjectId(args.projectPath)

        if (args.mode === 'archive') {
          const superseded = llmAnalysisStorage
            .getAllFull(projectId)
            .filter((a) => a.status === 'superseded')
          if (!superseded.length) {
            return { content: [{ type: 'text', text: 'No superseded analyses in the archive.' }] }
          }
          const lines = ['## Analysis Archive (superseded)']
          for (const a of superseded) {
            const commit = a.commitHash ? a.commitHash.slice(0, 8) : 'unknown'
            lines.push(
              `\n### ${a.analyzedAt} (commit ${commit})`,
              `Style: ${a.analysis.architecture?.style ?? 'unknown'} · patterns ${a.analysis.patterns?.length ?? 0} · anti-patterns ${a.analysis.antiPatterns?.length ?? 0} · tech-debt ${a.analysis.techDebt?.length ?? 0}`
            )
          }
          return { content: [{ type: 'text', text: lines.join('\n') }] }
        }

        // C3: read the synthesis as RELATIONAL records (no blob parse) when
        // available; fall back to the blob only for pre-C3 analyses.
        const rel = llmAnalysisStorage.getActiveRelational(projectId)
        if (rel) {
          const out: string[] = ['## Project Analysis']
          if (rel.domains.length) out.push(`\n### Architecture\nDomains: ${rel.domains.join(', ')}`)
          const langs = rel.stack.filter((s) => s.kind === 'language').map((s) => s.name)
          const fws = rel.stack.filter((s) => s.kind === 'framework').map((s) => s.name)
          if (langs.length || fws.length) {
            out.push('\n### Stack')
            if (langs.length) out.push(`Languages: ${langs.join(', ')}`)
            if (fws.length) out.push(`Frameworks: ${fws.join(', ')}`)
          }
          const byKind = (k: string) => rel.findings.filter((f) => f.kind === k)
          const section = (label: string, kind: string) => {
            const items = byKind(kind)
            if (!items.length) return
            out.push(`\n### ${label} (${items.length})`)
            for (const f of items) out.push(`- **${f.title}**${f.detail ? `: ${f.detail}` : ''}`)
          }
          section('Patterns', 'pattern')
          section('Anti-Patterns', 'anti_pattern')
          section('Tech Debt', 'tech_debt')
          section('Risk Areas', 'risk_area')
          section('Insights', 'insight')
          if (rel.conventions.length) {
            out.push(`\n### Conventions (${rel.conventions.length})`)
            for (const c of rel.conventions) out.push(`- ${c}`)
          }
          if (rel.commands.length) {
            out.push(`\n### Commands (${rel.commands.length})`)
            for (const c2 of rel.commands) out.push(`- **${c2.name}**: \`${c2.command}\``)
          }
          return { content: [{ type: 'text', text: out.join('\n') }] }
        }

        const analysis = llmAnalysisStorage.getActive(projectId)
        if (!analysis) {
          return { content: [{ type: 'text', text: 'No analysis available. Run `prjct sync`.' }] }
        }

        const parts: string[] = ['## Project Analysis']

        if (analysis.architecture?.style) {
          parts.push('\n### Architecture')
          parts.push(`Style: ${analysis.architecture.style}`)
          if (analysis.architecture.domains?.length)
            parts.push(`Domains: ${analysis.architecture.domains.join(', ')}`)
          for (const i of analysis.architecture.insights ?? []) parts.push(`- ${i}`)
        }

        if (analysis.stack) {
          parts.push('\n### Stack')
          if (analysis.stack.languages?.length)
            parts.push(`Languages: ${analysis.stack.languages.join(', ')}`)
          if (analysis.stack.frameworks?.length)
            parts.push(`Frameworks: ${analysis.stack.frameworks.join(', ')}`)
          if (analysis.stack.packageManager)
            parts.push(`Package Manager: ${analysis.stack.packageManager}`)
        }

        if (analysis.patterns?.length) {
          parts.push(`\n### Patterns (${analysis.patterns.length})`)
          for (const p of analysis.patterns) {
            parts.push(`- **${p.name}**: ${p.description}`)
          }
        }

        if (analysis.antiPatterns?.length) {
          parts.push(`\n### Anti-Patterns (${analysis.antiPatterns.length})`)
          for (const a2 of analysis.antiPatterns) {
            parts.push(`- **${a2.issue}**: ${a2.suggestion}`)
          }
        }

        if (analysis.conventions?.length) {
          parts.push(`\n### Conventions (${analysis.conventions.length})`)
          for (const c3 of analysis.conventions) {
            parts.push(`- [${c3.category}] ${c3.rule}`)
          }
        }

        if (analysis.techDebt?.length) {
          parts.push(`\n### Tech Debt (${analysis.techDebt.length})`)
          for (const d of analysis.techDebt) {
            parts.push(`- [${d.priority}/${d.effort}] ${d.description} (${d.area})`)
          }
        }

        const insights = analysis.projectInsights ?? []
        if (insights.length) {
          parts.push(`\n### Insights (${insights.length})`)
          for (const i2 of insights) parts.push(`- ${i2}`)
        }

        return { content: [{ type: 'text', text: parts.join('\n') }] }
      }
    )
  )

  // Standard+ only — cut ListTools token tax on default core (≤12 tools).
  // CLI parity: prjct cost, prjct context, prjct seed skills, etc.
  if (options.extended) {
    s.registerTool(
      'prjct_cost_add',
      {
        description: 'Record cycle token usage (cost/ROI). Pass model/runtime when known.',
        inputSchema: z.object({
          projectPath: optionalProjectPath,
          tokensIn: z.number().describe('Input tokens'),
          tokensOut: z.number().describe('Output tokens'),
          model: z.string().optional().describe('Model id'),
          runtime: z.string().optional().describe('Host: claude | codex | gemini | …'),
          isEstimated: z.boolean().optional().describe('True if estimated. Default false.'),
          workCycleId: z.string().optional().describe('Task id; defaults to active cycle'),
        }),
      },
      safeMcpCall(
        'prjct_cost_add',
        async (args: {
          projectPath?: string
          tokensIn: number
          tokensOut: number
          model?: string
          runtime?: string
          isEstimated?: boolean
          workCycleId?: string
        }) => {
          const path = resolveProjectPath(args.projectPath)
          const projectId = await resolveProjectId(path)
          const taskId =
            args.workCycleId ??
            (await import('../../services/task-service').then(({ resolveActiveTask }) =>
              resolveActiveTask(projectId, path).then((active) => active?.id)
            ))
          if (!taskId) {
            return {
              content: [
                {
                  type: 'text',
                  text: 'No work cycle to attribute cost to (pass workCycleId or start a cycle).',
                },
              ],
            }
          }
          recordTaskTokenUsage(projectId, taskId, args.tokensIn, args.tokensOut, {
            model: args.model,
            runtime: args.runtime,
            isEstimated: args.isEstimated ?? false,
            source: 'mcp',
          })
          return {
            content: [
              {
                type: 'text',
                text: `Recorded ${args.tokensIn} in / ${args.tokensOut} out${args.model ? ` (${args.model})` : ''} for ${taskId}.`,
              },
            ],
          }
        }
      )
    )

    s.registerTool(
      'prjct_developer',
      {
        description:
          'Synthesized developer profile (feedback + friction). Act as this developer would.',
        inputSchema: z.object({ projectPath: optionalProjectPath }),
      },
      safeMcpCall('prjct_developer', async (args: { projectPath?: string }) => {
        const projectId = await resolveProjectId(args.projectPath)
        const { projectMemory } = await import('../../memory/project-memory')
        const { buildDeveloperProfile } = await import('../../services/developer-profile')
        const { renderDeveloperEvolution } = await import('../../services/developer-evolution')
        const entries = projectMemory.allEntriesForIndex(projectId)
        const body = buildDeveloperProfile(entries)
        const evolution = renderDeveloperEvolution(projectId)
        const text =
          [body, evolution].filter(Boolean).join('\n\n') ||
          'No developer profile yet — capture `feedback` memories as preferences emerge.'
        return { content: [{ type: 'text', text }] }
      })
    )

    s.registerTool(
      'prjct_signals',
      {
        description: 'Machine signals: hot files, skill-misses, friction (transient telemetry).',
        inputSchema: z.object({ projectPath: optionalProjectPath }),
      },
      safeMcpCall('prjct_signals', async (args: { projectPath?: string }) => {
        const projectId = await resolveProjectId(args.projectPath)
        const { projectMemory } = await import('../../memory/project-memory')
        const { buildSignalsFile, isSignalEntry } = await import('../../services/signals-digest')
        const signals = projectMemory.allEntriesForIndex(projectId).filter(isSignalEntry)
        const body = buildSignalsFile(signals, { boundary: 'llm' })
        return { content: [{ type: 'text', text: body ?? 'No active signals.' }] }
      })
    )

    s.registerTool(
      'prjct_skills',
      {
        description: 'Skill index: name + description + EXACT SKILL.md path for subagent dispatch.',
        inputSchema: z.object({ projectPath: optionalProjectPath }),
      },
      safeMcpCall('prjct_skills', async (args: { projectPath?: string }) => {
        const path = resolveProjectPath(args.projectPath)
        const projectId = await resolveProjectId(path)
        const { refreshSkillIndex, renderSkillIndex } = await import('../../services/skill-index')
        await refreshSkillIndex(projectId, path)
        const body = renderSkillIndex(projectId)
        return {
          content: [
            { type: 'text', text: body ?? 'No skills found in project or global skill roots.' },
          ],
        }
      })
    )

    s.registerTool(
      'prjct_project_facts',
      {
        description:
          'Verified-only per-project facts: stack line + real test/lint/build commands (never guessed). Live — no write.',
        inputSchema: z.object({ projectPath: optionalProjectPath }),
      },
      safeMcpCall('prjct_project_facts', async (args: { projectPath?: string }) => {
        const path = resolveProjectPath(args.projectPath)
        const { formatProjectFactsMd } = await import('../../services/prjct-md')
        return { content: [{ type: 'text', text: await formatProjectFactsMd(path) }] }
      })
    )

    s.registerTool(
      'prjct_context_tiers',
      {
        description: 'Context cache tiers L0–L3 + live L0 budget. Never stuff L2 into L0.',
        inputSchema: z.object({ projectPath: optionalProjectPath }),
      },
      safeMcpCall('prjct_context_tiers', async () => {
        const { formatContextTiersMd } = await import('../../services/context-tiers')
        return { content: [{ type: 'text', text: formatContextTiersMd() }] }
      })
    )

    s.registerTool(
      'prjct_safe_artifacts',
      {
        description: 'Audit agent outputs: judgment, ships, handoffs, checkpoints, session stamp.',
        inputSchema: z.object({
          projectPath: optionalProjectPath,
          limit: z.number().int().min(1).max(20).optional().describe('Max per kind (default 5)'),
        }),
      },
      safeMcpCall(
        'prjct_safe_artifacts',
        async (args: { projectPath?: string; limit?: number }) => {
          const projectId = await resolveProjectId(args.projectPath)
          const { listSafeArtifacts, formatSafeArtifactsMd } = await import(
            '../../services/safe-artifacts'
          )
          const report = await listSafeArtifacts(projectId, { limit: args.limit })
          return { content: [{ type: 'text', text: formatSafeArtifactsMd(report) }] }
        }
      )
    )
  }
}
