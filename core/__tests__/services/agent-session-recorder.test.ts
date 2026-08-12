import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import configManager from '../../infrastructure/config-manager'
import pathManager from '../../infrastructure/path-manager'
import {
  recordAgentSessionEnd,
  recordAgentSessionStart,
} from '../../services/agent-session-recorder'
import { prjctDb } from '../../storage/database'

const fixture: {
  projectPath: string
  tmpRoot: string
  projectId: string
} = {
  projectPath: '',
  tmpRoot: '',
  projectId: '',
}

const originalGetGlobalProjectPath = pathManager.getGlobalProjectPath.bind(pathManager)

interface SessionRow {
  id: string
  task_id: string | null
  ended_at: string | null
  summary: string | null
  files_touched: string | null
  runtime: string
  model: string
}

describe('agent session recorder', () => {
  beforeEach(async () => {
    fixture.tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'prjct-agent-session-root-'))
    fixture.projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'prjct-agent-session-project-'))
    fixture.projectId = `agent-session-${Math.random().toString(36).slice(2, 10)}`
    pathManager.getGlobalProjectPath = (id: string) => path.join(fixture.tmpRoot, id)
    await configManager.writeConfig(fixture.projectPath, {
      projectId: fixture.projectId,
      dataPath: path.join(fixture.tmpRoot, 'data'),
    })
    prjctDb.getDb(fixture.projectId)
  })

  afterEach(async () => {
    prjctDb.close()
    pathManager.getGlobalProjectPath = originalGetGlobalProjectPath
    await fs.rm(fixture.projectPath, { recursive: true, force: true })
    await fs.rm(fixture.tmpRoot, { recursive: true, force: true })
  })

  it('records start and end metadata without raw transcript content', () => {
    recordAgentSessionStart({
      projectId: fixture.projectId,
      sessionId: 'session-1',
      directory: fixture.projectPath,
      goal: 'startup',
    })
    recordAgentSessionEnd({
      projectId: fixture.projectId,
      sessionId: 'session-1',
      directory: fixture.projectPath,
      taskId: 'task-1',
      goal: 'Fix attribution',
      tokensIn: 1200,
      tokensOut: 300,
      agent: 'claude',
      model: 'claude-opus-5',
      filesTouched: ['core/commands/product.ts'],
    })

    const row = prjctDb.get<SessionRow>(
      fixture.projectId,
      'SELECT id, task_id, ended_at, summary, files_touched, runtime, model FROM agent_sessions WHERE id = ?',
      'session-1'
    )

    expect(row?.id).toBe('session-1')
    expect(row?.task_id).toBe('task-1')
    expect(row?.ended_at).toBeTruthy()
    expect(row?.summary).toContain('agent=claude')
    expect(row?.summary).toContain('tokens_in=1200')
    expect(row?.summary).not.toContain('Fix attribution')
    expect(row?.files_touched).toContain('core/commands/product.ts')
    expect(row?.runtime).toBe('claude')
    expect(row?.model).toBe('claude-opus-5')
  })
})
