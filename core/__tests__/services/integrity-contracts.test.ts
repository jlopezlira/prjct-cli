import { describe, expect, it } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { RequestJournal } from '../../daemon/request-journal'
import { buildRetrievalReport } from '../../eval/report'
import configManager from '../../infrastructure/config-manager'
import { enrichedRecall } from '../../memory/enriched-recall'
import { HttpEmbeddingProvider } from '../../services/embeddings'
import { buildInferenceCostReport } from '../../services/inference-cost'
import { evaluateOutcomeEvidence } from '../../services/outcome-evidence'
import { canonicalUsage, type UsageObservation } from '../../services/usage-accounting'
import {
  buildWorkCostSnapshot,
  recordHookEmissionChars,
  recordTaskTokenUsage,
} from '../../services/work-cost-service'
import prjctDb from '../../storage/database'

const row = (overrides: Partial<UsageObservation> = {}): UsageObservation => ({
  work_cycle_id: 'cycle',
  source: 'test-transcript',
  model_id: null,
  input_tokens: 1000,
  output_tokens: 200,
  is_estimated: 0,
  measured_at: 1,
  ...overrides,
})
const tokens = (rows: UsageObservation[]) =>
  rows.reduce((n, r) => n + r.input_tokens + r.output_tokens, 0)
describe('accounting contracts', () => {
  it('reconciles measured total/model/source after later context tax', () => {
    const id = `accounting-${crypto.randomUUID()}`
    recordTaskTokenUsage(id, 'cycle', 1000000, 234560, { source: 'test-transcript' })
    recordTaskTokenUsage(id, 'cycle', 1000000, 234560, {
      source: 'test-transcript:model',
      model: 'model',
    })
    recordHookEmissionChars(id, 'cycle', 100, 'test')
    const snapshot = buildWorkCostSnapshot(id, 7)
    expect(snapshot.tokensTotal).toBe(1234560)
    expect(snapshot.byModel.reduce((n, r) => n + r.tokensIn + r.tokensOut, 0)).toBe(
      snapshot.tokensTotal
    )
    expect(snapshot.bySource.reduce((n, r) => n + r.tokensIn + r.tokensOut, 0)).toBe(
      snapshot.tokensTotal
    )
    expect(snapshot.contextTokensEstimated).toBe(25)
    expect(buildInferenceCostReport(id, { days: 7 }).tokensTotal).toBe(snapshot.tokensTotal)
  })
  it('sums distinct sessions without summing duplicate total/breakdown observations', () => {
    const rows = ['s1', 's2'].flatMap((observation_id) => [
      row({ observation_id }),
      row({ observation_id, source: 'test-transcript:m', model_id: 'm' }),
    ])
    expect(tokens(canonicalUsage(rows).rows)).toBe(2400)
  })
  it('keeps partial breakdown residual as unknown model', () => {
    const selected = canonicalUsage([
      row(),
      row({ source: 'test-transcript:m', model_id: 'm', input_tokens: 600, output_tokens: 100 }),
    ]).rows
    expect(tokens(selected)).toBe(1200)
    expect(tokens(selected.filter((r) => r.model_id === null))).toBe(500)
  })
  it('does not replace exact usage with newer estimates', () => {
    const selected = canonicalUsage([
      row(),
      row({ source: 'cli', input_tokens: 2500, is_estimated: 1, measured_at: 2 }),
    ])
    expect(tokens(selected.rows)).toBe(1200)
    expect(selected.ambiguousCycles).toEqual(['cycle'])
  })
  it('rejects inconsistent breakdown inflation', () => {
    const selected = canonicalUsage([
      row(),
      row({ model_id: 'm', source: 'test-transcript:m', input_tokens: 9000 }),
    ])
    expect(tokens(selected.rows)).toBe(1200)
    expect(selected.rows[0]?.model_id).toBeNull()
  })
  it('does not count an estimated context-only cycle as exact coverage', () => {
    const id = `accounting-${crypto.randomUUID()}`
    recordHookEmissionChars(id, 'cycle', 100, 'test')
    const snapshot = buildWorkCostSnapshot(id, 7)
    expect(snapshot.tokensTotal).toBe(0)
    expect(snapshot.exactTokenCycles).toBe(0)
    expect(snapshot.tokenCoveragePercent).toBe(0)
  })
})

const request = (id: string) => ({
  id,
  command: 'qa',
  args: ['run'],
  options: {},
  cwd: process.cwd(),
})
describe('operation resumption contracts', () => {
  it('does not expire an operation that is still running', async () => {
    const clock = { now: 1 }
    const journal = new RequestJournal({ ttlMs: 10, now: () => clock.now })
    const state = { runs: 0, finish: () => {} }
    const pending = new Promise<void>((resolve) => {
      state.finish = resolve
    })
    const run = () => {
      state.runs++
      return pending.then(() => ({ id: 'op', success: true, exitCode: 0 }))
    }
    const first = journal.run(request('op'), run)
    await Promise.resolve()
    clock.now = 100
    const retry = journal.run(request('op'), run)
    state.finish()
    await Promise.all([first, retry])
    expect(state.runs).toBe(1)
  })
  it('restores completed results and refuses interrupted operations after restart', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'operation-journal-'))
    try {
      const journal = new RequestJournal({ storageDir: () => dir })
      await journal.run(request('done'), async () => ({
        id: 'done',
        success: true,
        exitCode: 0,
        stdout: 'receipt',
      }))
      const state = { finish: () => {} }
      const pending = journal.run(
        request('running'),
        () =>
          new Promise((resolve) => {
            state.finish = () => resolve({ id: 'running', success: true, exitCode: 0 })
          })
      )
      await Promise.resolve()
      const restarted = new RequestJournal({ storageDir: () => dir })
      const runner = async () => {
        throw new Error('must not replay')
      }
      expect((await restarted.run(request('done'), runner)).stdout).toBe('receipt')
      expect((await restarted.run(request('running'), runner)).stderr).toContain('interrupted')
      state.finish()
      await pending
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })
  it('retains failed operations instead of replaying uncertain side effects', async () => {
    const journal = new RequestJournal()
    const state = { runs: 0 }
    const runner = async () => {
      state.runs++
      throw new Error('failed after mutation')
    }
    await journal.run(request('failed'), runner)
    expect((await journal.run(request('failed'), runner)).success).toBe(false)
    expect(state.runs).toBe(1)
  })
  it('rejects changed arguments for the same operation', async () => {
    const journal = new RequestJournal()
    const runner = async () => ({ id: 'op', success: true, exitCode: 0 })
    await journal.run(request('op'), runner)
    expect((await journal.run({ ...request('op'), args: ['different'] }, runner)).stderr).toContain(
      'different payload'
    )
  })
})

