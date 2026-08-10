/**
 * Pack marketplace-lite — local integrity + discovery (not a partner SaaS).
 *
 * Claude Marketplace pattern, local-first:
 *   - Every built-in pack has semver + content integrity hash
 *   - Activation stamps version@hash into project SoT (kv)
 *   - Catalog / verify surfaces so agents know what is trusted
 *
 * Packs stay declarative (persona + memory + slots). MCP tools stay
 * client-configured — we never become an MCP marketplace clone.
 */

import { createHash } from 'node:crypto'
import configManager from '../infrastructure/config-manager'
import { prjctDb } from '../storage/database'
import { getTimestamp } from '../utils/date-helper'
import { getPackManifest, PACK_MANIFESTS, PACK_NAMES, type PackManifest } from './manifests'

/** kv_store key for activation receipts (marketplace-lite audit trail). */
export const PACK_INSTALLS_KEY = 'packs:installs'

export interface PackInstallReceipt {
  name: string
  version: string
  /** sha256 of canonical pack body (16-hex prefix for display). */
  integrity: string
  activatedAt: string
}

export type PackInstallsBook = Record<string, PackInstallReceipt>

export interface PackCatalogEntry {
  name: string
  version: string
  description: string
  integrity: string
  active: boolean
  /** When active: receipt version vs live manifest. */
  status: 'available' | 'active' | 'unknown' | 'stale' | 'mismatch'
  memoryTypes: string[]
  slots: string[]
  receipt?: PackInstallReceipt
}

/**
 * Stable content hash of a pack definition (excludes nothing structural).
 * Same pack body → same integrity across machines.
 */
export function packIntegrityHash(manifest: PackManifest): string {
  const body = {
    name: manifest.name,
    version: manifest.version,
    description: manifest.description,
    memoryTypes: [...manifest.memoryTypes].sort(),
    workflowSlots: sortKeys(manifest.workflowSlots),
    hookSignals: manifest.hookSignals,
    suggestedTags: manifest.suggestedTags
      ? Object.fromEntries(
          Object.entries(manifest.suggestedTags)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([k, v]) => [k, [...v].sort()])
        )
      : undefined,
    suggestedPersona: manifest.suggestedPersona,
    configDefaults: manifest.configDefaults,
  }
  return createHash('sha256').update(JSON.stringify(body)).digest('hex').slice(0, 16)
}

function sortKeys<T extends Record<string, unknown>>(obj: T): T {
  const out: Record<string, unknown> = {}
  for (const k of Object.keys(obj).sort()) out[k] = obj[k]
  return out as T
}

export function loadPackInstalls(projectId: string): PackInstallsBook {
  try {
    const raw = prjctDb.getDoc<PackInstallsBook>(projectId, PACK_INSTALLS_KEY)
    if (!raw || typeof raw !== 'object') return {}
    return raw
  } catch {
    return {}
  }
}

export function savePackInstalls(projectId: string, book: PackInstallsBook): void {
  prjctDb.setDoc(projectId, PACK_INSTALLS_KEY, book)
}

/**
 * Stamp activation receipts for packs just activated (or re-verify all active).
 */
export function stampPackInstalls(
  projectId: string,
  packNames: string[],
  now: string = getTimestamp()
): PackInstallReceipt[] {
  const book = loadPackInstalls(projectId)
  const stamped: PackInstallReceipt[] = []
  for (const name of packNames) {
    const m = getPackManifest(name)
    if (!m) continue
    const receipt: PackInstallReceipt = {
      name: m.name,
      version: m.version,
      integrity: packIntegrityHash(m),
      activatedAt: now,
    }
    book[name] = receipt
    stamped.push(receipt)
  }
  savePackInstalls(projectId, book)
  return stamped
}

/** Drop receipts when packs are deactivated. */
export function clearPackInstalls(projectId: string, packNames: string[]): void {
  const book = loadPackInstalls(projectId)
  const removedPacks: string[] = []
  for (const name of packNames) {
    if (book[name]) {
      delete book[name]
      removedPacks.push(name)
    }
  }
  if (removedPacks.length > 0) savePackInstalls(projectId, book)
}

/**
 * Full local catalog: all built-in packs + activation status + integrity.
 */
