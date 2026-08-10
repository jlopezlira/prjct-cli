/**
 * Pack manager — activates/deactivates packs on a project config.
 *
 * Each test runs in a tmp project dir. `configManager` uses a fresh
 * LocalConfig per dir so these stay hermetic without env hacks.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import configManager from '../../infrastructure/config-manager'
import {
  aggregateMemoryTypes,
  aggregateSlots,
  PACK_MANIFESTS,
  PACK_NAMES,
} from '../../packs/manifests'
import {
  activatePacks,
  deactivatePacks,
  detectSuggestedPacks,
  ensureCodingAnticipationDefaults,
  listActivePacks,
} from '../../packs/pack-manager'

async function freshProject(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'prjct-pack-test-'))
  await fs.mkdir(path.join(dir, '.prjct'), { recursive: true })
  await configManager.writeConfig(dir, {
    projectId: 'test-proj',
    dataPath: path.join(dir, '.prjct-data'),
  })
  return dir
}

describe('pack-manager', () => {
  const fixture: {
    projectPath: string
  } = {
    projectPath: '',
  }

  beforeEach(async () => {
    fixture.projectPath = await freshProject()
  })

  afterEach(async () => {
    await fs.rm(fixture.projectPath, { recursive: true, force: true })
  })

  test('activatePacks adds packs to persona.packs', async () => {
    const result = await activatePacks(fixture.projectPath, ['pm', 'daily'])
    expect(result.activated.sort()).toEqual(['daily', 'pm'])
    expect(result.skipped).toEqual([])

    const config = await configManager.readConfig(fixture.projectPath)
    expect(config?.persona?.packs?.sort()).toEqual(['daily', 'pm'])
  })

  test('activatePacks reports unknown pack names as skipped', async () => {
    const result = await activatePacks(fixture.projectPath, ['pm', 'nonexistent'])
    expect(result.activated).toEqual(['pm'])
    expect(result.skipped).toEqual(['nonexistent'])
  })

  test('activatePacks is idempotent — second activation does not duplicate', async () => {
    await activatePacks(fixture.projectPath, ['pm'])
    const second = await activatePacks(fixture.projectPath, ['pm', 'daily'])
    expect(second.activated).toEqual(['daily'])

    const config = await configManager.readConfig(fixture.projectPath)
    expect(config?.persona?.packs?.sort()).toEqual(['daily', 'pm'])
  })

  test('activatePacks with suggestPersona lifts role from first applicable pack', async () => {
    // founder pack has suggestedPersona.role = 'Founder'
    await activatePacks(fixture.projectPath, ['founder'], { suggestPersona: true })
    const config = await configManager.readConfig(fixture.projectPath)
    expect(config?.persona?.role).toBe('Founder')
    expect(config?.persona?.mcps).toContain('linear')
  })

  test('code pack applies sdd/tdd/loop defaults on first activation only', async () => {
    await activatePacks(fixture.projectPath, ['code'])
    const config = await configManager.readConfig(fixture.projectPath)
    expect(config?.sdd?.mode).toBe('advisory')
    expect(config?.tdd?.mode).toBe('assist')
    expect(config?.maxTurnsPerCycle).toBe(25)
    expect(config?.deliveryGeometry?.mode).toBe('advisory')
    // Dominance P2: code pack forces land (session-close not optional).
    expect(config?.land?.mode).toBe('strict')
    // World-class product: anticipation ON (conflictMode advisory).
    expect(config?.judgment?.conflictMode).toBe('advisory')

    await configManager.writeConfig(fixture.projectPath, {
      ...config!,
      sdd: { mode: 'off' },
      tdd: { mode: 'off' },
      maxTurnsPerCycle: 99,
      persona: { role: 'DEV', packs: [] },
    })
    await activatePacks(fixture.projectPath, ['code'])
    const again = await configManager.readConfig(fixture.projectPath)
    expect(again?.sdd?.mode).toBe('off')
    expect(again?.tdd?.mode).toBe('off')
    expect(again?.maxTurnsPerCycle).toBe(99)
  })

  test('code-strict pack applies hard gates on first activation', async () => {
    await activatePacks(fixture.projectPath, ['code-strict'])
    const config = await configManager.readConfig(fixture.projectPath)
    expect(config?.sdd?.mode).toBe('strict')
    expect(config?.tdd?.mode).toBe('strict')
    expect(config?.deliveryGeometry?.mode).toBe('strict')
    expect(config?.land?.mode).toBe('strict')
    expect(config?.judgment?.conflictMode).toBe('strict')
  })

  test('activatePacks never overwrites an explicit persona role', async () => {
    // Pre-seed a custom role
    const existing = await configManager.readConfig(fixture.projectPath)
    await configManager.writeConfig(fixture.projectPath, {
      ...existing!,
      persona: { role: 'CustomRole' },
    })

    await activatePacks(fixture.projectPath, ['founder'], { suggestPersona: true })
    const config = await configManager.readConfig(fixture.projectPath)
    expect(config?.persona?.role).toBe('CustomRole')
  })

  test('deactivatePacks removes only the named packs', async () => {
    await activatePacks(fixture.projectPath, ['pm', 'daily', 'research'])
    const result = await deactivatePacks(fixture.projectPath, ['daily'])
    expect(result.deactivated).toEqual(['daily'])
    expect(result.notActive).toEqual([])

    const config = await configManager.readConfig(fixture.projectPath)
    expect(config?.persona?.packs?.sort()).toEqual(['pm', 'research'])
  })

  test('deactivatePacks reports inactive names', async () => {
    await activatePacks(fixture.projectPath, ['pm'])
    const result = await deactivatePacks(fixture.projectPath, ['founder'])
    expect(result.deactivated).toEqual([])
    expect(result.notActive).toEqual(['founder'])
  })

  test('listActivePacks returns summaries with memory types and slots', async () => {
    await activatePacks(fixture.projectPath, ['pm'])
    const list = await listActivePacks(fixture.projectPath)
    expect(list.length).toBe(1)
    expect(list[0].name).toBe('pm')
    expect(list[0].memoryTypes).toContain('insight')
    expect(list[0].slots).toContain('spec')
  })

  test('detectSuggestedPacks includes daily and code for a package.json repo', async () => {
    await fs.writeFile(
      path.join(fixture.projectPath, 'package.json'),
      JSON.stringify({ name: 'test', version: '1.0.0' }),
      'utf-8'
    )
    const suggested = await detectSuggestedPacks(fixture.projectPath)
    expect(suggested.sort()).toEqual(['code', 'daily'])
  })

  test('detectSuggestedPacks returns only daily when no code signals exist', async () => {
    const suggested = await detectSuggestedPacks(fixture.projectPath)
    expect(suggested).toEqual(['daily'])
  })

  test('ensureCodingAnticipationDefaults activates code pack on package.json repo', async () => {
    await fs.writeFile(
      path.join(fixture.projectPath, 'package.json'),
      JSON.stringify({ name: 'test', version: '1.0.0' }),
      'utf-8'
    )
    const result = await ensureCodingAnticipationDefaults(fixture.projectPath)
    expect(result.healed).toBe(true)
    expect(result.reason).toBe('activated-code')
    expect(result.activated).toContain('code')

    const config = await configManager.readConfig(fixture.projectPath)
    expect(config?.persona?.packs).toContain('code')
    expect(config?.judgment?.conflictMode).toBe('advisory')

    const again = await ensureCodingAnticipationDefaults(fixture.projectPath)
    expect(again.healed).toBe(false)
    expect(again.reason).toBe('already-coding-pack')
  })

  test('ensureCodingAnticipationDefaults respects conflictMode off opt-out', async () => {
    await fs.writeFile(
      path.join(fixture.projectPath, 'package.json'),
      JSON.stringify({ name: 'test', version: '1.0.0' }),
      'utf-8'
    )
    const existing = await configManager.readConfig(fixture.projectPath)
    await configManager.writeConfig(fixture.projectPath, {
      ...existing!,
      judgment: { conflictMode: 'off' },
    })
    const result = await ensureCodingAnticipationDefaults(fixture.projectPath)
    expect(result.healed).toBe(false)
    expect(result.reason).toBe('conflictMode-off')
    const config = await configManager.readConfig(fixture.projectPath)
    expect(config?.persona?.packs ?? []).not.toContain('code')
  })

  test('ensureCodingAnticipationDefaults no-ops on non-code repo', async () => {
    const result = await ensureCodingAnticipationDefaults(fixture.projectPath)
    expect(result.healed).toBe(false)
    expect(result.reason).toBe('not-code-repo')
  })

  test('ensureCodingAnticipationDefaults heals missing conflictMode when code pack present', async () => {
    const existing = await configManager.readConfig(fixture.projectPath)
    await configManager.writeConfig(fixture.projectPath, {
      ...existing!,
      persona: { role: 'DEV', packs: ['code'] },
      // no judgment.conflictMode
    })
    const result = await ensureCodingAnticipationDefaults(fixture.projectPath)
    expect(result.healed).toBe(true)
    expect(result.reason).toBe('conflictMode-healed')
    const config = await configManager.readConfig(fixture.projectPath)
    expect(config?.judgment?.conflictMode).toBe('advisory')
  })

  test('manifests expose all declared packs', () => {
    for (const name of PACK_NAMES) {
      expect(PACK_MANIFESTS[name]).toBeDefined()
      expect(PACK_MANIFESTS[name].name).toBe(name)
    }
  })

  test('aggregateMemoryTypes unions across packs without duplicates', () => {
    const types = aggregateMemoryTypes(['pm', 'founder'])
    // Both declare 'decision' — should appear once.
    const count = types.filter((t) => t === 'decision').length
    expect(count).toBe(1)
  })

  test('lean pack declares its memory types and review/audit/debt slots', () => {
    expect(PACK_MANIFESTS.lean).toBeDefined()
    const types = aggregateMemoryTypes(['lean'])
    expect(types).toContain('over-engineering')
    expect(types).toContain('lean-debt')
    const slots = aggregateSlots(['lean'])
    expect(Object.keys(slots).sort()).toEqual(['audit', 'debt', 'review'])
  })

  test('aggregateSlots first-pack-wins precedence', () => {
    // Both `code` and `founder` have 'ship' slot (via code + via founder 'investor-update'...)
    // Actually `code` has `ship`; `founder` has `investor-update`. Use daily+code which share `review`.
    const slots = aggregateSlots(['daily', 'code'])
    expect(slots.review).toBeDefined()
    // daily is listed first → review comes from daily
    expect(slots.review.pack).toBe('daily')
  })
})
