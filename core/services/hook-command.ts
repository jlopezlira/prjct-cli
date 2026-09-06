/**
 * Shared hook command chain builder — the native hook-fast → direct
 * runtime+shim → portable `prjct` fallback chain every hook-capable host
 * installer (Claude settings-installer, Kimi, Gemini, Cursor) writes into
 * its host's hook config.
 *
 * Extracted from settings-installer.ts so all hosts share ONE binary-path
 * resolution + chain-shape implementation. The native hook-fast binary
 * forwards PRJCT_HOOK_HOST on the daemon wire (native/hook-fast.c —
 * getenv + `hookHost` field), so non-Claude hosts lose nothing by taking
 * the native fast path: each stage of the chain carries the host env
 * inline (`PRJCT_HOOK_HOST=<host> <stage>`).
 */

import { existsSync } from 'node:fs'
import path from 'node:path'

/**
 * Absolute `runtime + shim` prefix for the hook command, when resolvable.
 *
 * Perf: the portable `prjct hook X` form pays for the POSIX wrapper
 * (bin/prjct): symlink resolution, runtime detection, ~5-8 forks ≈ 10-15ms
 * on EVERY hook event. Hooks fire per prompt/tool-call, so install time is
 * the right moment to resolve the direct path: the running CLI knows its own
 * runtime (process.execPath) and the shipped daemon shim's location.
 * The wrapper form stays as the `||` fallback — if the resolved runtime or
 * shim disappears (bun uninstalled, package moved), the hook still works.
 *
 * Layouts covered: bundled core (dist/bin/prjct-core.mjs → shim sibling),
 * split hook chunks (dist/bin/hook-chunks/ → one level up), daemon bundle
 * and source tree (…/dist/bin/prjct.mjs two levels up).
 */
export function directHookPrefix(): string | null {
  if (process.platform === 'win32') return null
  const exec = process.execPath
  if (!exec) return null
  const here = __dirname
  const shim = [
    path.join(here, 'prjct.mjs'),
    path.resolve(here, '..', 'prjct.mjs'),
    path.resolve(here, '..', '..', 'dist', 'bin', 'prjct.mjs'),
  ].find((candidate) => existsSync(candidate))
  if (!shim) return null
  // Node <24 needs the node:sqlite flag for the shim's COLD fallback
  // (prjct-hooks.mjs → storage). Bun and Node 24+ tolerate it regardless;
  // prefixing unconditionally keeps the command correct across runtimes.
  const env = path.basename(exec).includes('bun')
    ? ''
    : // biome-ignore lint/suspicious/noTemplateCurlyInString: intentional shell parameter expansion, not JS
      'NODE_OPTIONS="--experimental-sqlite${NODE_OPTIONS:+ $NODE_OPTIONS}" '
  return `${env}"${exec}" "${shim}"`
}

/**
 * Absolute path to the compiled native hook-fast binary for THIS platform
 * + arch (`hook-fast-<platform>-<arch>`, matching Node's own
 * process.platform/process.arch strings — see buildNativeHookFast() in
 * scripts/build.js), when the build produced one.
 *
 * Perf: this binary is a native process (no bun/node runtime boot), so it
 * removes the ~15-25ms of interpreted-runtime startup the bun-based
 * direct path (below) still pays on every hook fire. Measured end-to-end
 * against a warm daemon: ~68-73% faster than the bun shim for the same
 * request. POSIX only — native/hook-fast.c has no Windows named-pipe
 * support, so this returns null on win32 (directHookPrefix() already
 * special-cases that platform for the same reason).
 *
 * Purely additive: hookCommandChain() tries this FIRST, but every existing
 * fallback stays exactly as it was — a platform this build didn't produce
 * a binary for (no C toolchain at build time, or a target build.js
 * couldn't reach) just keeps using the bun-based path, identical to
 * before this existed.
 */
export function nativeHookFastBinary(): string | null {
  if (process.platform === 'win32') return null
  const here = __dirname
  const label = `hook-fast-${process.platform}-${process.arch}`
  return (
    [
      path.join(here, label),
      path.resolve(here, '..', label),
      path.resolve(here, '..', '..', 'dist', 'bin', label),
    ].find((candidate) => existsSync(candidate)) ?? null
  )
}

/**
 * Shell command for a hook — tries the native binary first, then the
 * resolved `runtime + shim` fast path, falls back to the installed
 * `prjct` binary on PATH.
 *
 * `hostEnv` (e.g. `PRJCT_HOOK_HOST=kimi`) is inlined in front of EVERY
 * stage, so whichever stage ends up serving the event sees the invoking
 * host and adapts its output (the native binary forwards it to the daemon
 * as `hookHost`; the runtime stages read it from their own env).
 *
 * Resilience: the chain ends in a `command -v` guard so that if `prjct`
 * is missing from PATH (uninstall, package-manager move, broken nvm
 * shim, post-cleanup stranding), the hook silently no-ops with exit 0
 * rather than spamming "command not found" errors into every host
 * session. The user can still see prjct is missing — they just
 * see it on `prjct -v`, not on every Stop hook fire.
 *
 * Precedence note: shell `&&`/`||` are left-associative with EQUAL
 * precedence, so the fast path and the portable guard are joined through a
 * braced group — `A || { B && C; } || exit 0` — otherwise the fallback
 * would fire even when the fast path succeeds. PRJCT_BIN keeps its
 * override and forces the portable form. The native binary and the direct
 * bun form are both plain commands (no internal `&&`), so chaining them
 * with plain `||` ahead of the braced portable group needs no extra
 * bracing — see native/hook-fast.c's docstring for why it's safe to punt
 * to the next stage at all (pre-stdin it never touches the pipe; post-stdin
 * it spills the payload to a run-dir scratch file the next stage re-reads
 * via core/hooks/stdin-spill.ts).
 */
/**
 * Single-quote a value for the POSIX shell unless it is already a plain
 * word. `PRJCT_BIN` is user-controlled and is interpolated into the host's
 * hook command, so `prjct; rm -rf ~` must arrive as one argument, not two.
 */
export function shellWord(value: string): string {
  return /^[A-Za-z0-9_./=:@%+,-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`
}

export function hookCommandChain(subcommand: string, hostEnv?: string): string {
  const bin = shellWord(process.env.PRJCT_BIN ?? 'prjct')
  const env = hostEnv ? `${hostEnv} ` : ''
  const portable = `command -v ${bin} >/dev/null 2>&1 && ${env}${bin} hook ${subcommand} || exit 0`
  if (process.env.PRJCT_BIN) return portable
  const direct = directHookPrefix()
  if (!direct) return portable
  const directStage = `${env}${direct} hook ${subcommand}`
  const native = nativeHookFastBinary()
  const fastStage = native ? `${env}"${native}" ${subcommand} || ${directStage}` : directStage
  // Precedence: shell `&&`/`||` are LEFT-associative with EQUAL precedence,
  // so `A || B && C || exit 0` groups as `((A || B) && C) || exit 0` — the
  // fallback hook would run EVEN WHEN the fast path succeeded (double hook
  // fire per event). The braces force the intended `A || (B && C) || exit 0`.
  return `${fastStage} || { ${portable.replace(' || exit 0', '')}; } || exit 0`
}
