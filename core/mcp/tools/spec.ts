/**
 * MCP Spec tools — exposes the SDD primitive to the desktop Claude app
 * (and any other MCP client).
 *
 * Mirrors `prjct spec` CLI: create, list, get, update, set-status,
 * record-review, link-task, ship, audit. The `audit` tool returns the
 * dispatch prompt; the host model runs at most two reviewer agents in
 * parallel via its own tool-use mechanism (Agent / Task tool, etc.) and
 * writes verdicts back via `prjct_spec_record_review`.
 *
 * Tool descriptions intentionally lead with WHEN the host should call
 * them (intent recognition) so a fresh Claude session in the desktop
 * app routes feature/spec talk to the right tool.
 */
import type { McpServer } from '@modelcontextprotocol/server'
import { z } from 'zod'
import { renderAuditDispatch, selectReviewers } from '../../services/spec-audit-dispatch'
import { renderSpecMarkdown, type SpecTaskState } from '../../services/spec-markdown'
import { specService } from '../../services/spec-service'
import { formatValidationLines, validateSpec } from '../../services/spec-validate'
import { indexStorage } from '../../storage/index-storage'
import { queueStorage } from '../../storage/queue-storage'
import { specStorage } from '../../storage/spec-storage'
import { SPEC_STATUSES, type SpecContent, type SpecStatus } from '../../types/spec'
import { optionalProjectPath, resolveProjectId, resolveProjectPath } from '../resolve'
import { safeMcpCall } from './error-handler'
import { gatedTextResult } from './gated-result'

// MCP SDK TS2589 workaround: cast server to any to avoid deep type
// instantiation during tool registration.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type S = any

/**
 * Full delta-format how-to, returned in `prjct_spec_apply_delta` error text
 * (DELTA_* failures) instead of the ListTools description — the schema tax
 * is paid every session, the error text only when the agent actually needs
 * the format. Mirrors the `## ADDED/MODIFIED/REMOVED Requirements` subset
 * parsed by services/spec-delta.ts.
 */
const DELTA_FORMAT_HELP = `Delta format (OpenSpec subset):
## ADDED Requirements    / ## MODIFIED Requirements / ## REMOVED Requirements
### Requirement: <name> followed by its SHALL statement
#### Scenario: <name> (optional) with - **GIVEN** … / - **WHEN** … / - **THEN** … bullets
Requirement names map to stable slugs; MODIFIED/REMOVED target an existing slug; REMOVED holds only the "### Requirement:" heading. Re-applying the same delta is a no-op. CLI usage: \`prjct spec apply-delta <id> (--file <path> | --md '<delta markdown>')\`.`

