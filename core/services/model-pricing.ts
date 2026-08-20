/**
 * Live list prices for `prjct cost`.
 *
 * Source of truth is an EXTERNAL catalog (OpenRouter models API by default).
 * New providers/models appear when that catalog updates — not via a CLI ship.
 * Disk cache: ~/.prjct-cli/cache/openrouter-models.json (TTL 24h).
 * Override URL with PRJCT_PRICING_URL.
 */

import fs from 'node:fs'
import path from 'node:path'
import { resolveCliHome } from '../infrastructure/cli-home'

export type ProviderId = string

export interface ModelRate {
  prefix: string
  provider: ProviderId
  inputPerMillion: number
  outputPerMillion: number
}

export interface ProviderMeta {
  label: string
}

export interface PricingCatalog {
  fetchedAt?: number
  providers?: Record<string, ProviderMeta>
  rates?: ModelRate[]
}

const DEFAULT_PRICING_URL = 'https://openrouter.ai/api/v1/models'
const CACHE_TTL_MS = 24 * 60 * 60 * 1000
const FETCH_MS = 8000

const cache = {
  seeded: null as PricingCatalog | null,
  memory: null as PricingCatalog | null,
  testFetch: null as ((url: string) => Promise<unknown>) | null,
}

const PROVIDER_ALIASES: Record<string, string> = {
  'x-ai': 'xai',
  moonshotai: 'moonshot',
}

export function seedPricingCatalog(catalog: PricingCatalog | null): void {
  cache.seeded = catalog
  cache.memory = catalog
}

export function usePricingFetch(fn: ((url: string) => Promise<unknown>) | null): void {
  cache.testFetch = fn
  cache.memory = null
}

export function resetPricingCache(): void {
  cache.memory = cache.seeded
}

function dash(id: string): string {
  return id.toLowerCase().replace(/_/g, '-').replace(/\./g, '-')
}

function vendorTail(id: string): string {
  const n = dash(id)
  const slash = n.lastIndexOf('/')
  return slash >= 0 ? n.slice(slash + 1) : n
}

function rateKey(rate: ModelRate): string {
  return dash(rate.prefix)
}

function canonicalProvider(slug: string): string {
  const s = slug.toLowerCase()
  return PROVIDER_ALIASES[s] ?? s
}

function humanizeProvider(id: string): string {
  const hints: Record<string, string> = {
    xai: 'xAI',
    anthropic: 'Anthropic',
    openai: 'OpenAI',
    google: 'Google',
    moonshot: 'Moonshot',
  }
  return hints[id] ?? id
}

function pricingUrl(): string {
  return process.env.PRJCT_PRICING_URL?.trim() || DEFAULT_PRICING_URL
}

function cachePath(): string {
  return path.join(resolveCliHome(), 'cache', 'openrouter-models.json')
}

function readDiskCache(): PricingCatalog | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(cachePath(), 'utf-8')) as PricingCatalog
    if (!parsed?.rates?.length) return null
    return parsed
  } catch {
    return null
  }
}

function writeDiskCache(catalog: PricingCatalog): void {
  try {
    const file = cachePath()
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify(catalog))
  } catch {
    /* cache is best-effort */
  }
}

export function parseOpenRouterModels(payload: unknown): ModelRate[] {
  const root = payload && typeof payload === 'object' ? (payload as { data?: unknown }) : null
  const rows = Array.isArray(root?.data) ? root.data : []
  const rates: ModelRate[] = []
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue
    const rec = row as { id?: unknown; pricing?: { prompt?: unknown; completion?: unknown } }
    const id = typeof rec.id === 'string' ? rec.id : ''
    if (!id) continue
    const prompt = Number(rec.pricing?.prompt)
    const completion = Number(rec.pricing?.completion)
    if (!Number.isFinite(prompt) || !Number.isFinite(completion)) continue
    const slash = id.indexOf('/')
    const org = slash >= 0 ? id.slice(0, slash) : id
    const tail = slash >= 0 ? id.slice(slash + 1) : id
    const provider = canonicalProvider(org)
    const rate: ModelRate = {
      prefix: tail,
      provider,
      inputPerMillion: prompt * 1_000_000,
      outputPerMillion: completion * 1_000_000,
    }
    rates.push(rate)
  }
  return rates
}

