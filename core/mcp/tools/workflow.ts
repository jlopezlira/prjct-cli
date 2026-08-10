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
}
