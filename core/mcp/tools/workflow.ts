/**
 * MCP Workflow Tools (3 tools)
 *
 * Wraps custom-workflow-storage and workflow-rule-storage.
 */
import type { McpServer } from '@modelcontextprotocol/server'
import { z } from 'zod'
import { customWorkflowStorage } from '../../storage/custom-workflow-storage'
import { workflowRuleStorage } from '../../storage/workflow-rule-storage'
import { optionalProjectPath, resolveProjectId, resolveProjectPath } from '../resolve'
import { safeMcpCall } from './error-handler'

// MCP SDK TS2589 workaround: cast server to avoid deep type instantiation
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type S = any

export function registerWorkflowTools(server: McpServer) {
  const s: S = server

  s.registerTool(
    'prjct_workflow_rules',
    {
      description:
        'The gates/hooks/steps registered for a command (task, ship, …). Check before running a lifecycle verb so a gate never surprises you mid-action.',
      inputSchema: z.object({
        projectPath: optionalProjectPath,
        command: z.string().describe('Command name (task, done, ship, sync, etc.)'),
      }),
    },
    safeMcpCall('prjct_workflow_rules', async (args: { projectPath: string; command: string }) => {
      const projectId = await resolveProjectId(args.projectPath)
      const rules = workflowRuleStorage.getRulesForCommand(projectId, args.command)

      if (rules.length === 0) {
        return {
          content: [{ type: 'text', text: `No workflow rules for \`${args.command}\`.` }],
        }
      }

      const grouped: Record<string, typeof rules> = {}
      for (const rule of rules) {
        const key = `${rule.type}:${rule.position}`
        if (!grouped[key]) grouped[key] = []
        grouped[key].push(rule)
      }

      const parts: string[] = [`## Workflow Rules for \`${args.command}\``]
      for (const [key, groupRules] of Object.entries(grouped)) {
        parts.push(`\n### ${key}`)
        for (const r2 of groupRules) {
          const status = r2.enabled ? '' : ' (disabled)'
          parts.push(`- ${r2.action}${r2.description ? ` — ${r2.description}` : ''}${status}`)
        }
      }

      return { content: [{ type: 'text', text: parts.join('\n') }] }
    })
  )

  s.registerTool(
    'prjct_workflow_list',
    {
      description:
        'Every workflow this project registered (built-in + custom). Use to discover what `prjct workflow run <name>` can execute here.',
      inputSchema: z.object({
        projectPath: optionalProjectPath,
      }),
    },
    safeMcpCall('prjct_workflow_list', async (args: { projectPath: string }) => {
      const projectId = await resolveProjectId(args.projectPath)
      const workflows = customWorkflowStorage.getAllWorkflows(projectId)

      if (workflows.length === 0) {
        return { content: [{ type: 'text', text: 'No workflows configured.' }] }
      }

      const lines = workflows.map((w) => {
        const badge = w.isBuiltin ? '(built-in)' : '(custom)'
        const status = w.enabled ? '' : ' [disabled]'
        return `- **${w.name}** ${badge}${status}${w.description ? `: ${w.description}` : ''}`
      })

      return {
        content: [
          { type: 'text', text: `## Workflows (${workflows.length})\n\n${lines.join('\n')}` },
        ],
      }
    })
  )

  s.registerTool(
    'prjct_workflow_status',
    {
      description:
        'Where the active work cycle sits in its workflow/gates (state + rules currently in force). Read when deciding whether done/ship is allowed next.',
      inputSchema: z.object({
        projectPath: optionalProjectPath,
      }),
    },
    safeMcpCall('prjct_workflow_status', async (args: { projectPath: string }) => {
      const projectId = await resolveProjectId(args.projectPath)
      // Workspace-aware: surface THIS worktree's task (main → currentTask,
      // child worktree → its activeTasks[] slot), not just the main slot.
      const { resolveActiveTask } = await import('../../services/task-service')
      const currentTask = await resolveActiveTask(projectId, resolveProjectPath(args.projectPath))
      const allRules = workflowRuleStorage.getAllRules(projectId)

      const parts: string[] = ['## Workflow Status']

      if (currentTask) {
        parts.push(`\nActive work cycle: **${currentTask.description}**`)
        parts.push(`Started: ${currentTask.startedAt}`)
      } else {
        parts.push('\nNo active work cycle.')
      }

      const enabledRules = allRules.filter((r) => r.enabled)
      if (enabledRules.length > 0) {
        parts.push(`\n### Active Rules (${enabledRules.length})`)
        for (const r of enabledRules) {
          parts.push(`- [${r.type}] ${r.command}:${r.position} → ${r.action}`)
        }
      } else {
        parts.push('\nNo active workflow rules.')
      }

      return { content: [{ type: 'text', text: parts.join('\n') }] }
    })
  )

  s.registerTool(
    'prjct_qa',
    {
      description:
        'QA phase of the active work cycle — status | plan (json: {criteria,flows}) | next card | brief for a blind QA subagent | report verdicts (json) | mark (author) | run probes | browser (prjct headless browser: "goto <url>", "fill <sel> <text>", "click <sel>", "text [sel]", "screenshot [name]", "close", "status"). No test framework needed.',
      inputSchema: z.object({
        projectPath: optionalProjectPath,
        action: z.enum(['status', 'plan', 'next', 'brief', 'report', 'mark', 'run', 'browser']),
        command: z
          .string()
          .optional()
          .describe('browser: the primitive and its arguments, e.g. "goto /login"'),
        json: z
          .string()
          .optional()
          .describe('plan: {criteria,flows} · report: [{id,verdict,evidence}]'),
        id: z.string().optional().describe('mark: ac-… or fl-…'),
        status: z.string().optional().describe('mark: met|unmet|passed|failed|skipped'),
        evidence: z.string().optional().describe('mark: what was observed'),
        flow: z.string().optional().describe('run: only this flow id'),
      }),
    },
    safeMcpCall(
      'prjct_qa',
      async (args: {
        projectPath: string
        action: 'status' | 'plan' | 'next' | 'brief' | 'report' | 'mark' | 'run' | 'browser'
        command?: string
        json?: string
        id?: string
        status?: string
        evidence?: string
        flow?: string
      }) => {
        const text = await runQaAction(args)
        return { content: [{ type: 'text', text }] }
      }
    )
  )
}

