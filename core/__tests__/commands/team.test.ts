/**
 * `prjct team` integration tests.
 *
 * Spins up a temporary git repo, runs the team command, and asserts:
 *   - .prjct/team.json written with the right shape
 *   - .claude/CLAUDE.md upserted between markers
 *   - --enforce installs .githooks/pre-commit and sets core.hooksPath
 *   - re-running is idempotent (no duplicate marker blocks)
 *   - existing CLAUDE.md content outside markers is preserved
 *
 * Not testing: the actual pre-commit hook firing — that's a POSIX sh
 * smoke test we cover separately. This file tests the command's file
 * outputs.
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

beforeEach(async () => {
  fixture.testDir = await setupTempRepo()
})

afterEach(async () => {
  if (fixture.testDir) {
    await fs.rm(fixture.testDir, { recursive: true, force: true }).catch(() => undefined)
    fixture.testDir = ''
  }
})

describe('prjct team — base behavior', () => {
  test('writes .prjct/team.json with default config', async () => {
    const team = new TeamCommands()
    const result = await team.team(null, fixture.testDir, {})

    expect(result.success).toBe(true)

    const teamPath = path.join(fixture.testDir, '.prjct', 'team.json')
    const raw = await fs.readFile(teamPath, 'utf-8')
    const parsed = JSON.parse(raw)
    expect(parsed.required).toBe(false)
    expect(parsed.minVersion).toMatch(/^\d+\.\d+\.\d+/)
    expect(parsed.enrolledAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  test('--required flag flips the team.json field', async () => {
    const team = new TeamCommands()
    await team.team(null, fixture.testDir, { required: true })

    const parsed = JSON.parse(
      await fs.readFile(path.join(fixture.testDir, '.prjct', 'team.json'), 'utf-8')
    )
    expect(parsed.required).toBe(true)
  })

  test('--min-version overrides the auto-detected version', async () => {
    const team = new TeamCommands()
    await team.team(null, fixture.testDir, { minVersion: '3.0.0' })

    const parsed = JSON.parse(
      await fs.readFile(path.join(fixture.testDir, '.prjct', 'team.json'), 'utf-8')
    )
    expect(parsed.minVersion).toBe('3.0.0')
  })

  test('upserts .claude/CLAUDE.md between markers', async () => {
    const team = new TeamCommands()
    await team.team(null, fixture.testDir, {})

    const claudeMd = await fs.readFile(path.join(fixture.testDir, '.claude', 'CLAUDE.md'), 'utf-8')
    expect(claudeMd).toContain('<!-- prjct-team:start')
    expect(claudeMd).toContain('<!-- prjct-team:end')
    expect(claudeMd).toContain('# prjct (team mode)')
  })

  test('preserves user content outside markers when CLAUDE.md exists', async () => {
    const claudeMdPath = path.join(fixture.testDir, '.claude', 'CLAUDE.md')
    await fs.mkdir(path.dirname(claudeMdPath), { recursive: true })
    await fs.writeFile(claudeMdPath, '# My existing rules\n\nDo not break things.\n')

    const team = new TeamCommands()
    await team.team(null, fixture.testDir, {})

    const after = await fs.readFile(claudeMdPath, 'utf-8')
    expect(after).toContain('# My existing rules')
    expect(after).toContain('Do not break things.')
    expect(after).toContain('<!-- prjct-team:start')
  })

  test('re-running is idempotent (no duplicate marker blocks)', async () => {
    const team = new TeamCommands()
    await team.team(null, fixture.testDir, {})
    await team.team(null, fixture.testDir, {})

    const claudeMd = await fs.readFile(path.join(fixture.testDir, '.claude', 'CLAUDE.md'), 'utf-8')
    const startCount = (claudeMd.match(/<!-- prjct-team:start/g) ?? []).length
    const endCount = (claudeMd.match(/<!-- prjct-team:end/g) ?? []).length
    expect(startCount).toBe(1)
    expect(endCount).toBe(1)
  })

  test('stages files in a git repo', async () => {
    const team = new TeamCommands()
    await team.team(null, fixture.testDir, {})

    const staged = execSync('git diff --staged --name-only', { cwd: fixture.testDir })
      .toString()
      .trim()
      .split('\n')
      .sort()
    expect(staged).toContain('.prjct/team.json')
    expect(staged).toContain('.claude/CLAUDE.md')
  })
})

describe('prjct team --enforce', () => {
  test('writes .githooks/pre-commit and makes it executable', async () => {
    const team = new TeamCommands()
    await team.team(null, fixture.testDir, { required: true, enforce: true })

    const hookPath = path.join(fixture.testDir, '.githooks', 'pre-commit')
    const stat = await fs.stat(hookPath)
    expect(stat.isFile()).toBe(true)
    // Owner exec bit
    expect(stat.mode & 0o100).toBe(0o100)

    const body = await fs.readFile(hookPath, 'utf-8')
    expect(body).toContain('#!/usr/bin/env sh')
    expect(body).toContain('TEAM_FILE=".prjct/team.json"')
    expect(body).toContain('command -v prjct')
  })

  test('sets git config core.hooksPath to .githooks', async () => {
    const team = new TeamCommands()
    await team.team(null, fixture.testDir, { required: true, enforce: true })

    const value = execSync('git config core.hooksPath', { cwd: fixture.testDir }).toString().trim()
    expect(value).toBe('.githooks')
  })

  test('stages the hook alongside team files', async () => {
    const team = new TeamCommands()
    await team.team(null, fixture.testDir, { required: true, enforce: true })

    const staged = execSync('git diff --staged --name-only', { cwd: fixture.testDir })
      .toString()
      .trim()
      .split('\n')
      .sort()
    expect(staged).toContain('.githooks/pre-commit')
    expect(staged).toContain('.prjct/team.json')
    expect(staged).toContain('.claude/CLAUDE.md')
  })

  test('hook script blocks when required:true and prjct missing from PATH (smoke)', async () => {
    const team = new TeamCommands()
    await team.team(null, fixture.testDir, { required: true, enforce: true })

    // Run the hook with an empty PATH that doesn't include prjct.
    // Expect non-zero exit + stderr mentioning install.
    const hookResult: { stderr: string; exitCode: number } = { stderr: '', exitCode: 0 }

    try {
      execSync('sh .githooks/pre-commit', {
        cwd: fixture.testDir,
        env: { ...process.env, PATH: '/usr/bin:/bin' },
        stdio: ['ignore', 'ignore', 'pipe'],
      })
    } catch (err) {
      const e = err as { status?: number; stderr?: Buffer }
      hookResult.exitCode = e.status ?? -1
      hookResult.stderr = e.stderr?.toString() ?? ''
    }
    expect(hookResult.exitCode).toBe(1)
    expect(hookResult.stderr.toLowerCase()).toContain('prjct is required')
  })

  test('hook script no-ops when required:false (POSIX sh smoke)', async () => {
    const team = new TeamCommands()
    await team.team(null, fixture.testDir, { required: false, enforce: true })

    // required:false → hook should exit 0 even with no prjct on PATH
    const exitCode = (() => {
      try {
        execSync('sh .githooks/pre-commit', {
          cwd: fixture.testDir,
          env: { ...process.env, PATH: '/usr/bin:/bin' },
          stdio: 'ignore',
        })
        return 0
      } catch (err) {
        return (err as { status?: number }).status ?? -1
      }
    })()
    expect(exitCode).toBe(0)
  })

  test('hook script no-ops when team.json missing', async () => {
    // Manually create just the hook (no team.json) and verify it exits 0
    const hookPath = path.join(fixture.testDir, '.githooks', 'pre-commit')
    await fs.mkdir(path.dirname(hookPath), { recursive: true })
    await fs.writeFile(
      hookPath,
      `#!/usr/bin/env sh
set -e
TEAM_FILE=".prjct/team.json"
[ -f "$TEAM_FILE" ] || exit 0
echo "should not reach here" >&2
exit 1
`,
      'utf-8'
    )
    await fs.chmod(hookPath, 0o755)

    const exitCode = (() => {
      try {
        execSync('sh .githooks/pre-commit', { cwd: fixture.testDir, stdio: 'ignore' })
        return 0
      } catch (err) {
        return (err as { status?: number }).status ?? -1
      }
    })()
    expect(exitCode).toBe(0)
  })
})

describe('prjct team — outside a git repo', () => {
  test('writes files but does not stage when not a git repo', async () => {
    const dir = path.join(os.tmpdir(), `prjct-team-nongit-${Date.now()}`)
    await fs.mkdir(dir, { recursive: true })
    try {
      const team = new TeamCommands()
      const result = await team.team(null, dir, {})
      expect(result.success).toBe(true)
      expect(result.staged).toBe(false)

      const teamPath = path.join(dir, '.prjct', 'team.json')
      const stat = await fs.stat(teamPath)
      expect(stat.isFile()).toBe(true)
    } finally {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined)
    }
  })
})
