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
})
