import { describe, expect, it } from 'bun:test'
import {
  livingContextTagsFromContent,
  parseLivingContextFields,
} from '../../services/living-context-contract'
import {
  formatRelatedContextForAgent,
  type RelatedContextHit,
  TASK_CONTEXT_PROMPT,
  taskContextPromptFor,
} from '../../services/task-service'

describe('living context contract', () => {
  it('task close prompt asks the executing model to synthesize structured context for any project', () => {
    expect(TASK_CONTEXT_PROMPT).toContain('same model that just executed the task')
    expect(TASK_CONTEXT_PROMPT).toContain('prjct remember context')
    expect(TASK_CONTEXT_PROMPT).toContain('Context synthesis')
    expect(TASK_CONTEXT_PROMPT).toContain('Key data')
    expect(TASK_CONTEXT_PROMPT).toContain('What happened')
    expect(TASK_CONTEXT_PROMPT).toContain('Why it mattered')
    expect(TASK_CONTEXT_PROMPT).toContain('Who/author')
    expect(TASK_CONTEXT_PROMPT).toContain('Model')
    expect(TASK_CONTEXT_PROMPT).toContain('Token usage')
    expect(TASK_CONTEXT_PROMPT).toContain('Sentiment')
    expect(TASK_CONTEXT_PROMPT).toContain('Related files')
    expect(TASK_CONTEXT_PROMPT).toContain('Feature/domain')
    expect(TASK_CONTEXT_PROMPT).toContain('Pattern')
    expect(TASK_CONTEXT_PROMPT).toContain('Anti-pattern')
    expect(TASK_CONTEXT_PROMPT).toContain('Decision/trap')
    expect(TASK_CONTEXT_PROMPT).toContain('Outcome')
    expect(TASK_CONTEXT_PROMPT).toContain('Next implication')
    expect(TASK_CONTEXT_PROMPT).toContain('Key data is still required')
    expect(TASK_CONTEXT_PROMPT).toContain('Raw detector output is input, not the final context')
  })

  it('adds an RCA receipt only when a bug cycle closes', () => {
    const bug = taskContextPromptFor({ kind: 'bug' })
    expect(bug).toContain('Bug-cycle RCA receipt')
    expect(bug).toContain('exact repro command')
    expect(bug).toContain('causal mechanism')
    expect(bug).toContain('regression seam/test')
    expect(bug).toContain('never copy secrets or raw logs')

    expect(taskContextPromptFor({ kind: 'feature' })).toBe(TASK_CONTEXT_PROMPT)
  })

  it('parses structured context fields so storage can tag useful retrieval dimensions', () => {
    const fields = parseLivingContextFields(
      [
        'Context synthesis: The project learned to treat synthesized context as the product value while still emitting structured facts for UI.',
        'Key data: feature=memory; files=core/services/task-service.ts; model=gpt-5-codex',
        'What happened: added living context synthesis',
        'Why it mattered: raw telemetry was not useful context',
        'Who/author: JJ',
        'Model: gpt-5-codex',
        'Token usage: 18420',
        'Sentiment: frustrated but directional',
        'Related files: core/services/task-service.ts, core/memory/entries.ts',
        'Feature/domain: memory',
        'Pattern: model-authored synthesis at task close',
        'Anti-pattern: storing detector rows as final context',
        'Decision/trap: detectors are inputs only',
        'Outcome: richer context prompt shipped',
        'Next implication: migrate more auto signals into synthesis inputs',
      ].join(' · ')
    )

    expect(fields.contextSynthesis).toContain('synthesized context as the product value')
    expect(fields.keyData).toContain('feature=memory')
    expect(fields.whatHappened).toBe('added living context synthesis')
    expect(fields.model).toBe('gpt-5-codex')
    expect(fields.tokenUsage).toBe('18420')
    expect(fields.sentiment).toBe('frustrated but directional')
    expect(fields.relatedFiles).toEqual(['core/services/task-service.ts', 'core/memory/entries.ts'])
    expect(fields.featureDomain).toBe('memory')
    expect(fields.nextImplication).toContain('migrate more auto signals')
  })

  it('tags key data separately while keeping synthesis in the entry body', () => {
    const tags = livingContextTagsFromContent(
      [
        'Context synthesis: This is the durable narrative future agents should read.',
        'Key data: feature=memory; surface=dashboard',
        'Model: gpt-5-codex',
        'Token usage: 18420',
        'Feature/domain: memory',
      ].join(' · ')
    )

    expect(tags.context_schema).toBe('living-v2')
    expect(tags.key_data).toBe('feature=memory; surface=dashboard')
    expect(tags.model).toBe('gpt-5-codex')
    expect(tags.token_usage).toBe('18420')
    expect(tags.feature).toBe('memory')
  })

  it('formats retrieved context as a compact, self-sufficient one-liner', () => {
    const line = formatRelatedContextForAgent({
      id: 'mem_1',
      type: 'context',
      title: 'Living context',
      detail: 'Durable synthesis for the next LLM.',
      keyData: 'feature=memory; surface=dashboard',
      when: '2026-06-26T00:00:00Z',
    } satisfies RelatedContextHit)

    // Compact surface: [role·type] title (date) `id` — salient field.
    // role is ctx/SoT/SUGGEST (living-apply). Full body stays one search away.
    expect(line).toContain('[ctx·context] Living context')
    expect(line).toContain('`mem_1`')
    expect(line).toContain('feature=memory; surface=dashboard')
    expect(line).not.toContain('Key data:')
    expect(line).not.toContain('Detail:')
  })

  it('prioritizes a trap/decision over generic fields in the compact line', () => {
    const line = formatRelatedContextForAgent({
      id: 'mem_2',
      type: 'gotcha',
      title: 'Worktree ship trap',
      detail: 'long body about worktree ship behavior',
      when: '2026-06-26T00:00:00Z',
      why: 'generic reason',
      decisionTrap: 'ship inside a worktree double-bumps the version',
      keyData: 'k=v',
    } satisfies RelatedContextHit)

    expect(line).toContain('ship inside a worktree double-bumps the version')
    expect(line).not.toContain('generic reason')
  })
})
