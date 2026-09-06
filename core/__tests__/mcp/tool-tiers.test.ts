import { afterEach, describe, expect, it } from 'bun:test'
import { z } from 'zod'

type RegisteredTools = Record<string, { description?: string; inputSchema?: z.ZodType }>

async function getTools(tier: string | undefined): Promise<RegisteredTools> {
  if (tier === undefined) delete process.env.PRJCT_MCP_TOOLS
  else process.env.PRJCT_MCP_TOOLS = tier
  const { createServer } = await import('../../mcp/server')
  const server = createServer() as unknown as { _registeredTools?: RegisteredTools }
  return server._registeredTools ?? {}
}

async function toolCount(tier: string | undefined): Promise<number> {
  return Object.keys(await getTools(tier)).length
}

afterEach(() => {
  delete process.env.PRJCT_MCP_TOOLS
})

describe('tiered MCP tool loading (PRJCT_MCP_TOOLS)', () => {
  it('core < standard < all — every registered tool costs schema tokens per session', async () => {
    const core = await toolCount('core')
    const standard = await toolCount('standard')
    const all = await toolCount('all')
    expect(core).toBeGreaterThan(0)
    expect(standard).toBeGreaterThan(core)
    expect(all).toBeGreaterThan(standard)
  })

  it('core stays lean (schema-tax budget)', async () => {
    const core = await toolCount('core')
    // mem×5 + project×5 = 10 after slim (typed/cost/signals/skills off-core)
    expect(core).toBeLessThanOrEqual(12)
    expect(core).toBeGreaterThanOrEqual(8)
  })

  it('lean tier is 6 tools, a strict subset of core (non-caching hosts)', async () => {
    const lean = await getTools('lean')
    const core = await getTools('core')
    expect(Object.keys(lean).sort()).toEqual([
      'prjct_analysis',
      'prjct_guard',
      'prjct_mem_list',
      'prjct_mem_save',
      'prjct_task_set_status',
      'prjct_task_start',
    ])
    for (const name of Object.keys(lean)) expect(core[name]).toBeDefined()
  })

  it('lean ListTools stays under its char budget (re-paid every API call)', async () => {
    const tools = await getTools('lean')
    const totals = Object.values(tools).reduce(
      (acc, tool) =>
        acc +
        (tool.description ?? '').length +
        (tool.inputSchema ? JSON.stringify(z.toJSONSchema(tool.inputSchema)).length : 0),
      0
    )
    // ~2.8k chars measured 2026-08-19; budget 3.1k so the lean surface cannot
    // creep back toward core's ~4.3k without an explicit decision here.
    expect(totals).toBeLessThanOrEqual(3100)
  })

  it('unset and garbage default to micro; richer tiers remain opt-in', async () => {
    const micro = await toolCount('micro')
    expect(await toolCount(undefined)).toBe(micro)
    expect(await toolCount('garbage')).toBe(micro)
    expect(await toolCount('core')).toBeGreaterThan(micro)
    expect(await toolCount('all')).toBeGreaterThan(micro)
  })

  it('core ListTools stays under the char budget (descriptions + JSON schemas)', async () => {
    const tools = await getTools('core')
    const totals = Object.values(tools).reduce(
      (acc, tool) => ({
        descriptions: acc.descriptions + (tool.description ?? '').length,
        schemas:
          acc.schemas +
          (tool.inputSchema ? JSON.stringify(z.toJSONSchema(tool.inputSchema)).length : 0),
      }),
      { descriptions: 0, schemas: 0 }
    )
    // ~4.3k chars today; budget 4.5k (~1.1k tokens) so the default surface
    // cannot creep back toward the old ~5k without an explicit decision here.
    expect(totals.descriptions + totals.schemas).toBeLessThanOrEqual(4500)
  })

  it('spec how-to prose lives in runtime error text, not ListTools descriptions', async () => {
    const tools = await getTools('all')
    // Worst offenders were ~700 / ~580 chars; format detail now ships in the
    // DELTA_* error text of prjct_spec_apply_delta instead.
    for (const name of ['prjct_spec_update', 'prjct_spec_apply_delta']) {
      expect((tools[name]?.description ?? '').length).toBeLessThanOrEqual(400)
    }
  })
})
