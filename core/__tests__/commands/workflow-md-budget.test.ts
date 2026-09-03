import { describe, expect, it } from 'bun:test'
import { packWorkMarkdownSections } from '../../commands/workflow'

describe('work --md priority budget', () => {
  it('keeps required whole sections, skips oversized prose, and stays bounded', () => {
    const model = '### Model guidance\nworkflow:diagnosing-bugs=`/trusted/path.md`'
    const pipeline = '### Pipeline\nNext action: reproduce the failure'
    const oversized = `### Optional history\n${'noise '.repeat(600)}`
    const output = packWorkMarkdownSections([model, oversized, pipeline], [], 260)

    expect(output.length).toBeLessThanOrEqual(260)
    expect(output).toContain(model)
    expect(output).toContain(pipeline)
    expect(output).not.toContain('noise noise')
  })

  it('retains repository alignment and source scope ahead of secondary guidance', () => {
    const header = '## Fix inline duplication\n> Status: active'
    const alignment =
      '### Project alignment\nMatch house patterns; open the existing implementation before writing.'
    const scope = '### Work scope — prjct\n- `core/services/existing.ts` — existing abstraction'
    const secondary = `### Orchestration\n${'secondary '.repeat(80)}`

    const output = packWorkMarkdownSections([header, alignment, scope, secondary], [], 280)

    expect(output.length).toBeLessThanOrEqual(280)
    expect(output).toContain(alignment)
    expect(output).toContain(scope)
    expect(output).not.toContain('secondary secondary')
  })
})

describe('work --md bounded surface receipt', () => {
  const header = '## Fix the packing\n> Status: active'
  const directiveLines = Array.from(
    { length: 12 },
    (_, i) => `- criterion ${i + 1}: verify the flow ${i + 1} end to end`
  )
  const directive = `### QA plan (MUST before implementing)\n${directiveLines.join('\n')}`

  it('cuts a long required directive at a line boundary and names it in the receipt', () => {
    const output = packWorkMarkdownSections([header, directive], [], 420)

    expect(output.length).toBeLessThanOrEqual(420)
    expect(output).toContain(header)
    expect(output).toContain('### QA plan (MUST before implementing)')
    expect(output).toContain('- criterion 1:')
    expect(output).not.toContain('- criterion 12:')
    // Whole lines only: every kept criterion line is intact.
    for (const line of output.split('\n').filter((l) => l.startsWith('- criterion'))) {
      expect(directiveLines).toContain(line)
    }
    expect(output).toContain('> … cut for budget')
    expect(output).toContain('> Bounded surface — cut: QA plan.')
  })

  it('names omitted optional sections and keeps cut/omitted apart', () => {
    const optional = `### Living knowledge — prjct\n${'history '.repeat(60)}`
    const output = packWorkMarkdownSections([header, directive], [optional], 420)

    expect(output.length).toBeLessThanOrEqual(420)
    expect(output).not.toContain('history history')
    expect(output).toContain('cut: QA plan · omitted: Living knowledge.')
  })

  it('drops a required section rather than emitting a bare heading', () => {
    const oneLine = `### Optional history\n${'noise '.repeat(200)}`
    const output = packWorkMarkdownSections([header, oneLine], [], 200)

    expect(output.length).toBeLessThanOrEqual(200)
    expect(output).toContain(header)
    expect(output).not.toContain('### Optional history')
    expect(output).toContain('omitted: Optional history.')
  })

  it('the receipt never displaces content: a whole section is not dropped to fit it', () => {
    const alignment = '### Project alignment\nMatch house patterns before writing.'
    const scope = '### Work scope — prjct\n- `core/services/existing.ts`'
    const tail = `### Orchestration\n${'secondary '.repeat(80)}`
    const budget = header.length + 2 + alignment.length + 2 + scope.length + 20
    const output = packWorkMarkdownSections([header, alignment, scope, tail], [], budget)

    expect(output.length).toBeLessThanOrEqual(budget)
    expect(output).toContain(alignment)
    expect(output).toContain(scope)
    expect(output).not.toContain('secondary secondary')
    expect(output).not.toContain('Bounded surface — cut')
  })

  it('a named receipt may shrink an already-cut section but keeps its names', () => {
    const budget = 300
    const output = packWorkMarkdownSections([header, directive], [], budget)

    expect(output.length).toBeLessThanOrEqual(budget)
    expect(output).toContain(header)
    expect(output).toContain('### QA plan (MUST before implementing)')
    expect(output).toContain('- criterion 1:')
    expect(output).toContain('> Bounded surface — cut: QA plan.')
  })

  it('emits no receipt when everything fits', () => {
    const output = packWorkMarkdownSections([header, directive], [], 5_000)
    expect(output).not.toContain('Bounded surface')
    expect(output).not.toContain('cut for budget')
  })
})
