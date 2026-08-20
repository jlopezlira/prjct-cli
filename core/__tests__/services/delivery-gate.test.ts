/**
 * Universal delivery gate — the one primitive every prjct→agent emission
 * flows through. Covers session scoping, material-change normalization,
 * noSession policies (volatile never suppressed sessionless), TTL expiry,
 * full bypass, durable ledgers, and the MCP result pointer.
 */

import { beforeEach, describe, expect, it } from 'bun:test'
import {
  _resetDeliveredLedgerForTests,
  condenseDelivered,
  condenseDeliveredDurable,
  condenseResult,
  gateDelivery,
  normalizeStateForMaterialChange,
} from '../../services/session-context-cache'

const uid = (): string => `gate-${Math.random().toString(36).slice(2, 10)}`

function baseReq(overrides: Record<string, unknown> = {}) {
  return {
    projectId: uid(),
    projectPath: `/tmp/${uid()}`,
    sessionId: 'session-a',
    surface: 'pre-search' as const,
    content: 'hello world',
    ...overrides,
  }
}

beforeEach(() => {
  _resetDeliveredLedgerForTests()
})

describe('gateDelivery — session-scoped suppression', () => {
  it('emits first delivery, suppresses identical repeat, re-emits on change', async () => {
    const req = baseReq()
    const first = await gateDelivery(req)
    expect(first.suppressed).toBe(false)
    expect(first.emit).toBe('hello world')

    const repeat = await gateDelivery(req)
    expect(repeat.suppressed).toBe(true)
    expect(repeat.emit).toBeNull()
    expect(repeat.emittedChars).toBe(0)

    const changed = await gateDelivery({ ...req, content: 'hello changed' })
    expect(changed.suppressed).toBe(false)
  })

  it('scopes stamps by session — a second agent still gets the content', async () => {
    const req = baseReq()
    await gateDelivery(req)
    const otherSession = await gateDelivery({ ...req, sessionId: 'session-b' })
    expect(otherSession.suppressed).toBe(false)
  })

  it('scopes stamps by key within a surface', async () => {
    const req = baseReq({ key: 'tokenA' })
    await gateDelivery(req)
    const sameKey = await gateDelivery(req)
    expect(sameKey.suppressed).toBe(true)
    const otherKey = await gateDelivery({ ...req, key: 'tokenB' })
    expect(otherKey.suppressed).toBe(false)
  })

  it('suppression survives a cold spawn (disk stamp, not process memory)', async () => {
    const req = baseReq()
    await gateDelivery(req)
    _resetDeliveredLedgerForTests() // simulate new hook process: L1 gone
    const repeat = await gateDelivery(req)
    expect(repeat.suppressed).toBe(true)
  })

  it('normalize makes counter noise non-material', async () => {
    const req = baseReq({
      content: 'Turn 3 on this cycle — working tree 2 modified',
      normalize: normalizeStateForMaterialChange,
    })
    await gateDelivery(req)
    const noisy = await gateDelivery({
      ...req,
      content: 'Turn 4 on this cycle — working tree 5 modified',
    })
    expect(noisy.suppressed).toBe(true)
  })

  it('full bypass emits and restamps', async () => {
    const req = baseReq()
    await gateDelivery(req)
    const forced = await gateDelivery({ ...req, full: true })
    expect(forced.suppressed).toBe(false)
    const after = await gateDelivery(req)
    expect(after.suppressed).toBe(true)
  })

  it('onRepeat renders a pointer instead of silence', async () => {
    const req = baseReq({ onRepeat: (hash: string) => `unchanged (${hash.slice(0, 8)})` })
    await gateDelivery(req)
    const repeat = await gateDelivery(req)
    expect(repeat.suppressed).toBe(true)
    expect(repeat.emit).toMatch(/^unchanged \([0-9a-f]{8}\)$/)
    expect(repeat.emittedChars).toBeGreaterThan(0)
  })
})