export function registerSpecTools(server: McpServer) {
  const s: S = server

  s.registerTool(
    'prjct_spec_create',
    {
      description:
        'Draft a spec when the user frames a feature/fix/initiative WITH goals or stakes. Skip for routine work (single-file fix, doc tweak, capture) — use `prjct_mem_save` with type="inbox" or the CLI `prjct capture` instead. Fields default empty; fill them via `prjct_spec_update`.',
      inputSchema: z.object({
        projectPath: optionalProjectPath,
        title: z.string().describe('One-line title'),
        goal: z.string().describe('What success looks like — concrete, observable'),
        eli10: z.string().optional().describe('Lay explanation, 2-4 sentences'),
        stakes: z.string().optional().describe('What breaks if we ship the wrong thing'),
        acceptance_criteria: z.array(z.string()).optional().describe('Testable, verifiable items'),
        scope: z.array(z.string()).optional().describe("What's IN — file paths, modules, surfaces"),
        out_of_scope: z.array(z.string()).optional().describe("What's OUT — anti-creep shield"),
        risks: z
          .array(z.object({ risk: z.string(), mitigation: z.string() }))
          .optional()
          .describe('Each risk needs a mitigation'),
        test_plan: z.array(z.string()).optional().describe('How you prove acceptance criteria'),
        tags: z
          .record(z.string(), z.string())
          .optional()
          .describe('k:v tags, e.g. {domain: "auth"}'),
      }),
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
          `Next: \`prjct_spec_audit\` to cover every selected review lens with at most two reviewer agents in parallel.`,
        ].join('\n')
        return { content: [{ type: 'text', text: summary }] }
      }
    )
  )

  s.registerTool(
    'prjct_spec_list',
    {
      description:
        'List specs in this project. Use to check what specs exist before drafting a new one (avoid duplicates) or to find the right spec to link a task to.',
      inputSchema: z.object({
        projectPath: optionalProjectPath,
        status: z
          .enum(SPEC_STATUSES)
          .optional()
          .describe('Filter by status: draft|reviewed|in_progress|shipped|archived'),
        includeArchived: z.boolean().optional().describe('Include archived specs (default: false)'),
        full: z.boolean().optional(),
      }),
    },
    safeMcpCall(
      'prjct_spec_list',
      async (args: {
        projectPath: string
        status?: SpecStatus
        includeArchived?: boolean
        full?: boolean
      }) => {
        const projectId = await resolveProjectId(args.projectPath)
        const allSpecs = specStorage.list(projectId, {
          status: args.status,
          includeArchived: args.includeArchived,
        })
        // Newest 20 by default; full:true unbounds. The list scales with
        // project age and re-paid every spec header on every call.
        const specs = args.full ? allSpecs : allSpecs.slice(0, 20)
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
        if (allSpecs.length > specs.length) {
          parts.push(`_…+${allSpecs.length - specs.length} older specs (full:true)_`, '')
        }
        return gatedTextResult(projectId, 'spec-list', parts.join('\n'), args.full)
      }
    )
  )

  s.registerTool(
    'prjct_spec_get',
    {
      description:
        'Fetch one spec by id, including all structured fields (goal, acceptance criteria, scope, risks, reviews, linked tasks).',
      inputSchema: z.object({
        projectPath: optionalProjectPath,
        id: z.string().describe('Spec id'),
        full: z.boolean().optional(),
      }),
    },
    safeMcpCall(
      'prjct_spec_get',
      async (args: { projectPath: string; id: string; full?: boolean }) => {
        const spec = await specService.get(resolveProjectPath(args.projectPath), args.id)
        if (!spec) {
          return { content: [{ type: 'text', text: `_Spec not found: ${args.id}_` }] }
        }
        // Queue state for the `## Tasks` checklist, same lookup the CLI
        // `spec show --md` runs — keeps both surfaces byte-identical.
        const projectId = await resolveProjectId(args.projectPath).catch(() => null)
        const taskStates = new Map<string, SpecTaskState>()
        if (projectId) {
          for (const t of await queueStorage.getTasks(projectId)) {
            if (t.featureId === spec.id && t.body != null) {
              taskStates.set(t.body, { id: t.id, completed: t.completed })
            }
          }
        }
        const rendered = renderSpecMarkdown(spec, taskStates)
        return projectId
          ? gatedTextResult(projectId, `spec:${spec.id}`, rendered, args.full)
          : { content: [{ type: 'text' as const, text: rendered }] }
      }
    )
  )

  s.registerTool(
    'prjct_spec_update',
    {
      description:
        "Patch a spec's structured content — shallow merge: pass only the fields to change, omitted fields are preserved. For requirement / acceptance-criteria changes prefer `prjct_spec_apply_delta` (canonical, idempotent). Editing any body field demotes a reviewed spec back to draft.",
      inputSchema: z.object({
        projectPath: optionalProjectPath,
        id: z.string().describe('Spec id'),
        content: z.object({
          goal: z.string().optional(),
          eli10: z.string().optional(),
          stakes: z.string().optional(),
          acceptance_criteria: z.array(z.string()).optional(),
          scope: z.array(z.string()).optional(),
          out_of_scope: z.array(z.string()).optional(),
          risks: z.array(z.object({ risk: z.string(), mitigation: z.string() })).optional(),
          test_plan: z.array(z.string()).optional(),
          notes: z.string().optional(),
          linked_tasks: z.array(z.string()).optional(),
        }),
      }),
    },
    safeMcpCall(
      'prjct_spec_update',
      async (args: { projectPath: string; id: string; content: Partial<SpecContent> }) => {
        const updated = await specService.patch(
          resolveProjectPath(args.projectPath),
          args.id,
          args.content
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

  s.registerTool(
    'prjct_spec_apply_delta',
    {
      description:
        "CANONICAL path for changing a spec's requirements / acceptance criteria — pass an OpenSpec-style delta markdown (`## ADDED/MODIFIED/REMOVED Requirements` sections). Idempotent by content-hash id; MODIFIED/REMOVED target existing requirement slugs; demotes a reviewed spec back to draft. Malformed deltas return the full format in the error text.",
      inputSchema: z.object({
        projectPath: optionalProjectPath,
        id: z.string().describe('Spec id'),
        delta: z.string().describe('OpenSpec-subset delta markdown'),
      }),
    },
    safeMcpCall(
      'prjct_spec_apply_delta',
      async (args: { projectPath: string; id: string; delta: string }) => {
        try {
          const updated = await specService.applyDelta(
            resolveProjectPath(args.projectPath),
            args.id,
            args.delta
          )
          if (!updated) {
            return { content: [{ type: 'text', text: `_Spec not found: ${args.id}_` }] }
          }
          return {
            content: [
              {
                type: 'text',
                text: `✓ delta applied: ${updated.title} (${updated.content.delta_log.length} delta(s) logged)`,
              },
            ],
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          // Parse/targeting failures get the full delta format inline — it
          // lives here, not in the ListTools description (schema tax).
          if (message.startsWith('DELTA_')) {
            return {
              content: [{ type: 'text', text: `Error: ${message}\n\n${DELTA_FORMAT_HELP}` }],
              isError: true,
            }
          }
          throw error
        }
      }
    )
  )

  s.registerTool(
    'prjct_spec_validate',
    {
      description:
        "Validate a spec's stored structure BEFORE `prjct_spec_audit` / implementation. Errors (missing SHALL statement or GIVEN/WHEN/THEN scenarios; REMOVED targeting a nonexistent requirement) block audit dispatch under SDD strict mode; warnings are advisory. Pure read.",
      inputSchema: z.object({
        projectPath: optionalProjectPath,
        id: z.string().describe('Spec id'),
      }),
    },
    safeMcpCall('prjct_spec_validate', async (args: { projectPath: string; id: string }) => {
      const projectPath = resolveProjectPath(args.projectPath)
      const spec = await specService.get(projectPath, args.id)
      if (!spec) {
        return { content: [{ type: 'text', text: `_Spec not found: ${args.id}_` }] }
      }
      const v = validateSpec(spec, { projectPath })
      const lines = [
        `# spec validate — ${spec.title}`,
        '',
        ...(v.errors.length === 0 && v.warnings.length === 0
          ? ['_No findings — structure OK._']
          : formatValidationLines(v)),
        '',
        `verdict: ${v.errors.length === 0 ? 'PASS' : 'FAIL'} (${v.errors.length} error(s), ${v.warnings.length} warning(s))`,
      ]
      return { content: [{ type: 'text', text: lines.join('\n') }] }
    })
  )

  s.registerTool(
    'prjct_spec_set_status',
    {
      description:
        'Promote/demote a spec lifecycle state: `in_progress` when work starts, `archived` when superseded. (draft → reviewed auto-promotes when reviewers pass; for first ship use `prjct_spec_ship` so the PR is recorded.)',
      inputSchema: z.object({
        projectPath: optionalProjectPath,
        id: z.string().describe('Spec id'),
        status: z.enum(SPEC_STATUSES).describe('Target status'),
      }),
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

  s.registerTool(
    'prjct_spec_audit',
    {
      description:
        'Call before implementing a spec. Returns a dispatch prompt for a DYNAMIC set of review lenses bundled into at most two reviewer agents (architecture is the floor; security/data/performance/design/strategic + DOMAIN experts join as signaled). Run the agents IN PARALLEL; persist each lens verdict via `prjct_spec_record_review` — all pass → auto-promotes draft → reviewed.',
      inputSchema: z.object({
        projectPath: optionalProjectPath,
        id: z.string().describe('Spec id to audit'),
      }),
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

  s.registerTool(
    'prjct_spec_record_review',
    {
      description:
        'Persist one lens verdict from `prjct_spec_audit` dispatch. Call once per selected lens, even when one agent covers multiple lenses. When every selected lens is recorded with verdict=pass, the spec auto-promotes draft → reviewed.',
      inputSchema: z.object({
        projectPath: optionalProjectPath,
        id: z.string().describe('Spec id'),
        reviewer: z.string().min(1).describe('Which lens (e.g. architecture, security, data)'),
        verdict: z.enum(['pass', 'fail']).describe('Verdict'),
        notes: z.string().describe('2-4 sentence notes from the subagent'),
      }),
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

  s.registerTool(
    'prjct_spec_link_task',
    {
      description:
        'Link a task to its spec (call after starting the task) so `prjct_ship` knows which spec to gate against. Idempotent.',
      inputSchema: z.object({
        projectPath: optionalProjectPath,
        specId: z.string().describe('Spec id'),
        taskId: z.string().describe('Task id (from `prjct_task_start` or stateStorage)'),
      }),
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

  s.registerTool(
    'prjct_spec_ship',
    {
      description:
        'Mark a spec as shipped (after the linked PR merges). Records the PR number on the spec for provenance.',
      inputSchema: z.object({
        projectPath: optionalProjectPath,
        id: z.string().describe('Spec id'),
        pr: z.number().optional().describe('PR / MR number that delivered the spec'),
      }),
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
