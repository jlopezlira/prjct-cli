import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import configManager from '../../infrastructure/config-manager'
import { getQaPlan, upsertQaPlan } from '../../services/qa-plan'
import {
  detectQaCandidates,
  ensureShipQa,
  qaBootstrapCue,
  readQaReceipt,
  renderQaReceiptMd,
  runQa,
  setQaValue,
} from '../../services/qa-runner'
import prjctDb from '../../storage/database'
import type { LocalConfig } from '../../types/config'
import { execFileAsync } from '../../utils/exec'
import { patchPathManager, restorePathManager } from '../_setup/path-manager-mock'

const fixture: { tmpRoot: string; projectDir: string; projectId: string } = {
  tmpRoot: '',
  projectDir: '',
  projectId: '',
}

async function writeConfig(extra: Partial<LocalConfig> = {}): Promise<void> {
  await fs.mkdir(path.join(fixture.projectDir, '.prjct'), { recursive: true })
  await fs.writeFile(
    path.join(fixture.projectDir, '.prjct', 'prjct.config.json'),
    JSON.stringify({ projectId: fixture.projectId, dataPath: fixture.tmpRoot, ...extra })
  )
}

beforeEach(async () => {
  fixture.tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'prjct-qa-runner-'))
  fixture.projectDir = path.join(fixture.tmpRoot, 'proj')
  await fs.mkdir(fixture.projectDir, { recursive: true })
  fixture.projectId = `qa-runner-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  patchPathManager(fixture.tmpRoot)
  prjctDb.run(fixture.projectId, 'SELECT 1 WHERE 1=0')
  await writeConfig()
  await execFileAsync('git', ['init', '-q'], { cwd: fixture.projectDir })
  await execFileAsync(
    'git',
    [
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.com',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '--allow-empty',
      '-qm',
      'seed',
    ],
    { cwd: fixture.projectDir }
  )
})

afterEach(async () => {
  restorePathManager()
  await fs.rm(fixture.tmpRoot, { recursive: true, force: true }).catch(() => undefined)
})

describe('runQa', () => {
  it('is loudly vacuous with nothing runnable, and never touches the app config', async () => {
    const receipt = await runQa(fixture.projectDir, fixture.projectId, { plan: null })
    expect(receipt.vacuous).toBe(true)
    expect(receipt.passed).toBe(true)
    expect(receipt.app.started).toBe(false)
    expect(readQaReceipt(fixture.projectId)?.data.vacuous).toBe(true)
    expect(renderQaReceiptMd(receipt)).toContain('VACUOUS')
  })

  it('runs cli/file probes, marks flows machine-verified, and binds the receipt to the task', async () => {
    const { plan } = upsertQaPlan(
      fixture.projectId,
      't1',
      {
        flows: [
          { name: 'cli ok', kind: 'cli', probe: { type: 'cli', command: 'true' } },
          { name: 'cli red', kind: 'cli', probe: { type: 'cli', command: 'false' } },
          {
            name: 'tool missing',
            kind: 'cli',
            probe: { type: 'cli', command: 'prjct-no-such-binary-xyz' },
          },
          { name: 'no probe', kind: 'ui' },
        ],
      },
      { mode: 'advisory' }
    )
    const receipt = await runQa(fixture.projectDir, fixture.projectId, { plan })
    expect(receipt.taskId).toBe('t1')
    expect(receipt.passed).toBe(false)
    expect(receipt.vacuous).toBe(false)
    expect(receipt.probes.map((p) => p.outcome)).toEqual(['ok', 'exit:1', 'unavailable'])
    const after = getQaPlan(fixture.projectId, 't1')
    expect(after?.flows.map((f) => f.status)).toEqual(['passed', 'failed', 'skipped', 'pending'])
    expect(after?.flows[0]?.verifiedBy).toBe('machine')
    expect(readQaReceipt(fixture.projectId, 't1')?.data.taskId).toBe('t1')
    expect(renderQaReceiptMd(receipt)).toContain('RED')
  })

  it('--flow limits the run to one probe', async () => {
    const { plan } = upsertQaPlan(
      fixture.projectId,
      't2',
      {
        flows: [
          { name: 'a', kind: 'cli', probe: { type: 'cli', command: 'true' } },
          { name: 'b', kind: 'cli', probe: { type: 'cli', command: 'false' } },
        ],
      },
      { mode: 'advisory' }
    )
    const only = plan?.flows[0]?.id
    const receipt = await runQa(fixture.projectDir, fixture.projectId, { plan, flowId: only })
    expect(receipt.probes.length).toBe(1)
    expect(receipt.passed).toBe(true)
  })

  it('runs registered extra commands as checks', async () => {
    expect((await setQaValue(fixture.projectDir, 'smoke', 'echo smoke')).ok).toBe(true)
    expect((await setQaValue(fixture.projectDir, 'bogus', 'x')).ok).toBe(false)
    const receipt = await runQa(fixture.projectDir, fixture.projectId, { plan: null })
    expect(receipt.checks.map((c) => `${c.kind}:${c.outcome}`)).toEqual(['smoke:ok'])
    expect(receipt.vacuous).toBe(false)
  })
})

describe('ensureShipQa', () => {
  it('self-provisions the probe run when the receipt is missing, then gates on the result', async () => {
    const { plan } = upsertQaPlan(
      fixture.projectId,
      't3',
      { flows: [{ name: 'red', kind: 'cli', probe: { type: 'cli', command: 'false' } }] },
      { mode: 'strict' }
    )
    expect(plan).not.toBe(null)
    const verdict = await ensureShipQa(fixture.projectDir, fixture.projectId, {
      taskId: 't3',
      harnessLevel: 'H1',
      headSha: null,
      mode: 'strict',
      override: false,
    })
    expect(verdict.blocked).toBe(true)
    expect(verdict.message).toContain('RED')
    expect(readQaReceipt(fixture.projectId, 't3')).not.toBe(null)
  })

  it('override proceeds without running anything', async () => {
    upsertQaPlan(
      fixture.projectId,
      't4',
      { flows: [{ name: 'red', kind: 'cli', probe: { type: 'cli', command: 'false' } }] },
      { mode: 'advisory' }
    )
    const verdict = await ensureShipQa(fixture.projectDir, fixture.projectId, {
      taskId: 't4',
      harnessLevel: 'H1',
      headSha: null,
      mode: 'strict',
      override: true,
    })
    expect(verdict.blocked).toBe(false)
    expect(readQaReceipt(fixture.projectId, 't4')).toBe(null)
  })
})

describe('config helpers', () => {
  it('setQaValue writes app.* and extra commands; bootstrap cue only when an app is unreachable', async () => {
    expect((await setQaValue(fixture.projectDir, 'app.start', 'node server.js')).ok).toBe(true)
    expect((await setQaValue(fixture.projectDir, 'app.readyTimeoutMs', 'abc')).ok).toBe(false)
    const raw = (await configManager.readConfig(fixture.projectDir))!
    expect(raw.qa?.app?.start).toBe('node server.js')

    await fs.writeFile(
      path.join(fixture.projectDir, 'package.json'),
      JSON.stringify({ scripts: { dev: 'node server.js', 'test:e2e': 'playwright test' } })
    )
    const cue = await qaBootstrapCue(fixture.projectDir, {
      projectId: fixture.projectId,
      dataPath: fixture.tmpRoot,
      qa: { mode: 'advisory' },
    })
    expect(cue).toContain('prjct qa set app.baseUrl')
    expect(
      await qaBootstrapCue(fixture.projectDir, {
        projectId: fixture.projectId,
        dataPath: fixture.tmpRoot,
        qa: { mode: 'advisory', app: { baseUrl: 'http://localhost:3000' } },
      })
    ).toBe(null)
    expect(
      await qaBootstrapCue(fixture.projectDir, { projectId: fixture.projectId, dataPath: '' })
    ).toBe(null)
    const candidates = await detectQaCandidates(fixture.projectDir)
    expect(candidates[0]).toMatchObject({ kind: 'e2e', command: 'npm run test:e2e' })
  })
})
