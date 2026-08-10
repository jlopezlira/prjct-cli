import { describe, expect, it } from 'bun:test'
import path from 'node:path'
import { Client } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { MCP_CATALOG_CACHE_TTL_MS } from '../../mcp/server'

interface CacheableResult {
  cacheScope?: string
  capabilities?: { tools?: { listChanged?: boolean } }
  ttlMs?: number
}

const REPO_ROOT = path.resolve(__dirname, '../../..')
const CLIENT_INFO = { name: 'prjct-protocol-test', version: '1.0.0' }

async function connectClient(options?: ConstructorParameters<typeof Client>[1]): Promise<Client> {
  const client = new Client(CLIENT_INFO, options)
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: ['core/mcp/entry.ts'],
      cwd: REPO_ROOT,
      stderr: 'pipe',
    })
  )
  return client
}

describe('MCP 2026-07-28 stdio protocol', () => {
  it('serves the modern era with a cacheable deterministic catalog', async () => {
    const client = await connectClient({
      versionNegotiation: { mode: { pin: '2026-07-28' } },
    })

    try {
      expect(client.getProtocolEra()).toBe('modern')

      const discovery = client.getDiscoverResult() as CacheableResult | undefined
      const catalog = (await client.listTools()) as CacheableResult & {
        tools: Array<{ name: string }>
      }

      expect(discovery?.ttlMs).toBe(MCP_CATALOG_CACHE_TTL_MS)
      expect(discovery?.cacheScope).toBe('private')
      expect(discovery?.capabilities?.tools?.listChanged).toBe(false)
      expect(catalog.ttlMs).toBe(MCP_CATALOG_CACHE_TTL_MS)
      expect(catalog.cacheScope).toBe('private')
      const names = catalog.tools.map(({ name }) => name)
      expect(new Set(names).size).toBe(names.length)
    } finally {
      await client.close()
    }
  })

  it('keeps the legacy handshake for existing MCP hosts', async () => {
    const client = await connectClient()

    try {
      expect(client.getProtocolEra()).toBe('legacy')
      expect((await client.listTools()).tools.length).toBeGreaterThan(0)
    } finally {
      await client.close()
    }
  })
})
