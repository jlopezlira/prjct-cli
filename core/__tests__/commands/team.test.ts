/**
 * `prjct team` integration tests.
 *
 * Spins up a temporary git repo, runs the team command, and asserts:
 *   - enrollment is readable back through `prjct team check`
 *   - --required / --min-version flow into the stored row
 *   - the command writes NOTHING into the client worktree beyond the
 *     `.prjct/prjct.config.json` pointer, and stages nothing
 *
 * The last group is the regression guard for the product law: prjct
 * never writes agent-facing or derived state into the customer repo.
 * There is no `.prjct/team.json` mirror and no `.githooks/pre-commit`
 * any more — `legacy-crew-sweep` deletes a leftover mirror on the next
 * `prjct sync`, so a writer here would only fight it.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { execSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { TeamCommands } from '../../commands/team'

const fixture: {
  testDir: string
} = {
  testDir: '',
}

async function setupTempRepo(): Promise<string> {
  const dir = path.join(
    os.tmpdir(),
    `prjct-team-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
  )
  await fs.mkdir(dir, { recursive: true })
  execSync('git init -q', { cwd: dir })
  execSync('git config user.email test@example.com', { cwd: dir })
  execSync('git config user.name test', { cwd: dir })
  return dir
}

/** Every path under `dir`, repo-relative, excluding `.git/`. */
async function listTree(dir: string): Promise<string[]> {
  const walk = async (current: string): Promise<string[]> => {
    const entries = await fs.readdir(current, { withFileTypes: true })
    const nested = await Promise.all(
      entries
        .filter((entry) => entry.name !== '.git')
        .map(async (entry) => {
          const abs = path.join(current, entry.name)
          const rel = path.relative(dir, abs)
          return entry.isDirectory() ? walk(abs) : [rel]
        })
    )
    return nested.flat()
  }
  return (await walk(dir)).sort()
}

beforeEach(async () => {
  fixture.testDir = await setupTempRepo()
})

afterEach(async () => {
  if (fixture.testDir) {
    await fs.rm(fixture.testDir, { recursive: true, force: true }).catch(() => undefined)
    fixture.testDir = ''
  }
})

describe('prjct team — enrollment', () => {
  test('stores a default enrollment readable through team check', async () => {
    const team = new TeamCommands()
    const result = await team.team(null, fixture.testDir, {})
    expect(result.success).toBe(true)

    const checked = await team.team('check', fixture.testDir, {})
    expect(checked.success).toBe(true)
    expect(checked.empty).toBe(false)
    const stored = checked.teamConfig as { required: boolean; minVersion: string }
    expect(stored.required).toBe(false)
    expect(stored.minVersion).toMatch(/^\d+\.\d+\.\d+/)
  })

  test('--required flips the stored field', async () => {
    const team = new TeamCommands()
    await team.team(null, fixture.testDir, { required: true })

    const checked = await team.team('check', fixture.testDir, {})
    expect((checked.teamConfig as { required: boolean }).required).toBe(true)
  })

  test('--min-version overrides the auto-detected version', async () => {
    const team = new TeamCommands()
    await team.team(null, fixture.testDir, { minVersion: '3.0.0' })

    const checked = await team.team('check', fixture.testDir, {})
    expect((checked.teamConfig as { minVersion: string }).minVersion).toBe('3.0.0')
  })

  test('team check on a fresh project reports no enrollment', async () => {
    const team = new TeamCommands()
    const checked = await team.team('check', fixture.testDir, {})
    expect(checked.success).toBe(true)
    expect(checked.empty).toBe(true)
  })
})

describe('prjct team — never writes into the client repo', () => {
  test('leaves nothing behind but the .prjct config pointer', async () => {
    const team = new TeamCommands()
    await team.team(null, fixture.testDir, { required: true })

    // listTree yields files only — a directory contributes its contents.
    expect(await listTree(fixture.testDir)).toEqual([path.join('.prjct', 'prjct.config.json')])
  })

  test('writes no team.json mirror, hook, or CLAUDE.md', async () => {
    const team = new TeamCommands()
    await team.team(null, fixture.testDir, { required: true })

    for (const banned of [
      path.join('.prjct', 'team.json'),
      path.join('.githooks', 'pre-commit'),
      path.join('.claude', 'CLAUDE.md'),
      'AGENTS.md',
      'CLAUDE.md',
      'PRJCT.md',
    ]) {
      await expect(fs.access(path.join(fixture.testDir, banned))).rejects.toBeDefined()
    }
  })

  test('stages nothing and sets no core.hooksPath', async () => {
    const team = new TeamCommands()
    const result = await team.team(null, fixture.testDir, { required: true })
    expect(result.staged).toBe(false)

    const staged = execSync('git diff --staged --name-only', { cwd: fixture.testDir })
      .toString()
      .trim()
    expect(staged).toBe('')

    // `git config` exits non-zero when the key is unset — that is the pass.
    const hooksPath = (() => {
      try {
        return execSync('git config core.hooksPath', {
          cwd: fixture.testDir,
          stdio: ['ignore', 'pipe', 'ignore'],
        })
          .toString()
          .trim()
      } catch {
        return null
      }
    })()
    expect(hooksPath).toBeNull()
  })
})

describe('prjct team — outside a git repo', () => {
  test('still records the enrollment and stages nothing', async () => {
    const dir = path.join(os.tmpdir(), `prjct-team-nongit-${Date.now()}`)
    await fs.mkdir(dir, { recursive: true })
    try {
      const team = new TeamCommands()
      const result = await team.team(null, dir, {})
      expect(result.success).toBe(true)
      expect(result.staged).toBe(false)

      const checked = await team.team('check', dir, {})
      expect(checked.empty).toBe(false)

      await expect(fs.access(path.join(dir, '.prjct', 'team.json'))).rejects.toBeDefined()
    } finally {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined)
    }
  })
})
