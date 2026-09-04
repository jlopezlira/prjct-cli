import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { buildSessionContext } from '../../hooks/session-start'
import configManager, {
  ProjectSettingsConflictError,
  ProjectSettingsError,
  ProjectSettingsMigrationRequiredError,
} from '../../infrastructure/config-manager'

describe('global project settings authority', () => {
  const fixture = { projectPath: '', projectId: '' }

  beforeEach(async () => {
    fixture.projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'prjct-global-settings-'))
    fixture.projectId = `global-settings-${crypto.randomUUID()}`
  })

  afterEach(async () => {
    await fs.rm(fixture.projectPath, { recursive: true, force: true })
    await fs.rm(path.dirname(configManager.getProjectSettingsPath(fixture.projectId)), {
      recursive: true,
      force: true,
    })
  })

  test('keeps only the stable locator in the client repository', async () => {
    const { projectId, projectPath } = fixture
    await configManager.writeConfig(projectPath, {
      projectId,
      dataPath: `/global/${projectId}`,
      persona: { role: 'DEV', packs: ['code'] },
      qa: { mode: 'strict' },
    })

    const locatorPath = path.join(projectPath, '.prjct', 'prjct.config.json')
    const locatorBefore = await fs.readFile(locatorPath, 'utf8')
    expect(JSON.parse(locatorBefore)).toEqual({ projectId, dataPath: `/global/${projectId}` })

    const global = JSON.parse(
      await fs.readFile(configManager.getProjectSettingsPath(projectId), 'utf8')
    )
    expect(global).toEqual({ persona: { role: 'DEV', packs: ['code'] }, qa: { mode: 'strict' } })

    await configManager.writeConfig(projectPath, {
      ...(await configManager.readConfig(projectPath))!,
      qa: { mode: 'advisory' },
    })
    expect(await fs.readFile(locatorPath, 'utf8')).toBe(locatorBefore)
    expect((await configManager.readConfig(projectPath))?.qa?.mode).toBe('advisory')
  })

  test('global settings override stale mutable client fields', async () => {
    const { projectId, projectPath } = fixture
    await configManager.writeConfig(projectPath, {
      projectId,
      dataPath: `/global/${projectId}`,
      tdd: { mode: 'strict' },
    })
    await fs.writeFile(
      path.join(projectPath, '.prjct', 'prjct.config.json'),
      `${JSON.stringify({
        projectId,
        dataPath: `/global/${projectId}`,
        tdd: { mode: 'off' },
      })}\n`
    )

    expect((await configManager.readConfig(projectPath))?.tdd?.mode).toBe('strict')
  })

  test('detects external locator replacement and deletion immediately', async () => {
    const { projectId, projectPath } = fixture
    await configManager.writeConfig(projectPath, {
      projectId,
      dataPath: `/global/${projectId}`,
    })
    expect((await configManager.readConfig(projectPath))?.projectId).toBe(projectId)

    const replacementId = `${projectId}-replacement`
    const locatorPath = path.join(projectPath, '.prjct', 'prjct.config.json')
    await fs.writeFile(
      locatorPath,
      `${JSON.stringify({ projectId: replacementId, dataPath: `/global/${replacementId}` })}\n`
    )
    expect((await configManager.readConfig(projectPath))?.projectId).toBe(replacementId)

    await fs.rm(locatorPath)
    expect(await configManager.readConfig(projectPath)).toBeNull()
  })

  test('migrates legacy mutable settings globally before reducing the locator', async () => {
    const { projectId, projectPath } = fixture
    const locatorPath = path.join(projectPath, '.prjct', 'prjct.config.json')
    await fs.mkdir(path.dirname(locatorPath), { recursive: true })
    await fs.writeFile(
      locatorPath,
      `${JSON.stringify({
        projectId,
        dataPath: `/global/${projectId}`,
        sdd: { mode: 'advisory' },
        gauntlet: { commands: [{ kind: 'test', command: 'bun test' }] },
      })}\n`
    )

    expect(await configManager.migrateLegacyProjectSettings(projectPath)).toBe(true)
    expect(await configManager.migrateLegacyProjectSettings(projectPath)).toBe(false)

    expect(JSON.parse(await fs.readFile(locatorPath, 'utf8'))).toEqual({
      projectId,
      dataPath: `/global/${projectId}`,
    })
    expect(
      JSON.parse(await fs.readFile(configManager.getProjectSettingsPath(projectId), 'utf8'))
    ).toMatchObject({
      sdd: { mode: 'advisory' },
      gauntlet: { commands: [{ kind: 'test', command: 'bun test' }] },
    })
  })

  test('rejects a committed projectId before it can escape the global project directory', async () => {
    const locatorPath = path.join(fixture.projectPath, '.prjct', 'prjct.config.json')
    await fs.mkdir(path.dirname(locatorPath), { recursive: true })
    await fs.writeFile(
      locatorPath,
      `${JSON.stringify({
        projectId: '../escape-target',
        dataPath: '/global/escape-target',
        qa: { mode: 'strict' },
      })}\n`
    )

    expect(() => configManager.getProjectSettingsPath('../escape-target')).toThrow(
      'Invalid projectId'
    )
    await expect(configManager.migrateLegacyProjectSettings(fixture.projectPath)).rejects.toThrow(
      'Invalid projectId'
    )
    expect(await configManager.getProjectId(fixture.projectPath)).toBe('')
  })

  test('preserves independent concurrent settings updates across worktrees', async () => {
    const { projectId, projectPath } = fixture
    await configManager.writeConfig(projectPath, {
      projectId,
      dataPath: `/global/${projectId}`,
    })
    const safetyUpdate = {
      ...(await configManager.readConfig(projectPath))!,
      delivery: { killSwitch: 'on' as const },
    }
    const qaUpdate = {
      ...(await configManager.readConfig(projectPath))!,
      qa: { mode: 'strict' as const },
    }

    await Promise.all([
      configManager.writeConfig(projectPath, safetyUpdate),
      configManager.writeConfig(projectPath, qaUpdate),
    ])

    expect(await configManager.readConfig(projectPath)).toMatchObject({
      delivery: { killSwitch: 'on' },
      qa: { mode: 'strict' },
    })
  })

  test('fails loudly instead of losing concurrent updates to the same settings array', async () => {
    const { projectId, projectPath } = fixture
    await configManager.writeConfig(projectPath, {
      projectId,
      dataPath: `/global/${projectId}`,
      gauntlet: { commands: [] },
    })
    const testUpdate = {
      ...(await configManager.readConfig(projectPath))!,
      gauntlet: { commands: [{ kind: 'test' as const, command: 'bun test' }] },
    }
    const lintUpdate = {
      ...(await configManager.readConfig(projectPath))!,
      gauntlet: { commands: [{ kind: 'lint' as const, command: 'bun run check' }] },
    }

    const results = await Promise.allSettled([
      configManager.writeConfig(projectPath, testUpdate),
      configManager.writeConfig(projectPath, lintUpdate),
    ])
    const rejected = results.filter((result) => result.status === 'rejected')
    expect(rejected).toHaveLength(1)
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(
      ProjectSettingsConflictError
    )

    const current = (await configManager.readConfig(projectPath))!
    const commands = current.gauntlet?.commands ?? []
    const missing =
      commands[0]?.kind === 'test'
        ? lintUpdate.gauntlet.commands[0]!
        : testUpdate.gauntlet.commands[0]!
    await configManager.writeConfig(projectPath, {
      ...current,
      gauntlet: { commands: [...commands, missing] },
    })
    expect((await configManager.readConfig(projectPath))?.gauntlet?.commands).toHaveLength(2)
  })

  test('merges concurrent legacy migrations instead of replacing safety settings', async () => {
    const { projectId, projectPath } = fixture
    const siblingPath = await fs.mkdtemp(path.join(os.tmpdir(), 'prjct-global-settings-sibling-'))
    try {
      for (const [root, settings] of [
        [projectPath, { delivery: { killSwitch: 'on' } }],
        [siblingPath, { qa: { mode: 'strict' } }],
      ] as const) {
        const locatorPath = path.join(root, '.prjct', 'prjct.config.json')
        await fs.mkdir(path.dirname(locatorPath), { recursive: true })
        await fs.writeFile(
          locatorPath,
          `${JSON.stringify({ projectId, dataPath: `/global/${projectId}`, ...settings })}\n`
        )
      }

      await Promise.all([
        configManager.migrateLegacyProjectSettings(projectPath),
        configManager.migrateLegacyProjectSettings(siblingPath),
      ])

      expect(await configManager.readConfig(projectPath)).toMatchObject({
        delivery: { killSwitch: 'on' },
        qa: { mode: 'strict' },
      })
    } finally {
      await fs.rm(siblingPath, { recursive: true, force: true })
    }
  })

  test('keeps locator identity available when global settings are malformed', async () => {
    const { projectId, projectPath } = fixture
    await configManager.writeConfig(projectPath, {
      projectId,
      dataPath: `/global/${projectId}`,
      qa: { mode: 'strict' },
    })
    const settingsPath = configManager.getProjectSettingsPath(projectId)
    await fs.writeFile(settingsPath, '{ malformed')

    expect(await configManager.getProjectId(projectPath)).toBe(projectId)
    await expect(configManager.readConfig(projectPath)).rejects.toBeInstanceOf(ProjectSettingsError)
  })

  test('recovers legacy settings from git history after another machine normalizes the locator', async () => {
    const { projectId, projectPath } = fixture
    const locatorPath = path.join(projectPath, '.prjct', 'prjct.config.json')
    await fs.mkdir(path.dirname(locatorPath), { recursive: true })
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: projectPath })
    execFileSync('git', ['config', 'user.email', 'test@prjct.local'], { cwd: projectPath })
    execFileSync('git', ['config', 'user.name', 'test'], { cwd: projectPath })
    await fs.writeFile(
      locatorPath,
      `${JSON.stringify({
        projectId,
        dataPath: `/global/${projectId}`,
        delivery: { killSwitch: 'on' },
        qa: { mode: 'strict' },
      })}\n`
    )
    execFileSync('git', ['add', '.'], { cwd: projectPath })
    execFileSync('git', ['commit', '-q', '-m', 'legacy settings'], { cwd: projectPath })

    await fs.writeFile(
      locatorPath,
      `${JSON.stringify({ projectId, dataPath: `/global/${projectId}` })}\n`
    )
    execFileSync('git', ['add', '.'], { cwd: projectPath })
    execFileSync('git', ['commit', '-q', '-m', 'normalize locator'], { cwd: projectPath })

    await expect(configManager.migrateLegacyProjectSettings(projectPath)).rejects.toBeInstanceOf(
      ProjectSettingsMigrationRequiredError
    )
    expect(await configManager.previewLegacyProjectSettings(projectPath)).toMatchObject({
      delivery: { killSwitch: 'on' },
      qa: { mode: 'strict' },
    })
    expect(
      await configManager.migrateLegacyProjectSettings(projectPath, { allowGitRecovery: true })
    ).toBe(true)
    expect(await configManager.readConfig(projectPath)).toMatchObject({
      delivery: { killSwitch: 'on' },
      qa: { mode: 'strict' },
    })
  })

  test('non-prompt settings do not change the cacheable SessionStart bytes', async () => {
    const { projectId, projectPath } = fixture
    await configManager.writeConfig(projectPath, {
      projectId,
      dataPath: `/global/${projectId}`,
      persona: { role: 'DEV', packs: ['code'] },
      qa: { mode: 'advisory' },
    })
    const before = await buildSessionContext(projectPath)

    await configManager.writeConfig(projectPath, {
      ...(await configManager.readConfig(projectPath))!,
      qa: { mode: 'strict' },
      maxTurnsPerSession: 100,
    })

    expect(await buildSessionContext(projectPath)).toBe(before)
  })
})