describe('gateDelivery — noSession policies', () => {
  it('default: volatile content is NEVER suppressed without session identity', async () => {
    const req = baseReq({ sessionId: undefined })
    expect((await gateDelivery(req)).suppressed).toBe(false)
    expect((await gateDelivery(req)).suppressed).toBe(false)
  })

  it('memory: dedupes within the process only', async () => {
    const req = baseReq({ sessionId: undefined, noSession: { mode: 'memory' } })
    expect((await gateDelivery(req)).suppressed).toBe(false)
    expect((await gateDelivery(req)).suppressed).toBe(true)
    _resetDeliveredLedgerForTests()
    expect((await gateDelivery(req)).suppressed).toBe(false)
  })

  it('static: dedupes on disk until the TTL lapses', async () => {
    const req = baseReq({ sessionId: undefined, noSession: { mode: 'static', ttlMs: 40 } })
    expect((await gateDelivery(req)).suppressed).toBe(false)
    expect((await gateDelivery(req)).suppressed).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect((await gateDelivery(req)).suppressed).toBe(false)
  })

  it('static: TTL is a hard bound, not a sliding window — steady access still expires', async () => {
    const req = baseReq({ sessionId: undefined, noSession: { mode: 'static', ttlMs: 90 } })
    expect((await gateDelivery(req)).suppressed).toBe(false)
    // Suppressed accesses inside the window must NOT refresh the stamp:
    // once the ORIGINAL TTL lapses the content re-emits, even though it was
    // being accessed (and suppressed) the whole time.
    await new Promise((resolve) => setTimeout(resolve, 35))
    expect((await gateDelivery(req)).suppressed).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, 35))
    expect((await gateDelivery(req)).suppressed).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, 35))
    expect((await gateDelivery(req)).suppressed).toBe(false)
  })

  it('probe: evaluates suppression without writing any stamp', async () => {
    const req = baseReq()
    expect((await gateDelivery({ ...req, probe: true })).suppressed).toBe(false)
    // The probe wrote nothing — the next real call is still the first delivery.
    expect((await gateDelivery(req)).suppressed).toBe(false)
    expect((await gateDelivery(req)).suppressed).toBe(true)
  })
})

describe('condenseResult — MCP repeat pointer', () => {
  it('returns full content first, pointer with full:true escape on repeat', () => {
    const scope = uid()
    const body = '## Analysis\nlots of content here'
    const first = condenseResult(scope, 'analysis', body)
    expect(first.repeated).toBe(false)
    expect(first.text).toBe(body)

    const repeat = condenseResult(scope, 'analysis', body)
    expect(repeat.repeated).toBe(true)
    expect(repeat.text).toContain('unchanged since last delivery this session')
    expect(repeat.text).toContain('full:true')
    expect(repeat.text.length).toBeLessThanOrEqual(120)

    const forced = condenseResult(scope, 'analysis', body, { full: true })
    expect(forced.repeated).toBe(false)
    expect(forced.text).toBe(body)
  })

  it('re-delivers when the content changes', () => {
    const scope = uid()
    condenseResult(scope, 'analysis', 'v1')
    const changed = condenseResult(scope, 'analysis', 'v2')
    expect(changed.repeated).toBe(false)
  })
})

describe('condenseDelivered — LRU (no clear-cliff)', () => {
  it('keeps recently-touched entries when the cap overflows', () => {
    const scope = uid()
    condenseDelivered(scope, [{ id: 'hot', content: 'hot-content' }])
    // Flood well past the 512 cap; 'hot' is oldest and untouched → evicted,
    // but the most recent flood entries must survive (no full clear).
    for (const i of Array.from({ length: 600 }, (_, n) => n)) {
      condenseDelivered(scope, [{ id: `flood-${i}`, content: `c${i}` }])
    }
    const recent = condenseDelivered(scope, [{ id: 'flood-599', content: 'c599' }])
    expect(recent.repeats.length).toBe(1)
  })
})

describe('condenseDeliveredDurable — CLI ledger', () => {
  it('partitions across separate invocations via the disk stamp', async () => {
    const scope = {
      projectId: uid(),
      projectPath: `/tmp/${uid()}`,
      sessionId: 'session-cli',
      surface: 'cli-search' as const,
    }
    const entries = [
      { id: 'mem_1', content: 'first fact' },
      { id: 'mem_2', content: 'second fact' },
    ]
    const first = await condenseDeliveredDurable(scope, entries)
    expect(first.fresh.length).toBe(2)
    _resetDeliveredLedgerForTests()
    const second = await condenseDeliveredDurable(scope, entries)
    expect(second.repeats.length).toBe(2)
    const third = await condenseDeliveredDurable(scope, entries, { full: true })
    expect(third.fresh.length).toBe(2)
  })

  it('without session identity everything is fresh', async () => {
    const scope = {
      projectId: uid(),
      projectPath: `/tmp/${uid()}`,
      sessionId: undefined,
      surface: 'cli-search' as const,
    }
    const entries = [{ id: 'mem_1', content: 'fact' }]
    expect((await condenseDeliveredDurable(scope, entries)).fresh.length).toBe(1)
    expect((await condenseDeliveredDurable(scope, entries)).fresh.length).toBe(1)
  })

  it('probe does not stamp entries omitted by a later budget pack', async () => {
    const scope = {
      projectId: uid(),
      projectPath: `/tmp/${uid()}`,
      sessionId: 'session-probe',
      surface: 'cli-work' as const,
    }
    const entries = [{ id: 'mem_1', content: 'optional living knowledge' }]
    expect((await condenseDeliveredDurable(scope, entries, { probe: true })).fresh.length).toBe(1)
    _resetDeliveredLedgerForTests()
    expect((await condenseDeliveredDurable(scope, entries, { probe: true })).fresh.length).toBe(1)
    await condenseDeliveredDurable(scope, entries)
    _resetDeliveredLedgerForTests()
    expect((await condenseDeliveredDurable(scope, entries, { probe: true })).repeats.length).toBe(1)
  })
})
