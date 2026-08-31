/**
 * Host payload shapes — the one statusline script serves every rig.
 *
 * Claude Code sends nested objects ({model: {display_name}, workspace,
 * context_window, rate_limits}); Kimi Code's [status_line].command sends a
 * flat snapshot ({model: "...", cwd, contextTokens, maxContextTokens}).
 * Also pins the tab-collapse regression: bash treats tab as IFS whitespace,
 * so an empty middle @tsv field used to shift every later field one slot
 * left (a payload without resets_at rendered the weekly percent as the
 * 5h reset timestamp).
 */

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
    env: { ...process.env, HOME: fixture.home, NO_COLOR: '1', PRJCT_STATUSLINE_NO_CACHE: '1' },
  })
  expect(result.status).toBe(0)
  return stripAnsi(result.stdout.trim())
}

describe('prjct statusline host payloads', () => {
  test('renders the Kimi flat snapshot (cwd, string model, flat context tokens)', () => {
    const output = runStatusline({
      model: 'K3',
      cwd: fixture.home,
      gitBranch: 'main',
      contextTokens: 157286,
      maxContextTokens: 262144,
    })

    expect(output).toContain(path.basename(fixture.home))
    // 157286/262144 ≈ 59% — above the 30% display floor, so it must render.
    expect(output).toContain('59%')
  })

  test('empty model and cwd strings fall back to defaults instead of shifting fields', () => {
    // "" passes through jq's // (only null/false trigger the alternative), so
    // without the sentinel these emitted empty leading @tsv fields and every
    // later field shifted into the wrong variable.
    const output = runStatusline({
      model: '',
      cwd: '',
      contextTokens: 5,
      maxContextTokens: 10,
    })

    expect(output).toContain('~')
    expect(output).not.toContain('- ')
    // 5/10 = 50% context — proves the numeric fields stayed in their slots.
    expect(output).toContain('50%')
  })

  test('renders a limit that has resets_at but no percent without shifting the other window', () => {
    const output = runStatusline({
      model: { display_name: 'Claude' },
      workspace: { current_dir: fixture.home },
      rate_limits: {
        five_hour: { resets_at: '2026-09-01T00:00:00Z' },
        weekly: { used_percentage: 23 },
      },
    })

    expect(output).toContain('○ 7d 23%')
    expect(output).not.toContain('5h')
  })

  test('keeps weekly limit in its slot when resets_at is absent (tab-collapse regression)', () => {
    const output = runStatusline({
      model: { display_name: 'Claude' },
      workspace: { current_dir: fixture.home },
      rate_limits: {
        five_hour: { used_percentage: 12 },
        weekly: { used_percentage: 23 },
      },
    })

    expect(output).toContain('○ 5h 12%')
    expect(output).toContain('○ 7d 23%')
  })
})
