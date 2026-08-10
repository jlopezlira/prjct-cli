/**
 * Custom workflow CRUD + ship-defaults bootstrap. Handlers that operate
 * on the workflows themselves rather than individual rules.
 */

import { templateGenerator } from '../../../infrastructure/template-generator'
import { customWorkflowStorage } from '../../../storage/custom-workflow-storage'
import { workflowRuleStorage } from '../../../storage/workflow-rule-storage'
import type { MdOption } from '../../../types/cli'
import type { CommandResult } from '../../../types/commands'
import { getErrorMessage } from '../../../types/fs'
import { failWith, notifyDone, notifyFail } from '../../../utils/md-aware'
import { mdDone, mdList, mdNextSteps, mdOutput, mdSection } from '../../../utils/md-formatter'
import { detectProjectCommands } from '../../../utils/project-commands'
import { WORKFLOW_TIMEOUTS } from '../../../workflow-engine/timeouts'

export async function workflowInit(
  projectId: string,
  projectPath: string,
  options: MdOption
): Promise<CommandResult> {
  const existingRules = workflowRuleStorage
    .getRulesForCommand(projectId, 'ship')
    .filter((r) => r.position === 'before')

  if (existingRules.length > 0) {
    return failWith(
      `Ship workflow already has ${existingRules.length} rule${existingRules.length !== 1 ? 's' : ''}. Use 'prjct workflow reset' first if you want to reinitialize.`,
      options
    )
  }

  const detected = await detectProjectCommands(projectPath)
  const rulesAdded: string[] = []
  const ts = () => new Date().toISOString()

  const gateId = workflowRuleStorage.addRule(projectId, {
    type: 'gate',
    command: 'ship',
    position: 'before',
    action: 'git branch --show-current | grep -vE "^(main|master)$"',
    description: 'Prevent shipping from main branch',
    enabled: true,
    timeoutMs: WORKFLOW_TIMEOUTS.GATE_QUICK_MS,
    sortOrder: 0,
    createdAt: ts(),
  })
  rulesAdded.push(`#${gateId} [gate] prevent main branch`)

  if (detected.lint) {
    const lintId = workflowRuleStorage.addRule(projectId, {
      type: 'step',
      command: 'ship',
      position: 'before',
      action: `${detected.lint.command} || true`,
      description: 'Lint code',
      enabled: true,
      timeoutMs: WORKFLOW_TIMEOUTS.STEP_LINT_MS,
      sortOrder: 1,
      createdAt: ts(),
    })
    rulesAdded.push(`#${lintId} [step] lint → ${detected.lint.command}`)
  }

  if (detected.test) {
    const testId = workflowRuleStorage.addRule(projectId, {
      type: 'step',
      command: 'ship',
      position: 'before',
      action: `${detected.test.command} || true`,
      description: 'Run tests',
      enabled: true,
      timeoutMs: WORKFLOW_TIMEOUTS.STEP_TEST_MS,
      sortOrder: detected.lint ? 2 : 1,
      createdAt: ts(),
    })
    rulesAdded.push(`#${testId} [step] test → ${detected.test.command}`)
  }

  if (options.md) {
    console.log(
      mdOutput(
        mdDone('Workflow Initialized', `Added ${rulesAdded.length} default ship rules`),
        mdList(rulesAdded),
        mdNextSteps([
          { label: 'View all rules', command: 'prjct workflow --md' },
          { label: 'Ship your work', command: 'prjct ship --md' },
        ])
      )
    )
  } else {
    notifyDone(`initialized ${rulesAdded.length} workflow rules for ship`)
    for (const rule of rulesAdded) {
      console.log(`  ${rule}`)
    }
  }

  return { success: true, rulesAdded: rulesAdded.length }
}

