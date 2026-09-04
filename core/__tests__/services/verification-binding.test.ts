import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import configManager from '../../infrastructure/config-manager'
import {
  ensureShipGauntlet,
  gitBinding,
  isReceiptFresh,
  runGauntlet,
} from '../../services/gauntlet'
import { upsertQaPlan } from '../../services/qa-plan'
import { ensureShipQa, runQa } from '../../services/qa-runner'
import {
  sameVerification,
  unchangedDuringVerification,
  verificationBinding,
} from '../../services/verification-binding'
import { execFileAsync } from '../../utils/exec'

const fixture = { root: '', id: '' }
const git = (args: string[]) => execFileAsync('git', args, { cwd: fixture.root })
beforeEach(async () => {
  fixture.root = await fs.mkdtemp(path.join(os.tmpdir(), 'verification-binding-'))
  fixture.id = crypto.randomUUID()
  await configManager.writeConfig(fixture.root, {
    projectId: fixture.id,
    dataPath: path.join(fixture.root, '.prjct-data'),
  })
  await git(['init', '-q'])
  await git(['config', 'user.email', 'test@example.com'])
  await git(['config', 'user.name', 'Test'])
  await fs.writeFile(path.join(fixture.root, 'app.txt'), 'pass')
  await git(['add', '.'])
  await git(['-c', 'commit.gpgsign=false', 'commit', '-qm', 'seed'])
})
afterEach(async () => {
  await fs.rm(fixture.root, { recursive: true, force: true })
})

