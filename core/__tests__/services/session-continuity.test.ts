/**
 * Managed session continuity — land stamp → prime resume card.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import configManager from '../../infrastructure/config-manager'
import pathManager from '../../infrastructure/path-manager'
import {
  CONTINUITY_FRESH_MS,
  formatContinuitySessionCue,
  formatLandContinuityFooter,
  formatSessionResumeCard,
  isContinuityFresh,
  loadSessionContinuity,
  SESSION_CONTINUITY_KEY,
  type SessionContinuityStamp,
  stampSessionContinuity,
} from '../../services/session-continuity'
import prjctDb from '../../storage/database'

const fixture: {
  projectPath: string
  projectId: string
} = {
  projectPath: '',
  projectId: '',
}

async function freshProject(): Promise<void> {
  fixture.projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'prjct-continuity-'))
  await fs.mkdir(path.join(fixture.projectPath, '.prjct'), { recursive: true })
  fixture.projectId = `continuity-${crypto.randomUUID()}`
  await configManager.writeConfig(fixture.projectPath, {
    projectId: fixture.projectId,
    dataPath: path.join(fixture.projectPath, '.prjct-data'),
  } as Parameters<typeof configManager.writeConfig>[1])
  await pathManager.ensureProjectStructure(fixture.projectId)
}

beforeEach(async () => {
  prjctDb.close()
  await freshProject()
})

afterEach(async () => {
  if (fixture.projectPath) {
    await fs.rm(fixture.projectPath, { recursive: true, force: true }).catch(() => {})
  }
  prjctDb.close()
})

describe('stampSessionContinuity / loadSessionContinuity', () => {
  it('round-trips stamp to kv SoT', () => {
    const stamp = stampSessionContinuity({
      projectId: fixture.projectId,
      projectPath: fixture.projectPath,
      cycleId: 'task-abc',
      cycleDescription: 'wire session continuity',
      turns: 8,
      tokensIn: 1000,
      tokensOut: 500,
      handoffWrote: true,
      receiptWrote: false,
      handoffContent: 'Session close: Work cycle "wire session continuity" still open.',
    })
    expect(stamp.version).toBe(1)
    expect(stamp.projectId).toBe(fixture.projectId)
    expect(stamp.cycleDescription).toContain('session continuity')
    expect(stamp.handoffPreview).toMatch(/Session close/)
    expect(stamp.nextActions.length).toBeGreaterThan(0)

    const loaded = loadSessionContinuity(fixture.projectId)
    expect(loaded).not.toBeNull()
    expect(loaded!.landedAt).toBe(stamp.landedAt)
    expect(loaded!.cycleId).toBe('task-abc')
    expect(prjctDb.getDoc(fixture.projectId, SESSION_CONTINUITY_KEY)).toBeTruthy()
  })

  it('isContinuityFresh respects 7d window', () => {
    const fresh: SessionContinuityStamp = {
      version: 1,
      landedAt: new Date().toISOString(),
      projectId: fixture.projectId,
      cycleId: null,
      cycleDescription: null,
      turns: null,
      tokensIn: null,
      tokensOut: null,
      pressureLevel: null,
      handoffWrote: false,
      receiptWrote: false,
      nextActions: [],
      handoffPreview: null,
    }
    expect(isContinuityFresh(fresh)).toBe(true)
    const old = {
      ...fresh,
      landedAt: new Date(Date.now() - CONTINUITY_FRESH_MS - 1000).toISOString(),
    }
    expect(isContinuityFresh(old)).toBe(false)
    expect(isContinuityFresh(null)).toBe(false)
  })
})

describe('formatSessionResumeCard', () => {
  it('renders managed session header and next actions', () => {
    const stamp = stampSessionContinuity({
      projectId: fixture.projectId,
      projectPath: fixture.projectPath,
      cycleDescription: 'resume test',
      handoffWrote: true,
      handoffContent: 'Session close: resume test hand-off body for next agent.',
    })
    const md = formatSessionResumeCard({
      stamp,
      liveCycleDescription: 'resume test',
      journal: ['tried X', 'blocked on Y'],
      sessionCloseContent: stamp.handoffPreview,
    })
    expect(md).toContain('# Managed session resume')
    expect(md).toContain('resume test')
    expect(md).toContain('Journal')
    expect(md).toContain('Next actions')
    expect(md).toContain('Context diet')
    expect(md).toMatch(/L0/)
  })

  it('handles missing stamp without throwing', () => {
    const md = formatSessionResumeCard({ stamp: null })
    expect(md).toContain('No land stamp yet')
  })
})

describe('formatContinuitySessionCue / land footer', () => {
  it('SessionStart cue only when fresh', () => {
    const stamp = stampSessionContinuity({
      projectId: fixture.projectId,
      projectPath: fixture.projectPath,
      cycleDescription: 'open cycle',
      handoffWrote: true,
    })
    const cue = formatContinuitySessionCue(stamp)
    expect(cue).toMatch(/managed session continuity/i)
    expect(cue).toMatch(/prjct prime/)
  })

  it('land footer points at prime', () => {
    const stamp = stampSessionContinuity({
      projectId: fixture.projectId,
      projectPath: fixture.projectPath,
      cycleDescription: 'x',
    })
    const footer = formatLandContinuityFooter(stamp)
    expect(footer).toContain('Managed session continuity')
    expect(footer).toContain('prjct prime')
    expect(footer).toContain(SESSION_CONTINUITY_KEY)
  })
})
