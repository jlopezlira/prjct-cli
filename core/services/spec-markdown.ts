/**
 * Render a spec as Markdown — the single implementation shared by the CLI
 * (`prjct spec show --md`) and the MCP `prjct_spec_get` tool so both
 * surfaces emit byte-identical output.
 *
 * The renderer stays pure/sync: queue-task state for the `## Tasks`
 * checklist is injected via the optional `taskStates` parameter (keyed by
 * AC text = queue task `body`). Call sites that can reach queue storage
 * pass it in; when omitted, the section is skipped entirely so output is
 * unchanged for stateless callers.
 */

import type { SpecContent, SpecScenario } from '../types/spec'
import { requirementStatements } from './spec-delta'

/** Queue state for one acceptance criterion, keyed by AC text. */
export interface SpecTaskState {
  id: string
  completed: boolean
}

export function renderSpecMarkdown(
  spec: {
    id: string
    title: string
    status: string
    content: SpecContent
    createdAt: string
    updatedAt: string
  },
  taskStates?: ReadonlyMap<string, SpecTaskState>
): string {
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
    // Scenarios render under their requirement's AC line. The slug →
    // statement map comes from folding the delta log; ACs without scenarios
    // render exactly as before (byte-identical for legacy specs).
    const scenarioByStatement = new Map<string, SpecScenario[]>()
    if (c.delta_log.length > 0) {
      const statementBySlug = requirementStatements(c.delta_log)
      for (const [slug, scenarios] of Object.entries(c.scenarios)) {
        const statement = statementBySlug.get(slug)
        if (statement && scenarios.length > 0) scenarioByStatement.set(statement, scenarios)
      }
    }
    for (const ac of c.acceptance_criteria) {
      lines.push(`- [ ] ${ac}`)
      const scenarios = scenarioByStatement.get(ac)
      if (!scenarios) continue
      for (const sc of scenarios) {
        lines.push(`  - **Scenario: ${sc.name}**`)
        for (const g of sc.given) lines.push(`    - GIVEN ${g}`)
        for (const w of sc.when) lines.push(`    - WHEN ${w}`)
        for (const t of sc.then) lines.push(`    - THEN ${t}`)
      }
    }
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
  // One checkbox per AC, checked when the adopted/created queue task for
  // that AC (matched by body) is done; the task id rides inline. ACs with
  // no queue row yet render unchecked without an id.
  if (taskStates && c.acceptance_criteria.length > 0) {
    lines.push('', '## Tasks')
    for (const ac of c.acceptance_criteria) {
      const t = taskStates.get(ac)
      lines.push(`- ${t?.completed ? '[x]' : '[ ]'} ${ac}${t ? ` (\`${t.id}\`)` : ''}`)
    }
  }
  if (c.notes) lines.push('', '## Notes', c.notes)
  return lines.join('\n')
}
