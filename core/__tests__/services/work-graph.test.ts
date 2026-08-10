import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { workGraph } from '../../services/work-graph'
import { prjctDb } from '../../storage/database'
import { queueStorage } from '../../storage/queue-storage'

const fixture: {
  tmpHome: string
  pid: string
  prevHome: string | undefined
} = {
  tmpHome: '',
  pid: '',
  prevHome: undefined as unknown as string | undefined,
}

async function addItem(desc: string, priority = 'medium'): Promise<string> {
  const t = await queueStorage.addTask(fixture.pid, {
    description: desc,
    section: 'active',
    type: 'feature',
    priority: priority as 'medium',
  })
  return t.id
}

beforeAll(() => {
  fixture.tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-test-'))
  fixture.prevHome = process.env.PRJCT_CLI_HOME
  process.env.PRJCT_CLI_HOME = fixture.tmpHome
  fixture.pid = 'wg-test-project'
  prjctDb.get(fixture.pid, 'SELECT 1') // force init + migrations
})

afterAll(() => {
  if (fixture.prevHome) process.env.PRJCT_CLI_HOME = fixture.prevHome
  else delete process.env.PRJCT_CLI_HOME
  fs.rmSync(fixture.tmpHome, { recursive: true, force: true })
})

describe('work graph — frontier, claims, phases', () => {
  it('ready excludes items with open blockers and surfaces them when unblocked', async () => {
    const a = await addItem('build the schema')
    const b = await addItem('build the API on top of the schema')
    workGraph.addDependency(fixture.pid, b, a, 'blocks')

    const readyBefore = workGraph.ready(fixture.pid).map((item) => item.id)
    expect(readyBefore).toContain(a)
    expect(readyBefore).not.toContain(b)

    await queueStorage.completeTask(fixture.pid, a)
    const readyAfter = workGraph.ready(fixture.pid).map((item) => item.id)
    expect(readyAfter).toContain(b)
  })

  it('rejects blocking cycles but allows informational edges', async () => {
    const x = await addItem('x')
    const y = await addItem('y')
    workGraph.addDependency(fixture.pid, x, y, 'blocks')
    expect(() => workGraph.addDependency(fixture.pid, y, x, 'blocks')).toThrow(/cycle/)
    // related never gates → no cycle check needed
    workGraph.addDependency(fixture.pid, y, x, 'related')
    expect(workGraph.dependenciesOf(fixture.pid, y).some((d) => d.depType === 'related')).toBe(true)
  })

  it('claim is race-free: second claimant loses', async () => {
    const c = await addItem('contested item')
    expect(workGraph.claim(fixture.pid, c, 'agent-1')).toBe(true)
    expect(workGraph.claim(fixture.pid, c, 'agent-2')).toBe(false)
    workGraph.release(fixture.pid, c)
    expect(workGraph.claim(fixture.pid, c, 'agent-2')).toBe(true)
  })

  it('phases: same level = parallelizable, dependent items land later', async () => {
    const p1a = await addItem('phase1 a')
    const p1b = await addItem('phase1 b')
    const p2 = await addItem('phase2 depends on both')
    workGraph.addDependency(fixture.pid, p2, p1a, 'blocks')
    workGraph.addDependency(fixture.pid, p2, p1b, 'blocks')

    const plan = workGraph.phases(fixture.pid)
    const phaseOf = (id: string) => plan.find((p) => p.items.some((i) => i.id === id))?.phase
    expect(phaseOf(p1a)).toBe(1)
    expect(phaseOf(p1b)).toBe(1)
    expect(phaseOf(p2)).toBe(2)
  })

  it('complexity record round-trips', () => {
    workGraph.recordComplexity(fixture.pid, 'task-z', {
      score: 8,
      recommendedSubtasks: 4,
      expansionPrompt: 'break it down',
    })
    const rec = workGraph.getComplexity(fixture.pid, 'task-z')
    expect(rec?.score).toBe(8)
    expect(rec?.recommendedSubtasks).toBe(4)
  })
})