describe('verification content and execution binding', () => {
  it('binds dirty submodule content and detects edits restored during a run', async () => {
    await git([
      '-c',
      'protocol.file.allow=always',
      'submodule',
      'add',
      '-q',
      '--',
      fixture.root,
      'dep',
    ])
    const before = await verificationBinding(fixture.root, [])
    expect(before).not.toBeNull()
    const file = path.join(fixture.root, 'dep/app.txt')
    await fs.writeFile(file, 'regression')
    expect(sameVerification(before, await verificationBinding(fixture.root, []))).toBe(false)
    await fs.writeFile(file, 'pass')
    const restored = await verificationBinding(fixture.root, [])
    expect(sameVerification(before, restored)).toBe(true)
    expect(unchangedDuringVerification(before, restored)).toBe(false)
    await fs.writeFile(path.join(fixture.root, 'dep/new.txt'), 'new dependency')
    expect(sameVerification(before, await verificationBinding(fixture.root, []))).toBe(false)
  })
  it('rejects QA configuration changed between execution capture and verification', async () => {
    const original = await configManager.readConfig(fixture.root)
    const state = { reads: 0 }
    const mocked = spyOn(configManager, 'readConfig').mockImplementation(async () => ({
      ...original!,
      qa: {
        commands: [{ kind: 'smoke' as const, command: state.reads++ === 0 ? 'true' : 'false' }],
      },
    }))
    try {
      const result = await runQa(fixture.root, fixture.id, { plan: null })
      expect(result.checks[0]?.ok).toBe(true)
      expect(result.passed).toBe(false)
      expect(result.verification).toBeNull()
    } finally {
      mocked.mockRestore()
    }
  })
  for (const kind of ['tracked', 'staged', 'untracked', 'deleted', 'mode']) {
    it(`invalidates ${kind} drift without a new commit`, async () => {
      const before = await verificationBinding(fixture.root, ['test'])
      expect(before).not.toBeNull()
      if (kind === 'deleted') await fs.unlink(path.join(fixture.root, 'app.txt'))
      else if (kind === 'mode') await fs.chmod(path.join(fixture.root, 'app.txt'), 0o755)
      else
        await fs.writeFile(
          path.join(fixture.root, kind === 'untracked' ? 'new.txt' : 'app.txt'),
          'fail'
        )
      if (kind === 'staged') await git(['add', '.'])
      expect(sameVerification(before, await verificationBinding(fixture.root, ['test']))).toBe(
        false
      )
    })
  }
  it('binds all paths beyond the diagnostic cap and unusual names', async () => {
    await Promise.all(
      Array.from({ length: 205 }, (_, i) =>
        fs.writeFile(path.join(fixture.root, ` ${i}\nfile `), 'x')
      )
    )
    const before = await verificationBinding(fixture.root, ['test'])
    await fs.writeFile(path.join(fixture.root, ' 204\nfile '), 'y')
    expect(sameVerification(before, await verificationBinding(fixture.root, ['test']))).toBe(false)
  })
  it('normalizes object keys but preserves command order', async () => {
    const before = await verificationBinding(fixture.root, { a: 1, b: ['x', 'y'] })
    expect(
      sameVerification(before, await verificationBinding(fixture.root, { b: ['x', 'y'], a: 1 }))
    ).toBe(true)
    expect(
      sameVerification(before, await verificationBinding(fixture.root, { a: 1, b: ['y', 'x'] }))
    ).toBe(false)
  })
  it('rejects future timestamps and legacy receipts at authoritative gates', async () => {
    const verification = await verificationBinding(fixture.root, [])
    const headSha = verification?.headSha ?? null
    expect(
      isReceiptFresh(
        { ranAt: new Date(Date.now() + 60000).toISOString(), headSha, verification },
        Date.now(),
        headSha,
        verification
      )
    ).toBe(false)
    expect(
      isReceiptFresh(
        { ranAt: new Date().toISOString(), headSha },
        Date.now(),
        headSha,
        verification
      )
    ).toBe(false)
  })
  it('reruns QA after uncommitted regression', async () => {
    const { plan } = upsertQaPlan(
      fixture.id,
      'task',
      {
        flows: [
          {
            name: 'app works',
            probe: { type: 'file', path: 'app.txt', expect: { includes: ['pass'] } },
          },
        ],
      },
      { mode: 'strict' }
    )
    expect((await runQa(fixture.root, fixture.id, { plan })).passed).toBe(true)
    await fs.writeFile(path.join(fixture.root, 'app.txt'), 'fail')
    expect(
      (
        await ensureShipQa(fixture.root, fixture.id, {
          taskId: 'task',
          mode: 'strict',
          headSha: (await gitBinding(fixture.root)).headSha,
          override: false,
        })
      ).blocked
    ).toBe(true)
  })
  it('rejects content mutated by a passing QA probe', async () => {
    const { plan } = upsertQaPlan(
      fixture.id,
      'task',
      {
        flows: [
          { name: 'mutating probe', probe: { type: 'cli', command: 'echo changed > app.txt' } },
        ],
      },
      { mode: 'strict' }
    )
    const receipt = await runQa(fixture.root, fixture.id, { plan })
    expect(receipt.probes[0]?.ok).toBe(true)
    expect(receipt.verification).toBeNull()
    expect(receipt.passed).toBe(false)
  })
  it('reruns changed probes against the same checkout', async () => {
    const { plan } = upsertQaPlan(
      fixture.id,
      'task',
      { flows: [{ name: 'probe', probe: { type: 'cli', command: 'true' } }] },
      { mode: 'strict' }
    )
    await runQa(fixture.root, fixture.id, { plan })
    upsertQaPlan(
      fixture.id,
      'task',
      { flows: [{ name: 'probe', probe: { type: 'cli', command: 'false' } }] },
      { mode: 'strict' }
    )
    expect(
      (
        await ensureShipQa(fixture.root, fixture.id, {
          taskId: 'task',
          mode: 'strict',
          headSha: (await gitBinding(fixture.root)).headSha,
          override: false,
        })
      ).blocked
    ).toBe(true)
  })
  it('gauntlet refuses edits during execution', async () => {
    await configManager.writeConfig(fixture.root, {
      projectId: fixture.id,
      dataPath: path.join(fixture.root, '.prjct-data'),
      gauntlet: { commands: [{ kind: 'test', command: 'echo changed >> app.txt' }] },
    })
    const receipt = await runGauntlet(fixture.root, fixture.id)
    expect(receipt.checks[0]?.ok).toBe(true)
    expect(receipt.verification).toBeNull()
    expect(
      (
        await ensureShipGauntlet(fixture.root, fixture.id, {
          headSha: (await gitBinding(fixture.root)).headSha,
          strict: true,
          override: false,
          onProgress: () => {},
        })
      ).blocked
    ).toBe(true)
  })
})
