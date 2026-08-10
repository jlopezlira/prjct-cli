import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import configManager from '../../infrastructure/config-manager'
import pathManager from '../../infrastructure/path-manager'
import { projectMemory } from '../../memory/project-memory'
import {
  bridgeStyleToMemory,
  getActiveProjectStyle,
  getProjectEvolution,
  persistProjectStyleSnapshot,
  recomputeProjectStyle,
  renderProjectEvolution,
} from '../../services/project-style-evolution'
import { buildProjectStyleSnapshot } from '../../services/project-style-profile'
import { prjctDb } from '../../storage/database'

async function freshProject(): Promise<{ projectPath: string; projectId: string }> {
  const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'prjct-style-evo-'))
  await fs.mkdir(path.join(projectPath, '.prjct'), { recursive: true })
  await fs.writeFile(
    path.join(projectPath, 'package.json'),
    JSON.stringify({
      name: 'style-evo-test',
      version: '1.0.0',
      dependencies: { hono: '4.0.0', zod: '3.0.0' },
      devDependencies: { typescript: '5.0.0', vitest: '2.0.0' },
    }),
    'utf-8'
  )
  await fs.writeFile(path.join(projectPath, 'tsconfig.json'), '{}', 'utf-8')
  await fs.writeFile(path.join(projectPath, 'bun.lock'), '', 'utf-8')
  const projectId = `test-style-${Math.random().toString(36).slice(2, 10)}`
  await configManager.writeConfig(projectPath, {
    projectId,
    dataPath: path.join(projectPath, '.prjct-data'),
  })
  await pathManager.ensureProjectStructure(projectId)
  return { projectPath, projectId }
}

function styleBridgeSnapshot() {
  const snapshot = buildProjectStyleSnapshot({
    stats: {
      fileCount: 10,
      version: '1.0.0',
      name: 'bridge-test',
      ecosystem: 'JavaScript',
      projectType: 'simple',
      languages: ['TypeScript'],
      frameworks: [],
    },
    stack: {
      hasFrontend: false,
      hasBackend: true,
      hasDatabase: false,
      hasDocker: false,
      hasTesting: true,
      frontendType: null,
      frameworks: ['Hono'],
    },
  })
  snapshot.payload.conventions = [
    { key: 'imports', rule: 'Use explicit module boundaries.', category: 'architecture' },
  ]
  snapshot.payload.patterns = [
    {
      key: 'services',
      name: 'Service boundary',
      description: 'Keep transport separate from domain behavior.',
      category: 'architecture',
    },
  ]
  snapshot.payload.antiPatterns = [
    {
      key: 'global-state',
      issue: 'Mutable global state',
      suggestion: 'Inject scoped dependencies',
      severity: 'high',
    },
  ]
  snapshot.conventionCount = snapshot.payload.conventions.length
  snapshot.patternCount = snapshot.payload.patterns.length
  snapshot.antiPatternCount = snapshot.payload.antiPatterns.length
  return snapshot
}

