import { afterEach, describe, expect, it } from 'bun:test'
import {
  ensurePricingCatalog,
  parseOpenRouterModels,
  providerFromSource,
  providerLabel,
  resetPricingCache,
  resolveModelRate,
  seedPricingCatalog,
  usePricingFetch,
} from '../../services/model-pricing'

afterEach(() => {
  seedPricingCatalog(null)
  usePricingFetch(null)
  resetPricingCache()
})

describe('external pricing catalog', () => {
  it('parses OpenRouter per-token prices into $/million and keeps provider/model split', () => {
    const rates = parseOpenRouterModels({
      data: [
        { id: 'x-ai/grok-4.6', pricing: { prompt: '0.000002', completion: '0.000006' } },
        { id: 'x-ai/grok-4', pricing: { prompt: '0.000003', completion: '0.000015' } },
        { id: 'anthropic/claude-sonnet-5', pricing: { prompt: '0.000002', completion: '0.00001' } },
      ],
    })
    seedPricingCatalog({
      rates,
      providers: { xai: { label: 'xAI' }, anthropic: { label: 'Anthropic' } },
    })
    const grok46 = resolveModelRate('grok-4.6')
    const grok4 = resolveModelRate('grok-4')
    expect(grok46?.provider).toBe('xai')
    expect(grok46?.inputPerMillion).toBe(2)
    expect(grok46?.outputPerMillion).toBe(6)
    expect(grok4?.inputPerMillion).toBe(3)
    expect(grok4?.outputPerMillion).toBe(15)
    expect(resolveModelRate('claude-sonnet-5')?.inputPerMillion).toBe(2)
  })

  it('picks up a provider that only exists in the remote catalog — no code change', async () => {
    usePricingFetch(async () => ({
      data: [{ id: 'acme/acme-titan', pricing: { prompt: '0.000009', completion: '0.000011' } }],
    }))
    await ensurePricingCatalog({ force: true })
    const rate = resolveModelRate('acme-titan-2')
    expect(rate?.provider).toBe('acme')
    expect(rate?.inputPerMillion).toBe(9)
    expect(rate?.outputPerMillion).toBe(11)
    expect(providerLabel('acme')).toBe('acme')
    expect(providerFromSource('acme-transcript:acme-titan-2')).toBe('acme')
  })
})
