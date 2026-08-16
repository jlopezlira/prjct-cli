/**
 * Add / gate / instruction / rm / reset / disable handlers — anything
 * that mutates the rule list for an existing workflow command.
 */

import { workflowRuleStorage } from '../../../storage/workflow-rule-storage'
import type { MdOption } from '../../../types/cli'
import type { CommandResult } from '../../../types/commands'
import type { WorkflowRule } from '../../../types/storage/extended'
import { failWith, notifyDone, notifyFail } from '../../../utils/md-aware'
import { mdDone, mdList, mdNextSteps, mdOutput, mdSection } from '../../../utils/md-formatter'
import { WORKFLOW_TIMEOUTS } from '../../../workflow-engine/timeouts'
import { requireWorkflow } from '../../guards'
import { parseAction, searchRules } from '../intent'
import { MAX_LISTED_MATCHES, newRuleDefaults, RULE_POSITIONS, type RulePosition } from './_shared'

/**
 * Everything in `input` after the matched workflow command name — the
 * remaining "before|after ..." / instruction text a rule action still has
 * to parse. `name` may not start at index 0 (e.g. leading whitespace), so
 * this locates it rather than assuming a fixed offset.
 */
function restAfterWorkflowName(input: string, name: string): string {
  return input.slice(input.indexOf(name) + name.length).trim()
}

export async function workflowAdd(
  input: string,
  projectId: string,
  options: MdOption
): Promise<CommandResult> {
  const [action, rest] = parseAction(input)
  if (!action || !rest) {
    return failWith(
      'Usage: prjct workflow add "command" before|after <task|done|ship|sync>',
      options
    )
  }

  const parts = rest.split(/\s+/)
  const position = parts[0]?.toLowerCase() as RulePosition | undefined
  const command = parts[1]?.toLowerCase()

  if (!position || !RULE_POSITIONS.includes(position)) {
    return failWith('Position must be "before" or "after"', options)
  }

  const guard = requireWorkflow(projectId, command, options)
  if (!guard.ok) return guard.result

  const ruleId = workflowRuleStorage.addRule(projectId, {
    type: 'hook',
    command: guard.value.name,
    position,
    action,
    timeoutMs: WORKFLOW_TIMEOUTS.HOOK_DEFAULT_MS,
    ...newRuleDefaults(),
  })

  if (options.md) {
    console.log(
      mdOutput(
        mdDone('Rule Added', `#${ruleId} [hook] ${position} ${guard.value.name} → \`${action}\``),
        mdNextSteps([
          { label: 'View all rules', command: 'prjct workflow --md' },
          { label: 'Remove this rule', command: `prjct workflow rm ${ruleId} --md` },
        ])
      )
    )
  } else {
    notifyDone(`rule #${ruleId} added: [hook] ${position} ${guard.value.name} → ${action}`)
  }

  return { success: true, ruleId }
}

export async function workflowGate(
  input: string,
  projectId: string,
  options: MdOption
): Promise<CommandResult> {
  const command = input.trim().split(/\s+/)[0]?.toLowerCase()
  const guard = requireWorkflow(projectId, command, options)
  if (!guard.ok) return guard.result

  const actionInput = restAfterWorkflowName(input, guard.value.name)
  const [action] = parseAction(actionInput)

  if (!action) {
    return failWith('Usage: prjct workflow gate <command> "shell command"', options)
  }

  const ruleId = workflowRuleStorage.addRule(projectId, {
    type: 'gate',
    command: guard.value.name,
    position: 'before',
    action,
    timeoutMs: WORKFLOW_TIMEOUTS.GATE_DEFAULT_MS,
    ...newRuleDefaults(),
  })

  if (options.md) {
    console.log(
      mdOutput(
        mdDone('Gate Added', `#${ruleId} [gate] before ${guard.value.name} → \`${action}\``),
        mdNextSteps([
          { label: 'View all rules', command: 'prjct workflow --md' },
          { label: 'Remove this gate', command: `prjct workflow rm ${ruleId} --md` },
        ])
      )
    )
  } else {
    notifyDone(`gate #${ruleId} added: before ${guard.value.name} → ${action}`)
  }

  return { success: true, ruleId }
}

export async function workflowInstruction(
  input: string,
  projectId: string,
  options: MdOption
): Promise<CommandResult> {
  const command = input.trim().split(/\s+/)[0]?.toLowerCase()
  const guard = requireWorkflow(projectId, command, options)
  if (!guard.ok) return guard.result

  const afterCommand = restAfterWorkflowName(input, guard.value.name)
  const positionMatch = afterCommand.match(/^(before|after)\s+/i)
  if (!positionMatch) {
    return failWith(
      'Usage: prjct workflow instruction <command> before|after "instruction text"',
      options
    )
  }

  const position = positionMatch[1].toLowerCase() as RulePosition
  const actionInput = afterCommand.slice(positionMatch[0].length).trim()
  const [action] = parseAction(actionInput)

  if (!action) {
    return failWith(
      'Usage: prjct workflow instruction <command> before|after "instruction text"',
      options
    )
  }

  const ruleId = workflowRuleStorage.addRule(projectId, {
    type: 'instruction',
    command: guard.value.name,
    position,
    action,
    timeoutMs: WORKFLOW_TIMEOUTS.INSTRUCTION_MS,
    ...newRuleDefaults(),
  })

  if (options.md) {
    console.log(
      mdOutput(
        mdDone(
          'Instruction Added',
          `#${ruleId} [instruction] ${position} ${guard.value.name} → \`${action}\``
        ),
        mdNextSteps([
          { label: 'View all rules', command: 'prjct workflow --md' },
          { label: 'Remove this rule', command: `prjct workflow rm ${ruleId} --md` },
        ])
      )
    )
  } else {
    notifyDone(`instruction #${ruleId} added: ${position} ${guard.value.name} → ${action}`)
  }

  return { success: true, ruleId }
}