describe('embedding request budgets', () => {
  it('supports cancellation before sending', async () => {
    const controller = new AbortController()
    controller.abort(new Error('cancelled'))
    await expect(
      new HttpEmbeddingProvider('http://127.0.0.1:1', 'test').embed(['x'], {
        signal: controller.signal,
      })
    ).rejects.toThrow('cancelled')
  })
  it('aborts a stalled response body', async () => {
    const server = Bun.serve({
      port: 0,
      fetch: () =>
        new Response(
          new ReadableStream({
            start(c) {
              c.enqueue(new TextEncoder().encode('{"data":'))
            },
          })
        ),
    })
    try {
      await expect(
        new HttpEmbeddingProvider(`http://127.0.0.1:${server.port}`, 'test', {
          timeoutMs: 50,
        }).embed(['x'])
      ).rejects.toThrow()
    } finally {
      server.stop(true)
    }
  })
  it('rejects malformed vectors instead of storing a corrupt index', async () => {
    const server = Bun.serve({ port: 0, fetch: () => Response.json({ data: [{ embedding: [] }] }) })
    try {
      await expect(
        new HttpEmbeddingProvider(`http://127.0.0.1:${server.port}`, 'test').embed(['x'])
      ).rejects.toThrow('Invalid embedding')
    } finally {
      server.stop(true)
    }
  })
})

describe('outcome evidence contracts', () => {
  it('keeps missing evidence incomplete', () => {
    expect(evaluateOutcomeEvidence().qualified).toBe(false)
  })
  it('refuses fixture summaries in place of actual paired runs', () => {
    expect(evaluateOutcomeEvidence({ passed: 100, model: 'fixture' }).status).toBe('invalid')
  })
  it('never qualifies an empty result set', () => {
    expect(evaluateOutcomeEvidence([]).qualified).toBe(false)
  })
})

describe('served retrieval eligibility and evaluation', () => {
  for (const scenario of ['wrong-type', 'wrong-tag', 'aged-auto', 'eligible']) {
    it(`filters linked candidates: ${scenario}`, async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'recall-integrity-'))
      const id = crypto.randomUUID()
      try {
        await configManager.writeConfig(root, { projectId: id, dataPath: path.join(root, '.data') })
        const target = `mem_${prjctDb.appendEvent(id, scenario === 'wrong-type' ? 'memory.remember.gotcha' : 'memory.remember.decision', { content: 'Linked context about callback architecture', tags: { domain: scenario === 'wrong-tag' ? 'billing' : 'auth', ...(scenario === 'aged-auto' ? { source: 'land-auto' } : {}) }, provenance: 'declared' })}`
        if (scenario === 'aged-auto')
          prjctDb.run(
            id,
            'UPDATE memory_entries SET created_at = ? WHERE id = ?',
            Date.now() - 90 * 86400000,
            target
          )
        prjctDb.appendEvent(id, 'memory.remember.decision', {
          content: 'Zebracache authentication policy',
          tags: { domain: 'auth', relates: target },
          provenance: 'declared',
        })
        const entries = await enrichedRecall(root, id, {
          topic: 'Zebracache',
          types: ['decision'],
          tags: { domain: 'auth' },
          limit: 3,
          recordAttribution: false,
        })
        expect(entries.some((e) => e.id === target)).toBe(scenario === 'eligible')
        const bounded = await enrichedRecall(root, id, {
          topic: 'Zebracache',
          types: ['decision'],
          limit: 1,
          recordAttribution: false,
        })
        expect(bounded.length).toBeLessThanOrEqual(1)
      } finally {
        await fs.rm(root, { recursive: true, force: true })
      }
    })
  }
  it('evaluates served recall without creating attribution or pooling proxy labels', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'eval-integrity-'))
    const id = crypto.randomUUID()
    try {
      await configManager.writeConfig(root, { projectId: id, dataPath: path.join(root, '.data') })
      const target = `mem_${prjctDb.appendEvent(id, 'memory.remember.decision', { content: 'Zebracache authentication callbacks must validate tokens', tags: {}, provenance: 'declared' })}`
      prjctDb.appendEvent(id, 'memory.remember.decision', {
        content: `Zebracache authentication callbacks follow ${target}`,
        tags: {},
        provenance: 'declared',
      })
      const before = prjctDb.query(id, 'SELECT * FROM memory_surface_log')
      const report = await buildRetrievalReport(id, 3, root)
      expect(report.served.explicit.queries).toBe(1)
      expect(report.served.explicit.recallAtK).toBe(1)
      expect(report.served.proxy.queries).toBe(0)
      expect(prjctDb.query(id, 'SELECT * FROM memory_surface_log')).toEqual(before)
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })
})
