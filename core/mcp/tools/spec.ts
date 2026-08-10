/**
 * MCP Spec tools — exposes the SDD primitive to the desktop Claude app
 * (and any other MCP client).
 *
 * Mirrors `prjct spec` CLI: create, list, get, update, set-status,
 * record-review, link-task, ship, audit. The `audit` tool returns the
 * dispatch prompt; the host model runs the three review subagents in
 * parallel via its own tool-use mechanism (Agent / Task tool, etc.) and
 * writes verdicts back via `prjct_spec_record_review`.
 *
 * Tool descriptions intentionally lead with WHEN the host should call
 * them (intent recognition) so a fresh Claude session in the desktop
 * app routes feature/spec talk to the right tool.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { renderAuditDispatch, selectReviewers } from '../../services/spec-audit-dispatch'
import { specService } from '../../services/spec-service'
import { indexStorage } from '../../storage/index-storage'
import { specStorage } from '../../storage/spec-storage'
import {
  SPEC_STATUSES,
  type SpecContent,
  SpecContentSchema,
  type SpecStatus,
} from '../../types/spec'
import { optionalProjectPath, resolveProjectId, resolveProjectPath } from '../resolve'
import { safeMcpCall } from './error-handler'

// MCP SDK TS2589 workaround: cast server to any to avoid deep type
// instantiation during tool registration.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type S = any

export function registerSpecTools(server: McpServer) {
  const s: S = server

  s.tool(
    'prjct_spec_create',
    'Draft a spec when the user frames a feature/fix/initiative WITH goals or stakes (e.g. "rate limiting on auth", "fix onboarding"). Fields default empty — fill them via `prjct_spec_update`. Skip for routine work (single-file fix, doc tweak, capture); use `prjct_mem_save` with type="inbox" or the CLI `prjct capture` instead.',
    {
      projectPath: optionalProjectPath,
      title: z.string().describe("One-line title (what you'd say to a coworker walking by)"),
      goal: z.string().describe('What success looks like, 1-3 sentences. Concrete, observable.'),
      eli10: z.string().optional().describe('Plain English a 16-year-old follows, 2-4 sentences'),
      stakes: z.string().optional().describe('What breaks if we ship the wrong thing'),
      acceptance_criteria: z
        .array(z.string())
        .optional()
        .describe('Testable, observable list. Each item ends in a verifiable claim.'),
      scope: z.array(z.string()).optional().describe("What's IN — file paths, modules, surfaces"),
      out_of_scope: z.array(z.string()).optional().describe("What's OUT — anti-creep shield"),
      risks: z
        .array(z.object({ risk: z.string(), mitigation: z.string() }))
        .optional()
        .describe('Each risk has a mitigation; a risk without one is just a complaint'),
      test_plan: z.array(z.string()).optional().describe('How you prove acceptance criteria'),
      tags: z
        .record(z.string(), z.string())
        .optional()
        .describe('Key:value tags (e.g. {domain: "auth", priority: "high"})'),
    },
    safeMcpCall(
      'prjct_spec_create',
      async (args: {
        projectPath: string
        title: string
        goal: string
        eli10?: string
        stakes?: string
        acceptance_criteria?: string[]
        scope?: string[]
        out_of_scope?: string[]
        risks?: { risk: string; mitigation: string }[]
        test_plan?: string[]
        tags?: Record<string, string>
      }) => {
        const spec = await specService.create(resolveProjectPath(args.projectPath), {
          title: args.title,
          content: {
            goal: args.goal,
            eli10: args.eli10,
            stakes: args.stakes,
            acceptance_criteria: args.acceptance_criteria,
            scope: args.scope,
            out_of_scope: args.out_of_scope,
            risks: args.risks,
            test_plan: args.test_plan,
          },
          tags: args.tags,
        })

        const summary = [
          `✓ spec drafted: ${spec.title}`,
          ``,
          `id: ${spec.id}`,
          `status: ${spec.status}`,
          `goal: ${spec.content.goal}`,
          ``,
          `Next: \`prjct_spec_audit\` to dispatch the three review subagents (strategic / architecture / design) in parallel.`,
        ].join('\n')
        return { content: [{ type: 'text', text: summary }] }
      }
    )
  )

  s.tool(
    'prjct_spec_list',
    'List specs in this project. Use to check what specs exist before drafting a new one (avoid duplicates) or to find the right spec to link a task to.',
    {
      projectPath: optionalProjectPath,
      status: z
        .enum(SPEC_STATUSES)
        .optional()
        .describe('Filter by status: draft|reviewed|in_progress|shipped|archived'),
      includeArchived: z.boolean().optional().describe('Include archived specs (default: false)'),
    },
    safeMcpCall(
      'prjct_spec_list',
      async (args: { projectPath: string; status?: SpecStatus; includeArchived?: boolean }) => {
        const projectId = await resolveProjectId(args.projectPath)
        const specs = specStorage.list(projectId, {
          status: args.status,
          includeArchived: args.includeArchived,
        })
        if (specs.length === 0) {
          return {
            content: [
              {
                type: 'text',
                text: '_No specs match. Start one with `prjct_spec_create`._',
              },
            ],
          }
        }
        const parts = ['# Specs', '']
        for (const sp of specs) {
          const ac = sp.content.acceptance_criteria.length
          const tasks = sp.content.linked_tasks.length
          parts.push(
            `## ${sp.title}\n- id: \`${sp.id}\`\n- status: ${sp.status}\n- acceptance criteria: ${ac}\n- linked tasks: ${tasks}\n- created: ${sp.createdAt}`
          )
          parts.push('')
        }
        return { content: [{ type: 'text', text: parts.join('\n') }] }
      }
    )
  )

  s.tool(
    'prjct_spec_get',
    'Fetch one spec by id, including all structured fields (goal, acceptance criteria, scope, risks, reviews, linked tasks).',
    {
      projectPath: optionalProjectPath,
      id: z.string().describe('Spec id'),
    },
    safeMcpCall('prjct_spec_get', async (args: { projectPath: string; id: string }) => {
      const spec = await specService.get(resolveProjectPath(args.projectPath), args.id)
      if (!spec) {
        return { content: [{ type: 'text', text: `_Spec not found: ${args.id}_` }] }
      }
      return {
        content: [{ type: 'text', text: renderSpecMarkdown(spec) }],
      }
    })
  )

  s.tool(
    'prjct_spec_update',
    "Replace a spec's structured content. Pass the FULL content object (this is a replace, not a merge) — when filling in acceptance_criteria for the first time, fetch with `prjct_spec_get` first and merge in your changes.",
    {
      projectPath: optionalProjectPath,
      id: z.string().describe('Spec id'),
      content: z
        .object({
          goal: z.string(),
          eli10: z.string().optional(),
          stakes: z.string().optional(),
          acceptance_criteria: z.array(z.string()).optional(),
          scope: z.array(z.string()).optional(),
          out_of_scope: z.array(z.string()).optional(),
          risks: z.array(z.object({ risk: z.string(), mitigation: z.string() })).optional(),
          test_plan: z.array(z.string()).optional(),
          notes: z.string().optional(),
          linked_tasks: z.array(z.string()).optional(),
        })
        .describe('Full SpecContent shape — Zod-validated server-side'),
    },
    safeMcpCall(
      'prjct_spec_update',
      async (args: {
        projectPath: string
        id: string
        content: Partial<SpecContent> & { goal: string }
      }) => {
        const validated = SpecContentSchema.parse(args.content)
        const updated = await specService.update(
          resolveProjectPath(args.projectPath),
          args.id,
          validated as SpecContent
        )
        if (!updated) {
          return { content: [{ type: 'text', text: `_Spec not found: ${args.id}_` }] }
        }
        return {
          content: [{ type: 'text', text: `✓ spec updated: ${updated.title}` }],
        }
      }
    )
  )

  s.tool(
    'prjct_spec_set_status',
    'Promote/demote a spec lifecycle state: `in_progress` when work starts, `archived` when superseded. (draft → reviewed auto-promotes when reviewers pass; for first ship use `prjct_spec_ship` so the PR is recorded.)',
    {
      projectPath: optionalProjectPath,
      id: z.string().describe('Spec id'),
      status: z.enum(SPEC_STATUSES).describe('Target status'),
    },
    safeMcpCall(
      'prjct_spec_set_status',
      async (args: { projectPath: string; id: string; status: SpecStatus }) => {
        const next = await specService.setStatus(
          resolveProjectPath(args.projectPath),
          args.id,
          args.status
        )
        if (!next) {
          return { content: [{ type: 'text', text: `_Spec not found: ${args.id}_` }] }
        }
        return {
          content: [{ type: 'text', text: `✓ spec ${args.id} → ${args.status}` }],
        }
      }
    )
  )

  s.tool(
    'prjct_spec_audit',
    'Call before implementing a spec. Returns a dispatch prompt for the review specialists the spec raises — a DYNAMIC set (architecture is the floor; security/data/performance/design/strategic + any project DOMAIN experts join when the spec signals them). Run them IN PARALLEL (one Agent block per reviewer, same message). Persist each verdict via `prjct_spec_record_review`; all pass → spec auto-promotes draft → reviewed.',
    {
      projectPath: optionalProjectPath,
      id: z.string().describe('Spec id to audit'),
    },
    safeMcpCall('prjct_spec_audit', async (args: { projectPath: string; id: string }) => {
      const spec = await specService.get(resolveProjectPath(args.projectPath), args.id)
      if (!spec) {
        return { content: [{ type: 'text', text: `_Spec not found: ${args.id}_` }] }
      }
      // Dynamic lenses + DOMAIN experts: deterministic baseline from the spec +
      // the project's discovered domains, persisted so the auto-promote gate
      // knows the expected set.
      const auditProjectId = await resolveProjectId(args.projectPath).catch(() => null)
      const domains = auditProjectId
        ? (indexStorage.readDomainsSync(auditProjectId)?.domains ?? [])
        : []
      const lenses = selectReviewers(spec.content, domains)
      await specService.setSelectedReviewers(resolveProjectPath(args.projectPath), args.id, lenses)
      return {
        content: [
          {
            type: 'text',
            text: await renderAuditDispatch(
              spec.id,
              spec.title,
              spec.content,
              lenses,
              undefined,
              domains
            ),
          },
        ],
      }
    })
  )

  s.tool(
    'prjct_spec_record_review',
    "Persist one reviewer's verdict from `prjct_spec_audit` dispatch. Call once per reviewer (strategic, architecture, design). When all three are recorded with verdict=pass, the spec auto-promotes draft → reviewed.",
    {
      projectPath: optionalProjectPath,
      id: z.string().describe('Spec id'),
      reviewer: z.string().min(1).describe('Which lens (e.g. architecture, security, data)'),
      verdict: z.enum(['pass', 'fail']).describe('Verdict'),
      notes: z.string().describe('2-4 sentence notes from the subagent'),
    },
    safeMcpCall(
      'prjct_spec_record_review',
      async (args: {
        projectPath: string
        id: string
        reviewer: string
        verdict: 'pass' | 'fail'
        notes: string
      }) => {
        const updated = await specService.recordReview(
          resolveProjectPath(args.projectPath),
          args.id,
          args.reviewer,
          {
            verdict: args.verdict,
            notes: args.notes,
          }
        )
        if (!updated) {
          return { content: [{ type: 'text', text: `_Spec not found: ${args.id}_` }] }
        }
        const promoted =
          updated.status === 'reviewed' ? ' (all reviewers passed → status: reviewed)' : ''
        return {
          content: [{ type: 'text', text: `✓ ${args.reviewer} → ${args.verdict}${promoted}` }],
        }
      }
    )
  )

  s.tool(
    'prjct_spec_link_task',
    'Link a task to its spec (call after starting the task) so `prjct_ship` knows which spec to gate against. Idempotent.',
    {
      projectPath: optionalProjectPath,
      specId: z.string().describe('Spec id'),
      taskId: z.string().describe('Task id (from `prjct_task_start` or stateStorage)'),
    },
    safeMcpCall(
      'prjct_spec_link_task',
      async (args: { projectPath: string; specId: string; taskId: string }) => {
        const updated = await specService.linkTask(
          resolveProjectPath(args.projectPath),
          args.specId,
          args.taskId
        )
        if (!updated) {
          return { content: [{ type: 'text', text: `_Spec not found: ${args.specId}_` }] }
        }
        return {
          content: [{ type: 'text', text: `✓ linked task ${args.taskId} to spec ${args.specId}` }],
        }
      }
    )
  )

  s.tool(
    'prjct_spec_ship',
    'Mark a spec as shipped (after the linked PR merges). Records the PR number on the spec for provenance.',
    {
      projectPath: optionalProjectPath,
      id: z.string().describe('Spec id'),
      pr: z.number().optional().describe('PR / MR number that delivered the spec'),
    },
    safeMcpCall(
      'prjct_spec_ship',
      async (args: { projectPath: string; id: string; pr?: number }) => {
        const next = await specService.ship(resolveProjectPath(args.projectPath), args.id, args.pr)
        if (!next) {
          return { content: [{ type: 'text', text: `_Spec not found: ${args.id}_` }] }
        }
        return {
          content: [
            {
              type: 'text',
              text: `✓ spec shipped: ${next.title}${args.pr ? ` (PR #${args.pr})` : ''}`,
            },
          ],
        }
      }
    )
  )
}

function renderSpecMarkdown(spec: {
  id: string
  title: string
  status: string
  content: SpecContent
  createdAt: string
  updatedAt: string
}): string {
  const c = spec.content
  const lines = [
    `# ${spec.title}`,
    '',
    `**id:** \`${spec.id}\` · **status:** ${spec.status} · **created:** ${spec.createdAt}`,
    '',
    '## Goal',
    c.goal,
  ]
  if (c.eli10) lines.push('', '## ELI10', c.eli10)
  if (c.stakes) lines.push('', '## Stakes', c.stakes)
  if (c.acceptance_criteria.length > 0) {
    lines.push('', '## Acceptance criteria')
    for (const ac of c.acceptance_criteria) lines.push(`- [ ] ${ac}`)
  }
  if (c.scope.length > 0) {
    lines.push('', '## Scope')
    for (const s of c.scope) lines.push(`- ${s}`)
  }
  if (c.out_of_scope.length > 0) {
    lines.push('', '## Out of scope')
    for (const s2 of c.out_of_scope) lines.push(`- ${s2}`)
  }
  if (c.risks.length > 0) {
    lines.push('', '## Risks')
    for (const r of c.risks) lines.push(`- **${r.risk}** — ${r.mitigation}`)
  }
  if (c.test_plan.length > 0) {
    lines.push('', '## Test plan')
    for (const t of c.test_plan) lines.push(`- ${t}`)
  }
  if (c.reviews && Object.keys(c.reviews).length > 0) {
    lines.push('', '## Reviews')
    for (const [reviewer, r] of Object.entries(c.reviews)) {
      lines.push(`- **${reviewer}:** ${r.verdict} — ${r.notes} _(${r.ts})_`)
    }
  }
  if (c.linked_tasks.length > 0) {
    lines.push('', '## Linked tasks', ...c.linked_tasks.map((t) => `- ${t}`))
  }
  if (c.notes) lines.push('', '## Notes', c.notes)
  return lines.join('\n')
}