export async function workflowRm(
  input: string,
  projectId: string,
  options: MdOption
): Promise<CommandResult> {
  const ruleId = parseInt(input.trim(), 10)
  if (Number.isNaN(ruleId)) {
    return failWith('Usage: prjct workflow rm <rule-id>', options)
  }

  const removed = workflowRuleStorage.removeRule(projectId, ruleId)
  if (!removed) return failWith(`Rule #${ruleId} not found`, options)

  if (options.md) {
    console.log(mdOutput(mdDone('Rule Removed', `Removed rule #${ruleId}`)))
  } else {
    notifyDone(`removed rule #${ruleId}`)
  }

  return { success: true }
}

export async function workflowReset(projectId: string, options: MdOption): Promise<CommandResult> {
  const count = workflowRuleStorage.resetRules(projectId)
  const summary = `Removed ${count} rule${count !== 1 ? 's' : ''}`
  if (options.md) {
    console.log(mdOutput(mdDone('Rules Reset', summary)))
  } else {
    notifyDone(`reset: ${summary.toLowerCase()}`)
  }
  return { success: true, count }
}

export async function workflowDisable(
  input: string,
  projectId: string,
  options: MdOption
): Promise<CommandResult> {
  const trimmed = input.trim()
  const ruleId = parseInt(trimmed, 10)

  if (!Number.isNaN(ruleId)) {
    const rule = workflowRuleStorage.getRuleById(projectId, ruleId)
    if (!rule) return failWith(`Rule #${ruleId} not found`, options)

    if (!rule.enabled) {
      const msg = `Rule #${ruleId} is already disabled`
      if (options.md) console.log(`> ${msg}`)
      else notifyFail(msg)
      return { success: true, message: msg }
    }

    workflowRuleStorage.updateRule(projectId, ruleId, { enabled: false })

    if (options.md) {
      console.log(
        mdOutput(
          mdDone('Rule Disabled', `#${ruleId} [${rule.type}] ${rule.action}`),
          mdNextSteps([
            { label: 'Re-enable this rule', command: `prjct workflow enable ${ruleId} --md` },
            { label: 'View all rules', command: 'prjct workflow --md' },
          ])
        )
      )
    } else {
      notifyDone(`disabled rule #${ruleId}: ${rule.action}`)
    }

    return { success: true, ruleId }
  }

  const allRules = workflowRuleStorage.getAllRules(projectId)
  const matches = searchRules(allRules, trimmed)

  if (matches.length === 0) return failWith(`No rules matching "${trimmed}"`, options)

  if (matches.length === 1) {
    const rule = matches[0]
    workflowRuleStorage.updateRule(projectId, rule.id, { enabled: false })
    if (options.md) {
      console.log(mdOutput(mdDone('Rule Disabled', `#${rule.id} [${rule.type}] ${rule.action}`)))
    } else {
      notifyDone(`disabled rule #${rule.id}: ${rule.action}`)
    }
    return { success: true, ruleId: rule.id }
  }

  // Multiple matches → ask user to be more specific.
  const capped = matches.slice(0, MAX_LISTED_MATCHES)
  const overflow = matches.length - MAX_LISTED_MATCHES
  const overflowMsg = overflow > 0 ? `...and ${overflow} more` : null

  if (options.md) {
    const items: string[] = capped.map(
      (r: WorkflowRule) => `#${r.id} [${r.type}] ${r.position} ${r.command} -> \`${r.action}\``
    )
    if (overflowMsg) items.push(overflowMsg)
    console.log(
      mdOutput(
        mdSection('Multiple matches', `${matches.length} rules match "${trimmed}"`),
        mdList(items),
        mdNextSteps(
          capped.map((r: WorkflowRule) => ({
            label: `Disable #${r.id}`,
            command: `prjct workflow disable ${r.id} --md`,
          }))
        )
      )
    )
  } else {
    notifyFail(`${matches.length} rules match "${trimmed}" — specify an ID:`)
    for (const r of capped) {
      console.log(`  #${r.id} [${r.type}] ${r.position} ${r.command} -> ${r.action}`)
    }
    if (overflowMsg) console.log(`  ${overflowMsg}`)
  }

  return { success: true, matches: matches.map((r: WorkflowRule) => r.id) }
}
