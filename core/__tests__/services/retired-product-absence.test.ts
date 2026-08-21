import { describe, expect, it } from 'bun:test'
import path from 'node:path'

const REPO_ROOT = path.resolve(__dirname, '../../..')

describe('retired product absence', () => {
  it('keeps the unreleased terminal product out of every tracked file', () => {
    const prefix = 'p'
    const suffix = 'term'
    const pattern = `${prefix}[- _]?${suffix}|${prefix}${suffix}`
    const result = Bun.spawnSync(['git', 'grep', '-I', '-n', '-i', '-E', pattern, '--', '.'], {
      cwd: REPO_ROOT,
    })

    expect(result.exitCode).toBe(1)
    expect(result.stdout.toString()).toBe('')
    expect(result.stderr.toString()).toBe('')
  })
})
