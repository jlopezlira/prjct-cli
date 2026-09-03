import { describe, expect, it } from 'bun:test'
import type { QaPlan } from '../../schemas/qa'
import { browserToolHints, buildQaBrief } from '../../services/qa-brief'
import type { LocalConfig } from '../../types/config'

const plan: QaPlan = {
  version: 1,
  taskId: 't1',
  seededFromSpec: false,
  createdAt: 'x',
  updatedAt: 'x',
  criteria: [
    {
      id: 'ac-aaaa1111',
      text: 'GET /health returns 200 — http probe',
      verifiable: true,
      status: 'pending',
    },
    {
      id: 'ac-bbbb2222',
      text: 'dashboard greets the user — browser',
      verifiable: true,
      status: 'met',
      verifiedBy: 'agent',
    },
  ],
  flows: [
    {
      id: 'fl-1111aaaa',
      name: 'login happy path',
      kind: 'ui',
      given: ['a registered user'],
      when: ['they submit valid credentials'],
      // biome-ignore lint/suspicious/noThenProperty: GIVEN/WHEN/THEN domain language; never awaited
      then: ['they land on /dashboard'],
      status: 'pending',
    },
    {
      id: 'fl-2222bbbb',
      name: 'health ok',
      kind: 'api',
      given: [],
      when: [],
      // biome-ignore lint/suspicious/noThenProperty: GIVEN/WHEN/THEN domain language; never awaited
      then: [],
      probe: { type: 'http', method: 'GET', path: '/health', expect: { bodyIncludes: [] } },
      status: 'passed',
      verifiedBy: 'machine',
    },
    {
      id: 'fl-3333cccc',
      name: 'logout',
      kind: 'ui',
      given: [],
      when: [],
      // biome-ignore lint/suspicious/noThenProperty: GIVEN/WHEN/THEN domain language; never awaited
      then: [],
      status: 'passed',
      verifiedBy: 'author',
    },
  ],
}

const config = (over: Partial<LocalConfig> = {}): LocalConfig => ({
  projectId: 'p',
  dataPath: '/tmp/p',
  qa: { app: { start: 'npm run dev', baseUrl: 'http://localhost:3000' } },
  ...over,
})

describe('buildQaBrief', () => {
  it('caps QA at one agent and one bounded pass over pending work', () => {
    const brief = buildQaBrief({ plan, receipt: null, config: null })

    expect(brief).toMatch(/exactly one QA agent/i)
    expect(brief).toMatch(/one bounded pass/i)
    expect(brief).toMatch(/stop when every pending item has one verdict/i)
  })

  it('lists only what still needs a blind verdict and carries the report contract', () => {
    const brief = buildQaBrief({ plan, receipt: null, config: config() })
    expect(brief).toContain('Do NOT fix anything')
    expect(brief).toContain('npm run dev')
    expect(brief).toContain('http://localhost:3000')
    expect(brief).toContain('fl-1111aaaa')
    expect(brief).toContain('GIVEN a registered user')
    // Author-marked flow must be re-verified; machine-verified flow is not listed.
    expect(brief).toContain('fl-3333cccc')
    expect(brief).toContain('verify independently')
    expect(brief.split('## Flows to verify')[1]).not.toContain('fl-2222bbbb')
    expect(brief).toContain('ac-aaaa1111')
    expect(brief.split('## Acceptance criteria to confirm')[1]).not.toContain('ac-bbbb2222')
    expect(brief).toContain('prjct qa report --json')
    expect(brief).toContain('"id":"fl-1111aaaa"')
    // Information asymmetry: no diff, no transcript, no commits handed over.
    expect(brief).not.toMatch(/git diff|transcript/i)
  })

  it('names the declared browser MCP, else the generic tool list', () => {
    expect(
      browserToolHints(config({ persona: { role: 'DEV', mcps: ['playwright'] } }))[0]
    ).toContain('Playwright MCP')
    expect(browserToolHints(config())[0]).toContain('Chrome DevTools MCP')
    const brief = buildQaBrief({
      plan,
      receipt: {
        version: 1,
        taskId: 't1',
        ranAt: 'x',
        headSha: null,
        dirty: null,
        passed: true,
        vacuous: false,
        app: { started: false },
        checks: [],
        probes: [{ flowId: 'fl-2222bbbb', type: 'http', ok: true, outcome: 'ok', durationMs: 3 }],
      },
      config: config(),
    })
    expect(brief).toContain('Already verified by machine')
  })
})
