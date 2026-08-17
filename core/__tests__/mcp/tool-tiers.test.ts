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

  it('unset and garbage default to core; all remains opt-in', async () => {
    const core = await toolCount('core')
    expect(await toolCount(undefined)).toBe(core)
    expect(await toolCount('garbage')).toBe(core)
    expect(await toolCount('all')).toBeGreaterThan(core)
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
