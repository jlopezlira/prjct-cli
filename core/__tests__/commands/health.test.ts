/**
 * HealthCommands — `prjct health` smoke tests.
 *
 * Runs against tmpdir projects with controllable script outcomes.
 */

import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { HealthCommands } from '../../commands/health'

const fixture: {
  dir: string
} = {
  dir: '',
}
const cmd = new HealthCommands()

beforeEach(async () => {
  fixture.dir = await fs.mkdtemp(path.join(os.tmpdir(), 'prjct-health-test-'))
  await fs.mkdir(path.join(fixture.dir, '.prjct'), { recursive: true })
  await fs.writeFile(
    path.join(fixture.dir, '.prjct/prjct.config.json'),
    JSON.stringify({ projectId: `health-test-${Date.now()}` })
  )
})

afterEach(async () => {
  await fs.rm(fixture.dir, { recursive: true, force: true }).catch(() => {})
})

async function writePkg(scripts: Record<string, string>): Promise<void> {
  await fs.writeFile(
    path.join(fixture.dir, 'package.json'),
    JSON.stringify({ name: 'tmp', version: '0.0.1', scripts })
  )
}

describe('prjct health', () => {
  it('reports zero dimensions when package.json is missing', async () => {
    const r = await cmd.health(null, fixture.dir, { md: false })
    expect(r.success).toBe(true)
    expect(r.results).toBe(0)
  })

  it('reports zero dimensions when no quality scripts exist', async () => {
    await writePkg({ build: 'echo build' })
    const r = await cmd.health(null, fixture.dir, { md: true })
    expect(r.success).toBe(true)
    expect(r.results).toBe(0)
  })

  it('runs the typecheck dimension and scores 100 when it exits 0', async () => {
    await writePkg({ typecheck: 'true' }) // `true` exits 0
    const r = await cmd.health(null, fixture.dir, { md: false })
    expect(r.success).toBe(true)
    expect(r.score).toBe(100)
  })

  it('exits non-zero and lowers the score when a dimension fails', async () => {
    await writePkg({ typecheck: 'false' }) // `false` exits 1
    const r = await cmd.health(null, fixture.dir, { md: false })
    expect(r.success).toBe(false)
    expect(r.score).toBe(0)
  })

  it('partial pass — typecheck pass + lint fail = 25/45 ≈ 56', async () => {
    await writePkg({ typecheck: 'true', lint: 'false' })
    const r = await cmd.health(null, fixture.dir, { md: false })
    expect(r.success).toBe(false)
    // typecheck weight=25, lint weight=20; pass=25 / total=45 → 56
    expect(r.score).toBe(56)
  })

  it('reports a timeout diagnostic, not a scraped log line, when a dimension is killed on budget', async () => {
    const prev = process.env.PRJCT_HEALTH_DIM_TIMEOUT_MS
    process.env.PRJCT_HEALTH_DIM_TIMEOUT_MS = '50'
    const log = spyOn(console, 'log').mockImplementation(() => {})
    try {
      // Prints a misleading line before the timeout fires, to prove we no
      // longer scrape stdout/stderr on a killed run.
      await writePkg({ typecheck: 'echo "core/__tests__/unrelated.test.ts:" && sleep 2' })
      const r = await cmd.health(null, fixture.dir, { md: true })
      expect(r.success).toBe(false)
      const output = log.mock.calls.map((call) => call.join(' ')).join('\n')
      expect(output).toContain('timed out after')
      expect(output).not.toContain('unrelated.test.ts')
    } finally {
      log.mockRestore()
      if (prev === undefined) delete process.env.PRJCT_HEALTH_DIM_TIMEOUT_MS
      else process.env.PRJCT_HEALTH_DIM_TIMEOUT_MS = prev
    }
  })
})
