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
