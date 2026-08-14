/**
 * Stop hook transcript gating — the per-turn cost contract.
 *
 * Claude Code fires Stop after EVERY assistant turn, and the session
 * transcript JSONL grows unbounded (multi-MB by mid-session). Reading and
 * parsing it per turn is O(n²) over a session and, in the warm daemon,
 * blocks the single-threaded event loop that also serves the synchronous
 * prompt/pre-edit hooks. Transcript-dependent work is therefore gated
 * behind the 10-min heavy-step cooldown (stop.ts): a non-due Stop must
 * not touch the transcript at all.
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { heavyStepStampPath, runStopHook } from '../../hooks/stop'

const fixture: { cliHome: string; projectDir: string; prevHome?: string } = {
  cliHome: '',
  projectDir: '',
}

function freshProjectId(): string {
  return `test-stop-gating-${Math.random().toString(36).slice(2, 10)}`
}

async function writeProjectConfig(projectId: string): Promise<void> {
  await fs.mkdir(path.join(fixture.projectDir, '.prjct'), { recursive: true })
  await fs.writeFile(
    path.join(fixture.projectDir, '.prjct', 'prjct.config.json'),
    JSON.stringify({ projectId })
  )
}

/** Run the Stop hook and its detached afterEmit to completion. */
async function runStop(input: { transcript_path?: string; session_id?: string }): Promise<void> {
  const box: { fn: (() => Promise<void>) | null } = { fn: null }
  await runStopHook(fixture.projectDir, {
    input,
    sink: () => {},
    detachAfterEmit: (fn) => {
      box.fn = fn
    },
  })
  if (box.fn) await box.fn()
}

beforeEach(async () => {
  fixture.cliHome = await fs.mkdtemp(path.join(os.tmpdir(), 'prjct-stop-gating-home-'))
  fixture.projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'prjct-stop-gating-proj-'))
  fixture.prevHome = process.env.PRJCT_CLI_HOME
  process.env.PRJCT_CLI_HOME = fixture.cliHome
})

afterEach(async () => {
  if (fixture.prevHome === undefined) delete process.env.PRJCT_CLI_HOME
  else process.env.PRJCT_CLI_HOME = fixture.prevHome
  await fs.rm(fixture.cliHome, { recursive: true, force: true })
  await fs.rm(fixture.projectDir, { recursive: true, force: true })
})

describe('Stop hook transcript gating', () => {
  test('a Stop with heavy steps due reads the transcript', async () => {
    const projectId = freshProjectId()
    await writeProjectConfig(projectId)
    const transcriptPath = path.join(fixture.projectDir, 'transcript.jsonl')
    await fs.writeFile(transcriptPath, `${JSON.stringify({ type: 'assistant' })}\n`)

    const spy = spyOn(fs, 'readFile')
    try {
      await runStop({ transcript_path: transcriptPath, session_id: 'sess-due' })
      const transcriptReads = spy.mock.calls.filter((call) => call[0] === transcriptPath)
      expect(transcriptReads.length).toBeGreaterThan(0)
    } finally {
      spy.mockRestore()
    }
  })

  test('a Stop inside the cooldown never reads the transcript', async () => {
    const projectId = freshProjectId()
    await writeProjectConfig(projectId)
    // Simulate a recent heavy-step claim (as a previous Stop would leave it).
    const stamp = heavyStepStampPath(projectId)
    await fs.mkdir(path.dirname(stamp), { recursive: true })
    await fs.writeFile(stamp, String(Date.now()))

    const transcriptPath = path.join(fixture.projectDir, 'transcript.jsonl')
    await fs.writeFile(transcriptPath, `${JSON.stringify({ type: 'assistant' })}\n`)

    const spy = spyOn(fs, 'readFile')
    try {
      await runStop({ transcript_path: transcriptPath, session_id: 'sess-cooldown' })
      const transcriptReads = spy.mock.calls.filter((call) => call[0] === transcriptPath)
      expect(transcriptReads).toHaveLength(0)
    } finally {
      spy.mockRestore()
    }
  })
})
