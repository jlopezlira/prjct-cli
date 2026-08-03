import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(__dirname, '../../..')

describe('SessionStart independent probe scheduling', () => {
  test('starts all context probes before awaiting them together', () => {
    const source = fs.readFileSync(path.join(ROOT, 'core', 'hooks', 'session-start.ts'), 'utf-8')
    const awaitAll = source.indexOf('await Promise.all([')
    expect(awaitAll).toBeGreaterThan(0)

    const declarations = [
      'const stalenessPromise',
      'const vaultNoticePromise',
      'const landCuePromise',
      'const weakBannerPromise',
      'const handoffCuePromise',
      'const continuityCuePromise',
      'const identityPromise',
    ]
    for (const declaration of declarations) {
      const index = source.indexOf(declaration)
      expect(index).toBeGreaterThan(0)
      expect(index).toBeLessThan(awaitAll)
    }

    const blockEnd = source.indexOf('])', awaitAll)
    expect(blockEnd).toBeGreaterThan(awaitAll)
    const block = source.slice(awaitAll, blockEnd)
    for (const name of declarations.map((declaration) => declaration.slice('const '.length))) {
      expect(block).toContain(name)
    }
  })

  test('checks HEAD and exact commit count concurrently before the original bounded diff', () => {
    const source = fs.readFileSync(
      path.join(ROOT, 'core', 'services', 'staleness-checker.ts'),
      'utf-8'
    )
    const parallelRangeProbe = source.indexOf('const [head, revList] = await Promise.all([')
    expect(parallelRangeProbe).toBeGreaterThan(0)

    const blockEnd = source.indexOf('])', parallelRangeProbe)
    const block = source.slice(parallelRangeProbe, blockEnd)
    expect(block).toContain("['rev-parse', '--short', 'HEAD']")
    expect(block).toContain("['rev-list', '--count'")

    const needNames = source.indexOf('if (needNames)', blockEnd)
    const exactDiff = source.indexOf("['diff', '--name-only'", needNames)
    expect(needNames).toBeGreaterThan(blockEnd)
    expect(exactDiff).toBeGreaterThan(needNames)
    expect(source).not.toContain('changedFileLog')
  })
})