/** Same services as `prjct qa`; formats text here because MCP owns stdout. */
async function runQaAction(args: {
  projectPath: string
  action: 'status' | 'plan' | 'next' | 'brief' | 'report' | 'mark' | 'run' | 'browser'
  command?: string
  json?: string
  id?: string
  status?: string
  evidence?: string
  flow?: string
}): Promise<string> {
  const projectId = await resolveProjectId(args.projectPath)
  const projectPath = resolveProjectPath(args.projectPath)
  const [{ default: configManager }, gate, planSvc, runner, { resolveActiveTask }] =
    await Promise.all([
      import('../../infrastructure/config-manager'),
      import('../../services/qa-gate'),
      import('../../services/qa-plan'),
      import('../../services/qa-runner'),
      import('../../services/task-service'),
    ])
  const config = await configManager.readConfig(projectPath).catch(() => null)
  const mode = gate.effectiveQaMode(config)
  const task = await resolveActiveTask(projectId, projectPath).catch(() => null)
  if (!task) return 'No active work cycle — start one with prjct_task_start.'
  const plan = planSvc.getQaPlan(projectId, task.id)
  const receipt = runner.readQaReceipt(projectId, task.id)?.data ?? null
  const decode = (): unknown => {
    try {
      return args.json ? (JSON.parse(args.json) as unknown) : undefined
    } catch {
      return undefined
    }
  }
  switch (args.action) {
    case 'status': {
      const head = `QA mode: ${mode} · cycle ${task.id.slice(0, 8)}`
      if (!plan)
        return `${head}\nNo QA plan yet — action=plan with json ${planSvc.QA_PLAN_JSON_HINT}`
      return [head, ...planSvc.renderQaChecklistMd(plan)].join('\n')
    }
    case 'plan': {
      const { QaPlanInputSchema } = await import('../../schemas/qa')
      const parsed = QaPlanInputSchema.safeParse(decode())
      if (!parsed.success) return `json does not match the plan shape: ${planSvc.QA_PLAN_JSON_HINT}`
      const result = planSvc.upsertQaPlan(projectId, task.id, parsed.data, { mode })
      if (!result.plan) return `QA plan refused (strict): ${result.rejected}`
      return [
        `QA plan saved (${result.plan.criteria.length} criteria · ${result.plan.flows.length} flows).`,
        ...(result.report.ok ? [] : [`⚠ ${result.report.message}`]),
        ...planSvc.renderQaChecklistMd(result.plan),
      ].join('\n')
    }
    case 'next': {
      const card = gate.qaNextAction({
        mode,
        harnessLevel: task.harness?.level,
        plan,
        receipt,
        headSha: null,
        nowMs: Date.now(),
      })
      return [
        `QA next: ${card.kind}`,
        card.directive,
        ...card.steps.map((s, i) => `${i + 1}. ${s}`),
      ].join('\n')
    }
    case 'brief': {
      if (!plan) return 'No QA plan for this cycle — action=plan first.'
      const { buildQaBrief } = await import('../../services/qa-brief')
      return buildQaBrief({ plan, receipt, config })
    }
    case 'report': {
      const { QaReportSchema } = await import('../../schemas/qa')
      const parsed = QaReportSchema.safeParse(decode())
      if (!parsed.success) return 'json must be [{id, verdict, evidence (≥40 chars)}]'
      const result = planSvc.applyQaReport(projectId, task.id, parsed.data)
      if (!result.plan) return 'No QA plan for this cycle — nothing to report against.'
      return `QA report applied: ${result.applied.length} verdict(s)${result.unknown.length ? ` · unknown ids: ${result.unknown.join(', ')}` : ''}`
    }
    case 'mark': {
      if (!args.id || !args.status) return 'mark needs id (ac-…|fl-…) and status.'
      const status = args.status.toLowerCase()
      const updated = args.id.startsWith('ac-')
        ? planSvc.markCriterion(projectId, task.id, args.id, {
            status: status as 'pending' | 'met' | 'unmet',
            evidence: args.evidence,
            verifiedBy: 'author',
          })
        : planSvc.markFlow(projectId, task.id, args.id, {
            status: status as 'pending' | 'passed' | 'failed' | 'skipped',
            evidence: args.evidence,
            verifiedBy: 'author',
          })
      return updated
        ? `${args.id} → ${status} (author-marked; strict needs a probe or the QA subagent).`
        : `No ${args.id} in this cycle's plan.`
    }
    case 'run': {
      const result = await runner.runQa(projectPath, projectId, { plan, flowId: args.flow })
      return runner.renderQaReceiptMd(result)
    }
    case 'browser': {
      const browser = await import('../../services/qa-browser')
      const tokens = (args.command ?? 'status').trim().split(/\s+/).filter(Boolean)
      if (tokens[0] === 'status' || tokens[0] === 'install') {
        // Install is a minutes-long download — the CLI owns it (progress lines).
        return tokens[0] === 'install'
          ? 'Run `prjct qa browser install` in a terminal (one-time, a few hundred MB under the prjct cache).'
          : browser.renderBrowserStatus(browser.browserStatus())
      }
      const result = await browser.runBrowserPrimitive(
        projectId,
        tokens,
        config?.qa?.app?.baseUrl ?? null
      )
      return result.text
    }
  }
}