describe('project-style-evolution', () => {
  const fixture: {
    projectPath: string
    projectId: string
  } = {
    projectPath: '',
    projectId: '',
  }

  beforeEach(async () => {
    ;({ projectPath: fixture.projectPath, projectId: fixture.projectId } = await freshProject())
  })

  afterEach(async () => {
    if (fixture.projectPath) await fs.rm(fixture.projectPath, { recursive: true, force: true })
  })

  test('persist + getActive + evolution render', () => {
    const snap = buildProjectStyleSnapshot({
      stats: {
        fileCount: 10,
        version: '1.0.0',
        name: 't',
        ecosystem: 'JavaScript',
        projectType: 'simple',
        languages: ['TypeScript'],
        frameworks: [],
      },
      stack: {
        hasFrontend: false,
        hasBackend: true,
        hasDatabase: false,
        hasDocker: false,
        hasTesting: true,
        frontendType: null,
        frameworks: ['Hono'],
      },
      packageDeps: { hono: '4', zod: '3' },
      commitHash: 'abc1234',
    })
    persistProjectStyleSnapshot(fixture.projectId, snap)
    const active = getActiveProjectStyle(fixture.projectId)
    expect(active?.id).toBe(snap.id)
    expect(active?.payload.stack.frameworks).toContain('Hono')
    const evo = getProjectEvolution(fixture.projectId, 5)
    expect(evo.length).toBe(1)
    const md = renderProjectEvolution(fixture.projectId)
    expect(md).toContain('Project evolution')
  })

  test('recomputeProjectStyle on real package.json', async () => {
    const { detectStack, gatherStats, detectCommands } = await import(
      '../../services/sync-analyzer'
    )
    const [stats, stack, commands] = await Promise.all([
      gatherStats(fixture.projectPath),
      detectStack(fixture.projectPath),
      detectCommands(fixture.projectPath),
    ])
    const result = await recomputeProjectStyle({
      projectId: fixture.projectId,
      projectPath: fixture.projectPath,
      stats,
      stack,
      commands,
      commitHash: 'fff',
      bridgeMemory: false,
    })
    expect(result.isFirst).toBe(true)
    expect(result.snapshot.payload.stack.ecosystem).toBe('JavaScript')
    expect(result.snapshot.payload.stack.languages).toContain('TypeScript')
    // key libs from package.json
    expect(
      result.snapshot.payload.stack.keyLibraries.some((l) =>
        ['Hono', 'Zod', 'Vitest', 'TypeScript'].includes(l)
      )
    ).toBe(true)
    const active = getActiveProjectStyle(fixture.projectId)
    expect(active).not.toBeNull()

    // Second recompute without changes → no new history spam (still active)
    const again = await recomputeProjectStyle({
      projectId: fixture.projectId,
      projectPath: fixture.projectPath,
      stats,
      stack,
      commands,
      commitHash: 'fff',
      bridgeMemory: false,
    })
    expect(again.isFirst).toBe(false)
    expect(again.delta.hasChanges).toBe(false)
    expect(getProjectEvolution(fixture.projectId).length).toBe(1)
  })

  test('style memory bridge populates once and skips an identical second bridge', async () => {
    const snapshot = styleBridgeSnapshot()
    const remember = projectMemory.remember.bind(projectMemory)
    const rememberSpy = spyOn(projectMemory, 'remember').mockImplementation(remember)
    try {
      expect(await bridgeStyleToMemory(fixture.projectPath, fixture.projectId, snapshot)).toBe(3)
      expect(rememberSpy).toHaveBeenCalledTimes(3)
      const active = prjctDb.query<{ type: string; topic_key: string }>(
        fixture.projectId,
        `SELECT type, topic_key FROM memory_entries
         WHERE project_id = ? AND deleted_at IS NULL AND topic_key IN (?, ?, ?)`,
        fixture.projectId,
        'style:convention:imports',
        'style:pattern:services',
        'style:anti:global-state'
      )
      expect(active).toHaveLength(3)

      rememberSpy.mockClear()
      expect(await bridgeStyleToMemory(fixture.projectPath, fixture.projectId, snapshot)).toBe(0)
      expect(rememberSpy).toHaveBeenCalledTimes(0)
    } finally {
      rememberSpy.mockRestore()
    }
  })

  test('style memory bridge coalesces duplicate knowledge under different topics', async () => {
    const snapshot = styleBridgeSnapshot()
    snapshot.payload.conventions.push({
      key: 'module-boundaries',
      rule: snapshot.payload.conventions[0]!.rule,
      category: 'architecture',
    })
    snapshot.conventionCount = snapshot.payload.conventions.length

    expect(await bridgeStyleToMemory(fixture.projectPath, fixture.projectId, snapshot)).toBe(3)
    expect(await bridgeStyleToMemory(fixture.projectPath, fixture.projectId, snapshot)).toBe(0)

    const active = prjctDb.query<{ topic_key: string }>(
      fixture.projectId,
      `SELECT topic_key FROM memory_entries
       WHERE project_id = ? AND type = 'decision' AND deleted_at IS NULL
         AND content = ?`,
      fixture.projectId,
      'Use explicit module boundaries.'
    )
    expect(active).toEqual([{ topic_key: 'style:convention:imports' }])
  })

  test('style memory bridge reconciles exactly one changed topic', async () => {
    const snapshot = styleBridgeSnapshot()
    await bridgeStyleToMemory(fixture.projectPath, fixture.projectId, snapshot)
    const changed = structuredClone(snapshot)
    changed.payload.patterns[0]!.description = 'Use request-scoped service boundaries.'

    const remember = projectMemory.remember.bind(projectMemory)
    const rememberSpy = spyOn(projectMemory, 'remember').mockImplementation(remember)
    try {
      expect(await bridgeStyleToMemory(fixture.projectPath, fixture.projectId, changed)).toBe(1)
      expect(rememberSpy).toHaveBeenCalledTimes(1)
      const active = prjctDb.query<{ content: string }>(
        fixture.projectId,
        `SELECT content FROM memory_entries
         WHERE project_id = ? AND topic_key = ? AND deleted_at IS NULL`,
        fixture.projectId,
        'style:pattern:services'
      )
      expect(active).toHaveLength(1)
      expect(active[0]!.content).toContain('request-scoped service boundaries')
    } finally {
      rememberSpy.mockRestore()
    }
  })

  test('style memory bridge self-heals one missing active topic', async () => {
    const snapshot = styleBridgeSnapshot()
    await bridgeStyleToMemory(fixture.projectPath, fixture.projectId, snapshot)
    prjctDb.run(
      fixture.projectId,
      `UPDATE memory_entries SET deleted_at = ?
       WHERE project_id = ? AND topic_key = ? AND deleted_at IS NULL`,
      Date.now(),
      fixture.projectId,
      'style:convention:imports'
    )

    const remember = projectMemory.remember.bind(projectMemory)
    const rememberSpy = spyOn(projectMemory, 'remember').mockImplementation(remember)
    try {
      expect(await bridgeStyleToMemory(fixture.projectPath, fixture.projectId, snapshot)).toBe(1)
      expect(rememberSpy).toHaveBeenCalledTimes(1)
      const active = prjctDb.query<{ content: string }>(
        fixture.projectId,
        `SELECT content FROM memory_entries
         WHERE project_id = ? AND topic_key = ? AND deleted_at IS NULL`,
        fixture.projectId,
        'style:convention:imports'
      )
      expect(active).toEqual([{ content: 'Use explicit module boundaries.' }])
    } finally {
      rememberSpy.mockRestore()
    }
  })

  test('style memory bridge repairs a legacy active row without topic_key', async () => {
    const snapshot = styleBridgeSnapshot()
    await bridgeStyleToMemory(fixture.projectPath, fixture.projectId, snapshot)
    prjctDb.run(
      fixture.projectId,
      `UPDATE memory_entries SET topic_key = NULL
       WHERE project_id = ? AND topic_key = ? AND deleted_at IS NULL`,
      fixture.projectId,
      'style:anti:global-state'
    )

    const remember = projectMemory.remember.bind(projectMemory)
    const rememberSpy = spyOn(projectMemory, 'remember').mockImplementation(remember)
    try {
      expect(await bridgeStyleToMemory(fixture.projectPath, fixture.projectId, snapshot)).toBe(1)
      expect(rememberSpy).toHaveBeenCalledTimes(1)
      const repaired = prjctDb.query<{ topic_key: string }>(
        fixture.projectId,
        `SELECT topic_key FROM memory_entries
         WHERE project_id = ? AND type = ? AND deleted_at IS NULL`,
        fixture.projectId,
        'anti-pattern'
      )
      expect(repaired).toEqual([{ topic_key: 'style:anti:global-state' }])
    } finally {
      rememberSpy.mockRestore()
    }
  })
})
