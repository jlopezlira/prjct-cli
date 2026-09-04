import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { _internal, runPreSearchHook } from '../../hooks/pre-search'
import configManager from '../../infrastructure/config-manager'
import { advanceSessionTurn } from '../../services/session-context-cache'

const fixture = { projectPath: '', projectId: '' }

beforeEach(async () => {
  fixture.projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'prjct-pre-search-test-'))
  fixture.projectId = `pre-search-${crypto.randomUUID()}`
  await fs.mkdir(path.join(fixture.projectPath, '.prjct'), { recursive: true })
  await configManager.writeConfig(fixture.projectPath, {
    projectId: fixture.projectId,
    dataPath: path.join(fixture.projectPath, '.prjct-data'),
  } as Parameters<typeof configManager.writeConfig>[1])
})

afterEach(async () => {
  await fs.rm(fixture.projectPath, { recursive: true, force: true })
})

async function runSearch(sessionId?: string): Promise<string> {
  const chunks: string[] = []
  await runPreSearchHook(fixture.projectPath, {
    input: { tool_name: 'Grep', tool_input: { pattern: 'validateUser' }, session_id: sessionId },
    sink: (chunk) => chunks.push(chunk),
    detachAfterEmit: () => {},
  })
  return chunks.join('')
}

describe('pre-search extractToken', () => {
  it('pulls longest identifier from grep pattern', () => {
    expect(_internal.extractToken({ tool_input: { pattern: 'validateUser' } })).toBe('validateUser')
    expect(_internal.extractToken({ tool_input: { pattern: 'function\\s+ProcessOrder\\(' } })).toBe(
      'ProcessOrder'
    )
  })

  it('returns null for empty / noise-only', () => {
    expect(_internal.extractToken({ tool_input: { pattern: '.*' } })).toBeNull()
    expect(_internal.extractToken({ tool_input: {} })).toBeNull()
  })
})

describe('pre-search session rollover', () => {
  it('cuts tree search at the limit and resets for a new or unidentified session', async () => {
    await configManager.writeConfig(fixture.projectPath, {
      projectId: fixture.projectId,
      dataPath: path.join(fixture.projectPath, '.prjct-data'),
      maxTurnsPerSession: 2,
    } as Parameters<typeof configManager.writeConfig>[1])
    const input = {
      projectId: fixture.projectId,
      projectPath: fixture.projectPath,
      sessionId: 'marathon-session',
    }
    await advanceSessionTurn(input)
    await advanceSessionTurn(input)

    expect(await runSearch(input.sessionId)).toContain('SESSION ROLLOVER REQUIRED')
    expect(await runSearch('fresh-session')).not.toContain('SESSION ROLLOVER REQUIRED')
    expect(await runSearch()).not.toContain('SESSION ROLLOVER REQUIRED')
  })
})
