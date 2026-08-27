import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { indexProject } from '../../domain/bm25'
import pathManager from '../../infrastructure/path-manager'
import { buildAnalysisPayload } from '../../services/analysis-payload-builder'
import prjctDb from '../../storage/database'
import type { GitData, ProjectStats } from '../../types/project-sync'

const stats: ProjectStats = {
  fileCount: 7,
  version: '1.0.0',
  name: 'pattern-samples',
  ecosystem: 'JavaScript',
  projectType: 'complex',
  languages: ['TypeScript'],
  frameworks: [],
}

const git: GitData = {
  branch: 'main',
  commits: 1,
  contributors: 1,
  hasChanges: false,
  stagedFiles: [],
  modifiedFiles: [],
  untrackedFiles: [],
  weeklyCommits: 1,
  recentCommits: [{ hash: 'abc', message: 'seed', date: '2026-08-27' }],
}

describe('analysis payload pattern sampling', () => {
  let projectPath = ''
  let projectId = ''

  beforeEach(async () => {
    projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'prjct-analysis-payload-'))
    projectId = `analysis-payload-${crypto.randomUUID()}`
    await pathManager.ensureProjectStructure(projectId)
    const files: Record<string, string> = {
      'src/router.ts': 'export function routeHandler() { return commandService() }',
      'src/service.ts': 'export function commandService() { return runDomainWorkflow() }',
      'src/storage.ts': 'export function saveRepository() { return databaseTransaction() }',
      'src/errors.ts':
        'export function normalizeError(error: Error) { return validationResult(error) }',
      'src/config.ts': 'export const defaultSettings = { timeout: 10 }',
      'src/provider.ts': 'export class ApiProvider { request() { return gatewayClient() } }',
      'src/service.test.ts':
        'describe("service", () => { expect(commandService()).toBeDefined() })',
    }
    for (const [file, content] of Object.entries(files)) {
      await fs.mkdir(path.dirname(path.join(projectPath, file)), { recursive: true })
      await fs.writeFile(path.join(projectPath, file), content)
    }
    await indexProject(projectPath, projectId)
  })

  afterEach(async () => {
    prjctDb.close()
    if (projectPath) await fs.rm(projectPath, { recursive: true, force: true })
  })

  it('collects unique canonical samples across multiple pattern lanes within a fixed budget', async () => {
    const payload = await buildAnalysisPayload(projectId, projectPath, git, stats)
    const lanes = payload.codeSamples.map((sample) => sample.reason)

    expect(new Set(payload.codeSamples.map((sample) => sample.path)).size).toBe(
      payload.codeSamples.length
    )
    expect(lanes.some((reason) => reason.includes('data-access'))).toBe(true)
    expect(lanes.some((reason) => reason.includes('testing'))).toBe(true)
    expect(
      payload.codeSamples.reduce((sum, sample) => sum + sample.content.length, 0)
    ).toBeLessThanOrEqual(9 * 730)
  })
})
