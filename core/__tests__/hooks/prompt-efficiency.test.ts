import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  _resetGitSnapshotCacheForTests,
  buildProjectState,
  runPromptHook,
} from '../../hooks/prompt'
import configManager from '../../infrastructure/config-manager'
import pathManager from '../../infrastructure/path-manager'
import { projectMemory } from '../../memory/project-memory'
import prjctDb from '../../storage/database'
import { execFileAsync } from '../../utils/exec'

const fixture = { projectPath: '', projectId: '' }
async function git(...args: string[]): Promise<void> {
  await execFileAsync('git', args, { cwd: fixture.projectPath })
}

beforeEach(async () => {
  fixture.projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'prjct-prompt-efficiency-'))
  fixture.projectId = `prompt-efficiency-${crypto.randomUUID()}`
  await configManager.writeConfig(fixture.projectPath, {
    projectId: fixture.projectId,
    dataPath: path.join(fixture.projectPath, '.prjct-data'),
  } as Parameters<typeof configManager.writeConfig>[1])
  await pathManager.ensureProjectStructure(fixture.projectId)
  await git('init', '-q', '-b', 'main')
  await git('config', 'user.email', 'test@example.com')
  await git('config', 'user.name', 'Test')
  await git('config', 'commit.gpgsign', 'false')
  await fs.writeFile(path.join(fixture.projectPath, 'app.ts'), 'export const app = 1\n')
  await git('add', '.')
  await git('commit', '-qm', 'seed')
  _resetGitSnapshotCacheForTests()
})
afterEach(async () => {
  prjctDb.close()
  await fs.rm(fixture.projectPath, { recursive: true, force: true })
})

describe('prompt Git snapshot', () => {
  it('distinguishes an unstaged first entry from staged changes', async () => {
    await fs.appendFile(path.join(fixture.projectPath, 'app.ts'), '// changed\n')
    const unstaged = await buildProjectState(fixture.projectPath)
    expect(unstaged).toContain('working tree 1 modified')
    expect(unstaged).not.toContain('staged')
    await git('add', 'app.ts')
    _resetGitSnapshotCacheForTests()
    const staged = await buildProjectState(fixture.projectPath)
    expect(staged).toContain('working tree 1 staged')
    expect(staged).not.toContain('modified')
  })
  it('counts renamed, partly staged and quoted untracked paths once', async () => {
    await git('mv', 'app.ts', 'renamed.ts')
    await fs.appendFile(path.join(fixture.projectPath, 'renamed.ts'), '// unstaged\n')
    await fs.writeFile(path.join(fixture.projectPath, 'space and\nnewline.ts'), 'export {}\n')
    expect(await buildProjectState(fixture.projectPath)).toContain(
      'working tree 1 modified, 1 staged, 1 untracked'
    )
  })
  it('includes ahead count from the same status snapshot', async () => {
    await git('config', 'status.aheadBehind', 'false')
    await git('branch', 'upstream')
    await git('branch', '--set-upstream-to=upstream', 'main')
    await git('commit', '--allow-empty', '-qm', 'ahead')
    expect(await buildProjectState(fixture.projectPath)).toContain('Branch: main — 1 unpushed')
  })
  it('preserves detached HEAD silence', async () => {
    await git('checkout', '--detach', '-q')
    expect((await buildProjectState(fixture.projectPath)) ?? '').not.toContain('Branch:')
  })
})

describe('prompt guidance retrieval', () => {
  for (const sessionId of ['efficiency-session', undefined]) {
    it(`retrieves guidance once while repacking a repeated route (${sessionId ?? 'sessionless'})`, async () => {
      const search = spyOn(projectMemory, 'searchFts')
      try {
        for (const prompt of [
          'fix authentication bug',
          'fix authentication bug',
          'authentication',
        ]) {
          search.mockClear()
          await runPromptHook(fixture.projectPath, {
            input: { prompt, session_id: sessionId },
            hookHost: 'codex',
            sink: () => {},
            detachAfterEmit: () => {},
          })
          expect(search.mock.calls.filter((call) => call[2] === 16)).toHaveLength(1)
        }
      } finally {
        search.mockRestore()
      }
    })
  }
})
