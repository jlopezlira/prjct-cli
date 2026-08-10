/**
 * E2E: `prjct review-risk` through the real CLI subprocess against real git
 * repos of varying shapes. The unit test covers the pure tier/geometry math;
 * this covers the actual command end-to-end (git parsing + --md output +
 * exit codes) in a hermetic sandbox.
 *
 *   no-signal → trivial/direct → large/split
 */

import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { makeSandbox, type Sandbox } from './_harness'

setDefaultTimeout(120_000)

function git(cwd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn('git', args, { cwd, stdio: 'ignore' })
    p.on('error', reject)
    p.on('exit', (c) => (c === 0 ? resolve() : reject(new Error(`git ${args[0]} → ${c}`))))
  })
}

describe('e2e: review-risk (real CLI, hermetic git repos)', () => {
  const fixture: {
    sb: Sandbox
  } = {
    sb: undefined as unknown as Sandbox,
  }

  beforeAll(async () => {
    fixture.sb = await makeSandbox()
    expect((await fixture.sb.cli(['init'], { timeoutMs: 90_000 })).code).toBe(0)
    expect((await fixture.sb.cli(['setup'], { timeoutMs: 90_000 })).code).toBe(0)
    await git(fixture.sb.dir, ['add', '.'])
    await git(fixture.sb.dir, ['commit', '-q', '-m', 'prjct init'])
  })
  afterAll(async () => {
    await fixture.sb.cleanup()
  })

  test('no-signal (nothing ahead of base) → exit 0, graceful message', async () => {
    const r = await fixture.sb.cli(['review-risk', '--md'])
    expect(r.code).toBe(0)
    expect(r.stdout.toLowerCase()).toMatch(/no comparable|review risk|trivial/)
  })

  test('trivial change on a feature branch → direct', async () => {
    await git(fixture.sb.dir, ['checkout', '-q', '-b', 'feat/tiny'])
    await fs.writeFile(path.join(fixture.sb.dir, 'tiny.txt'), 'one small line\n')
    await git(fixture.sb.dir, ['add', '.'])
    await git(fixture.sb.dir, ['commit', '-q', '-m', 'tiny'])

    const r = await fixture.sb.cli(['review-risk', '--md'])
    expect(r.code).toBe(0)
    expect(r.stdout.toLowerCase()).toMatch(/trivial|direct/)
  })

  test('large change (many files) → split, never mutates git', async () => {
    await git(fixture.sb.dir, ['checkout', '-q', 'main'])
    await git(fixture.sb.dir, ['checkout', '-q', '-b', 'feat/huge'])
    for (const i of Array.from({ length: 14 }, (_, index) => index)) {
      await fs.writeFile(
        path.join(fixture.sb.dir, `mod${i}.ts`),
        `export const v${i} = ${i}\n`.repeat(50)
      )
    }
    await git(fixture.sb.dir, ['add', '.'])
    await git(fixture.sb.dir, ['commit', '-q', '-m', 'huge'])

    const head = (await fixture.sb.cli(['review-risk'])).stdout // also exercise non-md
    const r = await fixture.sb.cli(['review-risk', '--md'])
    expect(r.code).toBe(0)
    expect((head + r.stdout).toLowerCase()).toMatch(/large|split/)

    // Read-only contract: branch unchanged, no stray commits.
    const log = await new Promise<string>((resolve) => {
      const chunks: string[] = []
      const p = spawn('git', ['log', '--oneline'], { cwd: fixture.sb.dir })
      p.stdout.on('data', (d) => {
        chunks.push(d.toString())
      })
      p.on('exit', () => resolve(chunks.join('')))
    })
    expect(log.split('\n').filter(Boolean).length).toBe(3) // repo init + prjct init + huge
  })
})