export async function workflowCreate(
  input: string,
  projectId: string,
  _projectPath: string,
  options: MdOption
): Promise<CommandResult> {
  const match = input.match(/^(\S+)\s+"([^"]+)"/)
  if (!match) {
    return failWith('Usage: prjct workflow create <name> "description"', options)
  }

  const [, name, description] = match

  if (!customWorkflowStorage.isValidName(name)) {
    return failWith(
      'Workflow name must be lowercase alphanumeric + hyphens (e.g., "qa", "deploy-prod")',
      options
    )
  }

  if (customWorkflowStorage.isReservedName(name)) {
    return failWith(`Workflow name '${name}' is reserved`, options)
  }

  if (customWorkflowStorage.getWorkflow(projectId, name)) {
    return failWith(`Workflow '${name}' already exists`, options)
  }

  try {
    const workflowId = customWorkflowStorage.createWorkflow(projectId, { name, description })

    const templateResult = await templateGenerator.generateWorkflowTemplate(name, description)
    if (!templateResult.success) {
      // Rollback workflow creation if template generation fails.
      customWorkflowStorage.deleteWorkflow(projectId, name)
      return failWith(`Failed to generate template: ${templateResult.error}`, options)
    }

    if (options.md) {
      console.log(
        mdOutput(
          mdDone('Workflow Created', `Created workflow: ${name}`),
          mdSection('Description', description),
          mdSection('Template', `Installed at ${templateResult.path}`),
          mdNextSteps([
            { label: 'Add rules', command: `prjct workflow add "action" before ${name} --md` },
            { label: 'View workflow', command: `prjct workflow ${name} --md` },
            { label: 'Run workflow', command: `p. ${name}` },
          ])
        )
      )
    } else {
      notifyDone(`created workflow: ${name}`)
      console.log(`  ${description}`)
      console.log(`  Template: ${templateResult.path}`)
      console.log(`\nRun with: p. ${name}`)
    }

    return { success: true, workflowId, name, templatePath: templateResult.path }
  } catch (error) {
    return failWith(getErrorMessage(error), options)
  }
}

export async function workflowList(projectId: string, options: MdOption): Promise<CommandResult> {
  const workflows = customWorkflowStorage.getAllWorkflows(projectId)

  if (workflows.length === 0) {
    if (options.md) console.log('> No workflows found')
    else notifyFail('No workflows found')
    return { success: true, workflows: [] }
  }

  const builtin = workflows.filter((w) => w.isBuiltin)
  const custom = workflows.filter((w) => !w.isBuiltin)
  const renderRow = (w: { name: string; description: string | null }) =>
    `- **${w.name}** — ${w.description ?? ''}`

  if (options.md) {
    const sections: string[] = []
    if (builtin.length > 0) {
      sections.push(mdSection('Built-in Workflows', builtin.map(renderRow).join('\n')))
    }
    if (custom.length > 0) {
      sections.push(mdSection('Custom Workflows', custom.map(renderRow).join('\n')))
    }
    console.log(
      mdOutput(
        ...sections,
        mdNextSteps([
          {
            label: 'Create workflow',
            command: 'prjct workflow create <name> "description" --md',
          },
          { label: 'View workflow', command: 'prjct workflow <name> --md' },
        ])
      )
    )
  } else {
    notifyDone(`${workflows.length} workflow${workflows.length !== 1 ? 's' : ''}`)
    if (builtin.length > 0) {
      console.log('\nBuilt-in:')
      for (const w of builtin) console.log(`  ${w.name} — ${w.description}`)
    }
    if (custom.length > 0) {
      console.log('\nCustom:')
      for (const w2 of custom) console.log(`  ${w2.name} — ${w2.description}`)
    }
  }

  return { success: true, workflows }
}

export async function workflowDelete(
  input: string,
  projectId: string,
  options: MdOption
): Promise<CommandResult> {
  const name = input.trim()
  if (!name) return failWith('Usage: prjct workflow delete <name>', options)

  try {
    const deleted = customWorkflowStorage.deleteWorkflow(projectId, name)
    if (!deleted) return failWith(`Workflow '${name}' not found`, options)

    await templateGenerator.deleteWorkflowTemplate(name)

    if (options.md) {
      console.log(mdOutput(mdDone('Workflow Deleted', `Deleted workflow: ${name}`)))
    } else {
      notifyDone(`deleted workflow: ${name}`)
    }
    return { success: true }
  } catch (error) {
    return failWith(getErrorMessage(error), options)
  }
}