export async function buildPackCatalog(projectPath: string): Promise<PackCatalogEntry[]> {
  const config = await configManager.readConfig(projectPath)
  const active = new Set(config?.persona?.packs ?? [])
  const projectId = config?.projectId
  const installs = projectId ? loadPackInstalls(projectId) : {}

  const entries: PackCatalogEntry[] = []
  for (const name of PACK_NAMES) {
    const m = PACK_MANIFESTS[name]!
    const integrity = packIntegrityHash(m)
    const isActive = active.has(name)
    const receipt = installs[name]
    const status: PackCatalogEntry['status'] =
      isActive && receipt && (receipt.integrity !== integrity || receipt.version !== m.version)
        ? 'stale'
        : isActive
          ? 'active'
          : 'available'
    entries.push({
      name: m.name,
      version: m.version,
      description: m.description,
      integrity,
      active: isActive,
      status,
      memoryTypes: m.memoryTypes,
      slots: Object.keys(m.workflowSlots),
      receipt,
    })
  }

  // Unknown names still listed in persona.packs (corrupt / future remote)
  for (const name2 of active) {
    if (PACK_MANIFESTS[name2]) continue
    const receipt = installs[name2]
    entries.push({
      name: name2,
      version: receipt?.version ?? '?',
      description: 'Unknown pack (not in built-in catalog)',
      integrity: receipt?.integrity ?? '—',
      active: true,
      status: 'unknown',
      memoryTypes: [],
      slots: [],
      receipt,
    })
  }

  return entries.sort((a, b) => a.name.localeCompare(b.name))
}

export interface PackVerifyReport {
  ok: boolean
  active: number
  stale: string[]
  unknown: string[]
  entries: PackCatalogEntry[]
}

export async function verifyActivePacks(projectPath: string): Promise<PackVerifyReport> {
  const catalog = await buildPackCatalog(projectPath)
  const active = catalog.filter((e) => e.active)
  const stale = active.filter((e) => e.status === 'stale').map((e) => e.name)
  const unknown = active.filter((e) => e.status === 'unknown').map((e) => e.name)
  return {
    ok: stale.length === 0 && unknown.length === 0,
    active: active.length,
    stale,
    unknown,
    entries: active,
  }
}

export function formatPackCatalogMd(entries: PackCatalogEntry[]): string {
  const lines = [
    '# prjct pack catalog (marketplace-lite)',
    '',
    'Local built-in packs with version + integrity. Activate with `prjct seed add <name>`.',
    'Not a third-party MCP marketplace — packs = persona + memory types + workflow slots.',
    '',
    '| Pack | Ver | Active | Status | Integrity | Description |',
    '|---|---|---|---|---|---|',
  ]
  for (const e of entries) {
    const act = e.active ? 'yes' : '—'
    lines.push(
      `| \`${e.name}\` | ${e.version} | ${act} | ${e.status} | \`${e.integrity}\` | ${e.description.replace(/\|/g, '\\|')} |`
    )
  }
  lines.push('')
  lines.push('## Integrity')
  lines.push('')
  lines.push(
    '- On `seed add`, prjct stamps `version@integrity` into project SoT (`packs:installs`).'
  )
  lines.push(
    '- `prjct seed verify` flags **stale** (CLI pack upgraded since activate) or **unknown**.'
  )
  lines.push('- Re-activate with `prjct seed add <name>` to refresh the receipt after upgrade.')
  lines.push('')
  return lines.join('\n')
}

export function formatPackVerifyMd(report: PackVerifyReport): string {
  const lines = [
    '# prjct pack verify',
    '',
    report.ok
      ? `**OK** — ${report.active} active pack(s), integrity clean.`
      : `**Attention** — ${report.stale.length} stale, ${report.unknown.length} unknown.`,
    '',
  ]
  if (report.stale.length) {
    lines.push(`- Stale (re-add to refresh): ${report.stale.map((n) => `\`${n}\``).join(', ')}`)
  }
  if (report.unknown.length) {
    lines.push(`- Unknown (remove or restore): ${report.unknown.map((n) => `\`${n}\``).join(', ')}`)
  }
  if (report.entries.length) {
    lines.push('', '| Pack | Ver | Status | Integrity |', '|---|---|---|---|')
    for (const e of report.entries) {
      lines.push(`| \`${e.name}\` | ${e.version} | ${e.status} | \`${e.integrity}\` |`)
    }
  }
  lines.push('')
  return lines.join('\n')
}
