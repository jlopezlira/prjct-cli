import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { REPO_ROOT } from '../e2e/_harness'

const fixture: {
  home: string
} = {
  home: '',
}

beforeEach(async () => {
  fixture.home = await fs.mkdtemp(path.join(os.tmpdir(), 'prjct-statusline-test-'))
})

afterEach(async () => {
  await fs.rm(fixture.home, { recursive: true, force: true }).catch(() => {})
})

function stripAnsi(value: string): string {
  return value.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g'), '')
}

function runStatusline(input: unknown): string {
  const script = path.join(REPO_ROOT, 'assets', 'statusline', 'statusline.sh')
  const result = spawnSync('bash', [script], {
    input: JSON.stringify(input),
    encoding: 'utf-8',
    env: { ...process.env, HOME: fixture.home, NO_COLOR: '1' },
  })
  expect(result.status).toBe(0)
  return stripAnsi(result.stdout.trim())
}

function baseInput(rateLimits?: unknown): Record<string, unknown> {
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
    ...(rateLimits === undefined ? {} : { rate_limits: rateLimits }),
  }
}

describe('prjct statusline usage limits', () => {
  test('renders Claude object rate_limits as 5-hour and weekly circles', () => {
    const output = runStatusline(
      baseInput({
        five_hour: { used_percentage: 76, resets_at: '2026-06-24T08:00:00Z' },
        weekly: { used_percentage: 28, resets_at: '2026-06-29T08:00:00Z' },
      })
    )

    expect(output).toContain('◕ 5h 76%')
    expect(output).toContain('◔ 7d 28%')
  })

  test('renders Claude array rate_limits and danger threshold', () => {
    const output = runStatusline(
      baseInput([
        { name: '5-hour', used_percentage: 92, resets_at: '2026-06-24T08:00:00Z' },
        { name: 'weekly', used_percentage: 51, resets_at: '2026-06-29T08:00:00Z' },
      ])
    )

    expect(output).toContain('● 5h 92%')
    expect(output).toContain('◑ 7d 51%')
  })

  test('omits limit circles when runtime does not provide rate_limits', () => {
    const output = runStatusline(baseInput())

    expect(output).not.toContain('5h')
    expect(output).not.toContain('7d')
  })
})
