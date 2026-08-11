import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { REPO_ROOT } from '../e2e/_harness'

const fixture: {
  home: string
  tmp: string
} = {
  home: '',
  tmp: '',
}

beforeEach(async () => {
  fixture.home = await fsp.mkdtemp(path.join(os.tmpdir(), 'prjct-statusline-home-'))
  fixture.tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'prjct-statusline-tmp-'))
})

afterEach(async () => {
  await fsp.rm(fixture.home, { recursive: true, force: true }).catch(() => {})
  await fsp.rm(fixture.tmp, { recursive: true, force: true }).catch(() => {})
})

function runStatusline(input: unknown, extraEnv: Record<string, string> = {}) {
  const script = path.join(REPO_ROOT, 'assets', 'statusline', 'statusline.sh')
  const result = spawnSync('bash', [script], {
    input: JSON.stringify(input),
    encoding: 'utf-8',
    env: {
      ...process.env,
      HOME: fixture.home,
      TMPDIR: fixture.tmp,
      NO_COLOR: '1',
      ...extraEnv,
    },
  })
  expect(result.status).toBe(0)
  return result.stdout
}

function baseInput(fiveHourPct: number): Record<string, unknown> {
  return {
    model: { display_name: 'Claude Sonnet' },
    workspace: { current_dir: fixture.home },
    cost: { total_lines_added: 0, total_lines_removed: 0 },
    context_window: {
      context_window_size: 200000,
      current_usage: {
        input_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    },
    rate_limits: { five_hour: { used_percentage: fiveHourPct } },
  }
}

function cacheFilePath(): string {
  const entries = fs.readdirSync(fixture.tmp).filter((f) => f.startsWith('prjct-statusline-cache.'))
  expect(entries.length).toBe(1)
  return path.join(fixture.tmp, entries[0])
}

describe('prjct statusline render cache', () => {
  test('serves the cached render within the 2s TTL', () => {
    const first = runStatusline(baseInput(10))
    const second = runStatusline(baseInput(90))

    expect(second).toBe(first)
    expect(second).toContain('5h 10%')
  })

  test('bypasses the cache when PRJCT_STATUSLINE_NO_CACHE is set', () => {
    runStatusline(baseInput(10))
    const fresh = runStatusline(baseInput(90), { PRJCT_STATUSLINE_NO_CACHE: '1' })

    expect(fresh).toContain('5h 90%')
  })

  test('re-renders after the cache epoch expires', () => {
    const first = runStatusline(baseInput(10))
    expect(first).toContain('5h 10%')

    // Age the cache beyond the TTL by backdating the stored epoch
    const cacheFile = cacheFilePath()
    const cached = fs.readFileSync(cacheFile, 'utf-8')
    const lines = cached.split('\n')
    lines[0] = String(Math.floor(Date.now() / 1000) - 10)
    fs.writeFileSync(cacheFile, lines.join('\n'))

    const fresh = runStatusline(baseInput(90))
    expect(fresh).toContain('5h 90%')
  })

  test('ignores a cache file with a corrupt epoch line', () => {
    runStatusline(baseInput(10))
    const realCache = cacheFilePath()
    fs.writeFileSync(realCache, 'not-a-number\nstale output\n')

    const fresh = runStatusline(baseInput(90))
    expect(fresh).toContain('5h 90%')
    expect(fresh).not.toContain('stale output')
  })
})
