/**
 * Command-manifest completeness invariants.
 *
 * command-data.ts is the single source of truth for which commands exist
 * and where they route: `routingMode: 'bin-only'` drives `_binCommands`
 * (bin/prjct.ts) AND the daemon shim's skip set (scripts/build.js), and
 * `optionSchema` drives generic flag mapping in BOTH dispatch paths.
 * These tests pin the invariants that make "add a command = one manifest
 * entry" true.
 */

import { describe, expect, test } from 'bun:test'
import { BIN_ONLY_COMMANDS, COMMAND_ALIASES, COMMANDS } from '../../commands/command-data'
import { mapOptions } from '../../commands/option-mapper'
import { groupLoaders } from '../../commands/register'
import { BIN_COMMANDS_SET, REGISTERED_VERBS_SET } from '../../commands/verb-names'

describe('command manifest — completeness', () => {
  test('every bin-only command has a manifest entry (no ghost commands)', () => {
    const names = new Set(COMMANDS.map((c) => c.name))
    const ghosts = [...BIN_ONLY_COMMANDS].filter((c) => !names.has(c) && !(c in COMMAND_ALIASES))
    expect(ghosts).toEqual([])
  })

  test('aliases resolve to real bin-only entries', () => {
    const names = new Set(COMMANDS.map((c) => c.name))
    for (const [alias, target] of Object.entries(COMMAND_ALIASES)) {
      expect(names.has(target)).toBe(true)
      expect(alias.startsWith('-')).toBe(true)
    }
  })

  test('BIN_COMMANDS_SET re-export matches the manifest derivation', () => {
    expect([...BIN_COMMANDS_SET].sort()).toEqual([...BIN_ONLY_COMMANDS].sort())
  })

  test('no command is both bin-only and expected on the daemon verb fast-path', () => {
    // A bin-only command may still have registry routing (cold-path reuse),
    // but the daemon fast path in bin/prjct.ts excludes _binCommands first —
    // assert the two sets at least make that exclusion meaningful.
    const both = [...BIN_COMMANDS_SET].filter(
      (c) => REGISTERED_VERBS_SET.has(c) && !COMMANDS.find((m) => m.name === c)?.routing
    )
    expect(both).toEqual([])
  })

  test('upgrade is both bin-only and registry-routed to update', () => {
    const meta = COMMANDS.find((c) => c.name === 'upgrade')
    expect(meta?.routingMode).toBe('bin-only')
    expect(meta?.routing).toEqual({ group: 'update', method: 'update' })
    expect(BIN_COMMANDS_SET.has('upgrade')).toBe(true)
    expect(REGISTERED_VERBS_SET.has('upgrade')).toBe(true)
  })

  test('every bin-commands handler is allowlisted (no GTD capture fallthrough)', async () => {
    // Handlers live as `args[0] === 'verb'` branches. If a verb is handled but
    // missing from BIN_ONLY_COMMANDS, multi-word GTD rewrites it to capture
    // before the cold path can run (harness score → inbox bug class).
    const fs = await import('node:fs/promises')
    const path = await import('node:path')
    // process.cwd() is the package root under `bun test` from repo root.
    const src = await fs.readFile(path.join(process.cwd(), 'core/cli/bin-commands.ts'), 'utf-8')
    const handlers = new Set<string>()
    for (const m of src.matchAll(/args\[0\]\s*===\s*'([a-z][a-z0-9:-]*)'/g)) {
      handlers.add(m[1]!)
    }
    // Flag aliases handled in the same file
    for (const m2 of src.matchAll(/args\[0\]\s*===\s*'(-{1,2}[a-z]+)'/g)) {
      handlers.add(m2[1]!)
    }
    const missing = [...handlers].filter(
      (v) => !BIN_COMMANDS_SET.has(v) && !REGISTERED_VERBS_SET.has(v)
    )
    expect(missing).toEqual([])
  })

  test('harness is bin-only so GTD never captures "harness score"', () => {
    expect(BIN_COMMANDS_SET.has('harness')).toBe(true)
    const meta = COMMANDS.find((c) => c.name === 'harness')
    expect(meta?.routingMode).toBe('bin-only')
  })

  test('schema-covered commands declare routing (the generic path needs a handler)', () => {
    const broken = COMMANDS.filter((c) => c.optionSchema && !c.routing).map((c) => c.name)
    expect(broken).toEqual([])
  })

  test('every daemon-routed simple command has an optionSchema', () => {
    // Complex signatures (object params, multi-positional, no-projectPath)
    // are the ONLY commands allowed to live outside the schema path.
    const complex = new Set([
      'sync',
      'init',
      'analyze',
      'analysis-save-llm',
      'spec',
      'audit-spec',
      'regen',
      'start',
      'setup',
      'update',
      'upgrade',
      'uninstall',
      'login',
      'logout',
      'auth',
    ])
    const missing = COMMANDS.filter(
      (c) => c.routing && !complex.has(c.name) && !c.optionSchema
    ).map((c) => c.name)
    expect(missing).toEqual([])
  })
})

describe('command manifest — handler validation', () => {
  test('every routing.method exists on its group class', async () => {
    // registerLazyMethod defers "method is not a function" from registration
    // to first dispatch — a typo'd routing.method in the manifest would only
    // surface when a user runs the verb. This test restores the old
    // registration-time guarantee at CI time: instantiate every group once
    // and probe each method.
    const missing: string[] = []
    for (const meta of COMMANDS) {
      if (!meta.routing) continue
      const instance = (await groupLoaders[meta.routing.group]()) as Record<string, unknown>
      if (typeof instance[meta.routing.method] !== 'function') {
        missing.push(`${meta.name} -> ${meta.routing.group}.${meta.routing.method}`)
      }
    }
    expect(missing).toEqual([])
  })
})

describe('option mapper', () => {
  test('maps booleans, strings, numbers; md always included', () => {
    const mapped = mapOptions(
      { md: true, force: true, tags: 'a:b', limit: '3' },
      { booleans: ['force'], strings: ['tags'], numbers: ['limit'] }
    )
    expect(mapped).toEqual({ md: true, force: true, tags: 'a:b', limit: 3 })
  })

  test('resolves kebab-case wire flags to camelCase schema keys', () => {
    const mapped = mapOptions(
      { 'no-spec-gate': true, 'skip-hooks': true, 'base-url': 'http://x' },
      { booleans: ['noSpecGate', 'skipHooks'], strings: ['baseUrl'] }
    )
    expect(mapped.noSpecGate).toBe(true)
    expect(mapped.skipHooks).toBe(true)
    expect(mapped.baseUrl).toBe('http://x')
  })

  test('absent flags map to false (booleans) / undefined (strings, numbers)', () => {
    const mapped = mapOptions({}, { booleans: ['force'], strings: ['tags'], numbers: ['limit'] })
    expect(mapped.force).toBe(false)
    expect(mapped.tags).toBeUndefined()
    expect(mapped.limit).toBeUndefined()
    expect(mapped.md).toBe(false)
  })
})
