/**
 * Daemon-shim ↔ manifest skip-list invariant.
 *
 * Bin-handled commands are declared ONCE in the manifest
 * (`routingMode: 'bin-only'` in command-data.ts). `bin/prjct.ts` imports
 * the derived `BIN_COMMANDS_SET`, and the shim emitted by scripts/build.js
 * evaluates the same manifest at build time (`deriveShimSkipSet`). This
 * test asserts the GENERATED shim's skip set stays a superset of the
 * manifest's bin-only commands — drift here is what made `prjct crew
 * install` run `prjct init` in 2.3.5.
 */

import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { BIN_COMMANDS_SET } from '../../commands/verb-names'

const ROOT = path.resolve(__dirname, '../../..')

// build.js guards its main() behind require.main, so requiring it only
// pulls the helpers (no build side effects).
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { generateDaemonShim } = require(path.join(ROOT, 'scripts/build.js')) as {
  generateDaemonShim: () => string
}

function extractShimSkip(): Set<string> {
  // Parse the skip Set out of the GENERATED shim text — the artifact users
  // actually run — not out of any source literal.
  const shim = generateDaemonShim()
  const m = shim.match(/const skip=new Set\(\[([^\]]+?)\]\)/)
  if (!m) throw new Error('Could not find skip declaration in the generated shim')
  const out = new Set<string>()
  for (const s of m[1].matchAll(/['"]([^'"]+)['"]/g)) out.add(s[1])
  return out
}

function extractBinUsage(): string {
  return fs.readFileSync(path.join(ROOT, 'bin/prjct.ts'), 'utf-8')
}

describe('daemon-shim ↔ manifest sync', () => {
  test('every manifest bin-only command appears in the generated shim skip set', () => {
    const shim = extractShimSkip()
    const missing = [...BIN_COMMANDS_SET].filter((c) => !shim.has(c))
    expect(missing).toEqual([])
  })

  test('bin/prjct.ts derives _binCommands from the manifest (no literal)', () => {
    const src = extractBinUsage()
    expect(src).toContain('BIN_COMMANDS_SET')
    expect(src).not.toMatch(/const _binCommands = new Set\(\[/)
  })

  test('crew is bin-only in the manifest and skipped by the shim (regression 2.3.5)', () => {
    expect(BIN_COMMANDS_SET.has('crew')).toBe(true)
    expect(extractShimSkip().has('crew')).toBe(true)
  })

  test('detached-child internals are skipped by the shim (never routed to the daemon)', () => {
    // `__internal-auto-update` and `__post-upgrade` are handled at the very
    // top of bin/prjct.ts. The shim's default for unknown commands is the
    // daemon — which has no registry handler for them, so routing there
    // makes the detached children silently fail (stdio is ignored).
    const shim = extractShimSkip()
    expect(shim.has('__internal-auto-update')).toBe(true)
    expect(shim.has('__post-upgrade')).toBe(true)

    const src = extractBinUsage()
    expect(src).toContain("_initialFastCommand === '__post-upgrade'")
    // The upgrade block must NOT run setup synchronously on the user's
    // command path (the regression this guards: ~30s stall on the first
    // command after every upgrade).
    expect(src).toContain("spawn(process.execPath, [process.argv[1], '__post-upgrade']")
  })
})

/**
 * Fallback-policy regression: the shim must NOT silently re-execute a command
 * that the daemon may have already started running.
 *
 * Background: v2.19.1 → v2.19.2 and v2.19.3 → v2.19.4 each shipped twice
 * because the shim's 5s timeout fell through to a full re-import of
 * prjct-core, while the daemon's slow `ship` step kept running. Source
 * `bin/prjct.ts` (commit d08727b8) was hardened to refuse retry on anything
 * except ECONNREFUSED/ENOENT — the shim was missed.
 */
describe('daemon-shim fallback policy', () => {
  const buildSrc = fs.readFileSync(path.join(ROOT, 'scripts/build.js'), 'utf-8')

  test('generic-path timeout is 30s default / 10min long verbs; short timeouts are fail-soft', () => {
    // Dual budget mirrors commandRequestTimeoutMs() in protocol.ts:
    // snappy verbs 30s, long verbs (ship/sync/…) 10min. Timeout still refuse()s
    // — never re-imports core (that was the double-ship bug class).
    expect(buildSrc).toMatch(/waitMs\s*=\s*LONG\.has\(cmd\)\s*\?\s*600000\s*:\s*30000/)
    expect(buildSrc).toMatch(/setTimeout\([^,]+,\s*waitMs\)/)
    expect(buildSrc).toContain('"ship"')
    // A 5s timeout used to be a hair-trigger that fell through to a core
    // re-import, double-running mutating commands like `ship`. The hook fast
    // path reintroduces a short (5s) timeout ON PURPOSE — a hook must never
    // freeze the agent turn — but it is fail-soft: every 5s timeout routes to
    // `soft`, which writes the empty no-op `{}` and exits 0. It must NEVER
    // call fallback() (which re-imports core and could double-run).
    const fiveSecTimeouts = buildSrc.match(/setTimeout\([^,]*,\s*5000\)/g) ?? []
    for (const t of fiveSecTimeouts) {
      expect(t).toContain('soft')
      expect(t).not.toContain('fallback')
    }
  })

  test('socket error path checks safe connect failures before fallback', () => {
    // These mean the daemon request never reached a server, so cold fallback is safe.
    expect(buildSrc).toContain('ECONNREFUSED')
    expect(buildSrc).toContain('ENOENT')
    expect(buildSrc).toContain('EACCES')
    expect(buildSrc).toContain('EPERM')
    expect(buildSrc).toMatch(/isSafeRetry|safeRetry/)
  })

  test('socket close before response does NOT silently re-import core', () => {
    // The pre-fix shim had `sock.on("close",()=>{...;fallback()})` — that's
    // what made ship re-run mid-flight. Reject any line that pairs
    // `sock.on("close"` with an unconditional fallback().
    const closeHandler = buildSrc.match(/sock\.on\("close"[^)]*\)[^;]*;?/g) ?? []
    expect(closeHandler.length).toBeGreaterThan(0)
    for (const h of closeHandler) {
      // It is OK if the close handler calls refuse() or another non-recursive
      // helper; it is NOT OK if it falls through to fallback() unconditionally.
      const callsFallback = /fallback\(\)/.test(h)
      const callsRefuse = /refuse\(/.test(h)
      // If we ever fall back from close, it must be gated by a safe-retry check
      // — which today only lives in the error handler. Close = always refuse.
      if (callsFallback) expect(callsRefuse).toBe(true)
    }
  })

  test('timeout path does NOT silently re-import core', () => {
    // Same hazard: the daemon may still be working when the shim gives up.
    const timeoutBlock = buildSrc.match(/setTimeout\(\(\)\s*=>\s*\{[^}]+\}/g) ?? []
    const shimTimeout = timeoutBlock.find(
      (block) => block.includes('completion.signal.aborted') && block.includes('sock')
    )
    expect(shimTimeout).toBeDefined()
    if (shimTimeout) {
      const callsFallback = /fallback\(\)/.test(shimTimeout)
      const callsRefuse = /refuse\(/.test(shimTimeout)
      if (callsFallback) expect(callsRefuse).toBe(true)
    }
  })
})
