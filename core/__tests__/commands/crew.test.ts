/**
 * `prjct crew` install/uninstall/status.
 *
 * Behavior-focused: each test runs the command against a real tmp project
 * and asserts on the resulting filesystem state. No mocks for fs.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { CrewCommands } from '../../commands/crew'

async function freshProject(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'prjct-crew-test-'))
}

const SNIPPET_START = '<!-- prjct:crew:start - DO NOT REMOVE THIS MARKER -->'
const SNIPPET_END = '<!-- prjct:crew:end - DO NOT REMOVE THIS MARKER -->'

describe('prjct crew', () => {
  const fixture: {
    projectPath: string
    cmd: CrewCommands
  } = {
    projectPath: '',
    cmd: undefined as unknown as CrewCommands,
  }

  beforeEach(async () => {
    fixture.projectPath = await freshProject()
    fixture.cmd = new CrewCommands()
  })

  afterEach(async () => {
    await fs.rm(fixture.projectPath, { recursive: true, force: true })
  })

  test('install creates the trio + CHECKPOINTS + appends snippet', async () => {
    const result = await fixture.cmd.install(null, fixture.projectPath, { md: true })
    expect(result.success).toBe(true)

    for (const f of [
      '.claude/agents/leader.md',
      '.claude/agents/implementer.md',
      '.claude/agents/reviewer.md',
      'CLAUDE.md',
    ]) {
      const content = await fs.readFile(path.join(fixture.projectPath, f), 'utf-8')
      expect(content.length).toBeGreaterThan(0)
    }

    // Post-spec-a50b32d1: checkpoints moved from `.prjct/CHECKPOINTS.md`
    // to kv_store. The file is no longer written by install — the
    // reviewer template carries the content inline between markers.
    const reviewerMd = await fs.readFile(
      path.join(fixture.projectPath, '.claude/agents/reviewer.md'),
      'utf-8'
    )
    expect(reviewerMd).toContain('<!-- prjct:checkpoints:start')
    expect(reviewerMd).toContain('<!-- prjct:checkpoints:end -->')

    const claudeMd = await fs.readFile(path.join(fixture.projectPath, 'CLAUDE.md'), 'utf-8')
    expect(claudeMd).toContain(SNIPPET_START)
    expect(claudeMd).toContain(SNIPPET_END)
    expect(claudeMd).toContain('Crew leader mode')
  })

  test('install preserves existing CLAUDE.md content', async () => {
    const original = '# My project\n\nSome existing instructions.\n'
    await fs.writeFile(path.join(fixture.projectPath, 'CLAUDE.md'), original, 'utf-8')

    await fixture.cmd.install(null, fixture.projectPath, { md: true })

    const claudeMd = await fs.readFile(path.join(fixture.projectPath, 'CLAUDE.md'), 'utf-8')
    expect(claudeMd).toContain('# My project')
    expect(claudeMd).toContain('Some existing instructions.')
    expect(claudeMd).toContain(SNIPPET_START)
  })

  test('install is idempotent — does not duplicate the snippet', async () => {
    await fixture.cmd.install(null, fixture.projectPath, { md: true })
    await fixture.cmd.install(null, fixture.projectPath, { md: true })

    const claudeMd = await fs.readFile(path.join(fixture.projectPath, 'CLAUDE.md'), 'utf-8')
    const startMatches = claudeMd.match(/prjct:crew:start/g) ?? []
    const endMatches = claudeMd.match(/prjct:crew:end/g) ?? []
    expect(startMatches.length).toBe(1)
    expect(endMatches.length).toBe(1)
  })

  test('install does not overwrite an existing CHECKPOINTS.md', async () => {
    const existingPath = path.join(fixture.projectPath, '.prjct/CHECKPOINTS.md')
    await fs.mkdir(path.dirname(existingPath), { recursive: true })
    await fs.writeFile(existingPath, '# my custom checkpoints\n', 'utf-8')

    await fixture.cmd.install(null, fixture.projectPath, { md: true })

    const content = await fs.readFile(existingPath, 'utf-8')
    expect(content).toBe('# my custom checkpoints\n')
  })

  test('uninstall removes the trio + CHECKPOINTS + strips snippet', async () => {
    await fixture.cmd.install(null, fixture.projectPath, { md: true })
    const result = await fixture.cmd.uninstall(null, fixture.projectPath, { md: true })
    expect(result.success).toBe(true)

    for (const f of [
      '.claude/agents/leader.md',
      '.claude/agents/implementer.md',
      '.claude/agents/reviewer.md',
      '.prjct/CHECKPOINTS.md',
    ]) {
      const exists = await fs
        .access(path.join(fixture.projectPath, f))
        .then(() => true)
        .catch(() => false)
      expect(exists).toBe(false)
    }

    const claudeMd = await fs.readFile(path.join(fixture.projectPath, 'CLAUDE.md'), 'utf-8')
    expect(claudeMd).not.toContain(SNIPPET_START)
    expect(claudeMd).not.toContain(SNIPPET_END)
  })

  test('uninstall preserves non-crew content in CLAUDE.md', async () => {
    const original = '# My project\n\nSome existing instructions.\n'
    await fs.writeFile(path.join(fixture.projectPath, 'CLAUDE.md'), original, 'utf-8')

    await fixture.cmd.install(null, fixture.projectPath, { md: true })
    await fixture.cmd.uninstall(null, fixture.projectPath, { md: true })

    const claudeMd = await fs.readFile(path.join(fixture.projectPath, 'CLAUDE.md'), 'utf-8')
    expect(claudeMd).toContain('# My project')
    expect(claudeMd).toContain('Some existing instructions.')
    expect(claudeMd).not.toContain('prjct:crew')
  })

  test('uninstall preserves unrelated agents in .claude/agents/', async () => {
    const userAgent = path.join(fixture.projectPath, '.claude/agents/my-agent.md')
    await fs.mkdir(path.dirname(userAgent), { recursive: true })
    await fs.writeFile(userAgent, '# my agent\n', 'utf-8')

    await fixture.cmd.install(null, fixture.projectPath, { md: true })
    await fixture.cmd.uninstall(null, fixture.projectPath, { md: true })

    const stillExists = await fs
      .access(userAgent)
      .then(() => true)
      .catch(() => false)
    expect(stillExists).toBe(true)
  })

  test('status reports complete=false on a fresh project', async () => {
    const result = await fixture.cmd.status(null, fixture.projectPath, { md: true })
    expect(result.success).toBe(true)
    expect(result.complete).toBe(false)
  })

  test('status reports complete=true after install', async () => {
    await fixture.cmd.install(null, fixture.projectPath, { md: true })
    const result = await fixture.cmd.status(null, fixture.projectPath, { md: true })
    expect(result.success).toBe(true)
    expect(result.complete).toBe(true)
  })

  test('status reports complete=false if any piece is missing', async () => {
    await fixture.cmd.install(null, fixture.projectPath, { md: true })
    await fs.rm(path.join(fixture.projectPath, '.claude/agents/leader.md'))
    const result = await fixture.cmd.status(null, fixture.projectPath, { md: true })
    expect(result.complete).toBe(false)
  })

  // === Regression tests for bugs surfaced during 2.3.x rollout ===

  test('install creates CLAUDE.md when it does not exist', async () => {
    // Bug guarded: pre-2.3.6 code crashed when CLAUDE.md was absent in the
    // project root. Fresh repos commonly have no CLAUDE.md yet.
    const result = await fixture.cmd.install(null, fixture.projectPath, { md: true })
    expect(result.success).toBe(true)

    const claudeMd = await fs.readFile(path.join(fixture.projectPath, 'CLAUDE.md'), 'utf-8')
    expect(claudeMd).toContain(SNIPPET_START)
    expect(claudeMd).toContain('Crew leader mode')
  })

  test('uninstall is robust when CLAUDE.md was deleted post-install', async () => {
    await fixture.cmd.install(null, fixture.projectPath, { md: true })
    await fs.rm(path.join(fixture.projectPath, 'CLAUDE.md'))

    const result = await fixture.cmd.uninstall(null, fixture.projectPath, { md: true })
    expect(result.success).toBe(true)

    // Agents still got removed; no crash.
    const leaderExists = await fs
      .access(path.join(fixture.projectPath, '.claude/agents/leader.md'))
      .then(() => true)
      .catch(() => false)
    expect(leaderExists).toBe(false)
  })

  test('install refreshes snippet block when user corrupts the heading', async () => {
    // Bug guarded: a user accidentally edits the snippet content (e.g. global
    // search-replace, manual mistake). Re-running install must restore the
    // canonical block, not append a second one.
    await fixture.cmd.install(null, fixture.projectPath, { md: true })
    const claudePath = path.join(fixture.projectPath, 'CLAUDE.md')
    const before = await fs.readFile(claudePath, 'utf-8')
    const corrupted = before.replace('Crew leader mode', 'CORRUPTED HEADING')
    await fs.writeFile(claudePath, corrupted, 'utf-8')

    await fixture.cmd.install(null, fixture.projectPath, { md: true })

    const after = await fs.readFile(claudePath, 'utf-8')
    expect(after).toContain('Crew leader mode')
    expect(after).not.toContain('CORRUPTED HEADING')
    // Still exactly one marker pair.
    const startMatches = after.match(/prjct:crew:start/g) ?? []
    expect(startMatches.length).toBe(1)
  })

  test('status detects tampered snippet (start marker removed, end remains)', async () => {
    await fixture.cmd.install(null, fixture.projectPath, { md: true })
    const claudePath = path.join(fixture.projectPath, 'CLAUDE.md')
    const orig = await fs.readFile(claudePath, 'utf-8')
    const broken = orig.replace(SNIPPET_START, '')
    await fs.writeFile(claudePath, broken, 'utf-8')

    const result = await fixture.cmd.status(null, fixture.projectPath, { md: true })
    expect(result.complete).toBe(false)
  })

  test('partial state can be repaired by re-running install', async () => {
    // Bug guarded: install must function as both initial-setup AND repair.
    await fixture.cmd.install(null, fixture.projectPath, { md: true })
    await fs.rm(path.join(fixture.projectPath, '.claude/agents/leader.md'))

    await fixture.cmd.install(null, fixture.projectPath, { md: true })

    const restored = await fs
      .access(path.join(fixture.projectPath, '.claude/agents/leader.md'))
      .then(() => true)
      .catch(() => false)
    expect(restored).toBe(true)
  })

  test('uninstall is robust against partial install state', async () => {
    await fixture.cmd.install(null, fixture.projectPath, { md: true })
    // Simulate the user manually deleting two of the three agents.
    await fs.rm(path.join(fixture.projectPath, '.claude/agents/leader.md'))
    await fs.rm(path.join(fixture.projectPath, '.claude/agents/reviewer.md'))

    const result = await fixture.cmd.uninstall(null, fixture.projectPath, { md: true })
    expect(result.success).toBe(true)

    // Remaining agent (implementer) and CHECKPOINTS were removed.
    const implExists = await fs
      .access(path.join(fixture.projectPath, '.claude/agents/implementer.md'))
      .then(() => true)
      .catch(() => false)
    expect(implExists).toBe(false)
    const cpExists = await fs
      .access(path.join(fixture.projectPath, '.prjct/CHECKPOINTS.md'))
      .then(() => true)
      .catch(() => false)
    expect(cpExists).toBe(false)
  })

  test('user content added AFTER the snippet block survives reinstall + uninstall', async () => {
    // Bug guarded: the snippet replacement must not mangle content the user
    // appends to CLAUDE.md after the marker block.
    await fs.writeFile(path.join(fixture.projectPath, 'CLAUDE.md'), '# project\n', 'utf-8')
    await fixture.cmd.install(null, fixture.projectPath, { md: true })

    const claudePath = path.join(fixture.projectPath, 'CLAUDE.md')
    const withTail = `${await fs.readFile(claudePath, 'utf-8')}\n## My post-block rules\nLint before commit\n`
    await fs.writeFile(claudePath, withTail, 'utf-8')

    // Reinstall: post-block content stays.
    await fixture.cmd.install(null, fixture.projectPath, { md: true })
    const installedClaude = await fs.readFile(claudePath, 'utf-8')
    expect(installedClaude).toContain('## My post-block rules')
    expect(installedClaude).toContain('Lint before commit')

    // Uninstall: markers go, post-block content stays.
    await fixture.cmd.uninstall(null, fixture.projectPath, { md: true })
    const uninstalledClaude = await fs.readFile(claudePath, 'utf-8')
    expect(uninstalledClaude).toContain('## My post-block rules')
    expect(uninstalledClaude).toContain('Lint before commit')
    expect(uninstalledClaude).not.toContain('prjct:crew')
  })
})
