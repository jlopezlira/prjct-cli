/**
 * Cold-path ↔ daemon-path option-forwarding parity.
 *
 * Root-cause guard for a recurring class of bug ("works in the terminal,
 * broken via the daemon"): a command's COLD handler in `core/index.ts`
 * (`standardCommands`) reads option flags (`options.key`, `options['no-spec-
 * gate']`, …) and forwards them, but the DAEMON path (`core/daemon/dispatch.ts`)
 * has no explicit `case` for it — so it falls through to the option-less
 * `commandRegistry.execute`, silently dropping every flag.
 *
 * This bit `embeddings` (`set --key` became a no-op via the daemon, 2.34.0)
 * and `init`/`login`/`auth` (flags dropped; `regen` no longer exists — the
 * vault feature it regenerated was removed). Every command whose cold
 * handler consumes an `options.X` flag MUST be either:
 *   - cold-handled (listed in `_binCommands` in bin/prjct.ts → never forwarded), or
 *   - explicitly cased in dispatch.ts (so the daemon forwards its flags).
 *
 * If this test fails, add a `case` in dispatch.ts mirroring the index.ts handler
 * (and pass `request.cwd`, not the daemon's cwd).
 */

import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { COMMANDS } from '../../commands/command-data'
import { BIN_COMMANDS_SET } from '../../commands/verb-names'

const ROOT = path.resolve(__dirname, '../../..')

/** Keys in `standardCommands` whose handler body reads an `options.X` flag. */
function optionBearingColdCommands(): string[] {
  const src = fs.readFileSync(path.join(ROOT, 'core/index.ts'), 'utf-8')
  const start = src.indexOf('const standardCommands')
  // The object is consumed right after via `standardCommands[commandName]`.
  const end = src.indexOf('const handler = standardCommands', start)
  if (start < 0 || end < 0) throw new Error('Could not bound standardCommands in core/index.ts')
  const block = src.slice(start, end)

  // Handler entries look like `  task: (p) =>` / `  'audit-spec': (p) =>` /
  // `  logout: () =>`. Capture each key and the slice up to the next entry.
  // Indentation-tolerant: the block moved a nesting level when the
  // manifest-driven generic path landed.
  const keyRe = /\n\s{8,12}('?[\w-]+'?):\s*\(/g
  const entries: { key: string; index: number }[] = []
  for (const m of block.matchAll(keyRe)) {
    entries.push({ key: m[1].replace(/'/g, ''), index: m.index ?? 0 })
  }

  const optionBearing: string[] = []
  for (const i of Array.from({ length: entries.length }, (_, index) => index)) {
    const body = block.slice(entries[i].index, entries[i + 1]?.index ?? block.length)
    // A real option flag is `options.<name>` or `options['<name>']`. The
    // local `md` var and the positional `p` are not option flags.
    if (/\boptions[.[]/.test(body)) optionBearing.push(entries[i].key)
  }
  return optionBearing
}

function dispatchCaseLabels(): Set<string> {
  const src = fs.readFileSync(path.join(ROOT, 'core/daemon/dispatch.ts'), 'utf-8')
  const out = new Set<string>()
  for (const m of src.matchAll(/case\s+'([\w-]+)'\s*:/g)) out.add(m[1])
  return out
}

function schemaCoveredCommands(): Set<string> {
  return new Set(COMMANDS.filter((c) => c.optionSchema).map((c) => c.name))
}

describe('cold ↔ daemon option-forwarding parity', () => {
  test('every option-bearing cold command is bin-only, schema-covered, or explicitly cased', () => {
    const optionBearing = optionBearingColdCommands()
    // Sanity: the extractor still finds the known flag-bearing complex commands.
    expect(optionBearing).toContain('init')
    expect(optionBearing).toContain('sync')

    const cased = dispatchCaseLabels()
    const schema = schemaCoveredCommands()

    const dropped = optionBearing.filter(
      (c) => !BIN_COMMANDS_SET.has(c) && !cased.has(c) && !schema.has(c)
    )
    expect(dropped).toEqual([])
  })

  test('the historically-broken commands are schema-covered, bin-only, or explicitly cased', () => {
    const cased = dispatchCaseLabels()
    const schema = schemaCoveredCommands()
    // embeddings/capture lost flags via the daemon in 2.34.0/2.37.x —
    // they're now schema-covered (the generic path), the rest keep cases.
    for (const c of ['embeddings', 'capture', 'ship', 'task', 'team', 'guard', 'remember']) {
      expect(schema.has(c)).toBe(true)
    }
    for (const c2 of ['init']) {
      expect(cased.has(c2)).toBe(true)
    }
    for (const c3 of ['login', 'logout', 'auth']) {
      expect(BIN_COMMANDS_SET.has(c3)).toBe(true)
      expect(cased.has(c3)).toBe(false)
    }
  })

  test('no schema-covered command keeps a hand-written dispatch case', () => {
    // The generic path owns schema-covered commands; a re-added case would
    // shadow the manifest and reintroduce cold↔daemon divergence.
    const cased = dispatchCaseLabels()
    const overlap = [...schemaCoveredCommands()].filter((c) => cased.has(c))
    expect(overlap).toEqual([])
  })
})