function providersFromRates(rates: ModelRate[]): Record<string, ProviderMeta> {
  const providers: Record<string, ProviderMeta> = {}
  for (const rate of rates) {
    if (!providers[rate.provider]) {
      providers[rate.provider] = { label: humanizeProvider(rate.provider) }
    }
  }
  return providers
}

function sorted(rates: ModelRate[]): ModelRate[] {
  return [...rates].sort((a, b) => rateKey(b).length - rateKey(a).length)
}

function catalog(): PricingCatalog {
  return cache.memory ?? cache.seeded ?? { rates: [], providers: {} }
}

export async function ensurePricingCatalog(opts?: { force?: boolean }): Promise<void> {
  if (cache.seeded) {
    cache.memory = cache.seeded
    return
  }
  const now = Date.now()
  if (
    !opts?.force &&
    cache.memory?.rates?.length &&
    cache.memory.fetchedAt &&
    now - cache.memory.fetchedAt < CACHE_TTL_MS
  ) {
    return
  }
  const disk = readDiskCache()
  if (
    !opts?.force &&
    disk?.rates?.length &&
    disk.fetchedAt &&
    now - disk.fetchedAt < CACHE_TTL_MS
  ) {
    cache.memory = disk
    return
  }
  try {
    const url = pricingUrl()
    const payload = cache.testFetch ? await cache.testFetch(url) : await fetchRemote(url)
    const rates = sorted(parseOpenRouterModels(payload))
    if (rates.length === 0) {
      if (disk) cache.memory = disk
      return
    }
    cache.memory = {
      fetchedAt: now,
      rates,
      providers: providersFromRates(rates),
    }
    writeDiskCache(cache.memory)
  } catch {
    if (disk) cache.memory = disk
  }
}

async function fetchRemote(url: string): Promise<unknown> {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), FETCH_MS)
  try {
    const res = await fetch(url, { signal: ac.signal, headers: { accept: 'application/json' } })
    if (!res.ok) throw new Error(`pricing catalog HTTP ${res.status}`)
    return await res.json()
  } finally {
    clearTimeout(timer)
  }
}

export function resolveModelRate(modelId: string): ModelRate | null {
  const needle = vendorTail(modelId)
  if (!needle) return null
  for (const rate of sorted(catalog().rates ?? [])) {
    const prefix = rateKey(rate)
    if (needle === prefix || needle.startsWith(`${prefix}-`)) return rate
  }
  return null
}

export function providerFromSource(source: string): ProviderId {
  const s = source.toLowerCase()
  const token = s.split(/[-:/]/)[0] ?? ''
  const rates = catalog().rates ?? []
  for (const rate of rates) {
    if (
      s.includes(rate.provider) ||
      dash(rate.prefix).startsWith(`${token}-`) ||
      dash(rate.prefix) === token
    ) {
      return rate.provider
    }
  }
  for (const id of Object.keys(catalog().providers ?? {})) {
    if (s.includes(id)) return id
  }
  return 'unknown'
}

export function providerLabel(id: ProviderId): string {
  return catalog().providers?.[id]?.label ?? humanizeProvider(id)
}

export function apiCostUsd(
  tokensIn: number,
  tokensOut: number,
  rate: Pick<ModelRate, 'inputPerMillion' | 'outputPerMillion'>
): number {
  return (
    (tokensIn / 1_000_000) * rate.inputPerMillion + (tokensOut / 1_000_000) * rate.outputPerMillion
  )
}

export function formatUsd(amount: number): string {
  if (amount === 0) return '$0.00'
  if (Math.abs(amount) >= 0.01) return `$${amount.toFixed(2)}`
  return `$${amount.toFixed(4)}`
}
