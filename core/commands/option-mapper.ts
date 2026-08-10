/**
 * Generic wire-options → handler-options mapping, driven by a command's
 * `optionSchema` (command-data.ts). Both the daemon dispatch and the cold
 * path in core/index.ts route schema-covered commands through this one
 * function, so a command can never lose its flags by missing a
 * hand-written case — the daemon "flag-strip" bug class is gone by
 * construction.
 *
 * Schema keys are the handler's camelCase option names; wire flags arrive
 * kebab-cased (`--no-spec-gate`), so each key is looked up in both forms.
 */

import type { CommandOptionSchema } from '../types/commands'

function kebab(key: string): string {
  return key.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase()
}

export function mapOptions(
  opts: Record<string, unknown>,
  schema: CommandOptionSchema
): Record<string, unknown> {
  // Precedence: an explicit camelCase key wins over its kebab twin when a
  // caller (test / programmatic DaemonRequest) supplies both. The CLI parser
  // only ever produces kebab keys, so the wire path is unambiguous.
  const pick = (key: string): unknown => (opts[key] !== undefined ? opts[key] : opts[kebab(key)])
  const result: Record<string, unknown> = { md: opts.md === true }
  for (const key of schema.booleans ?? []) {
    result[key] = pick(key) === true
  }
  for (const key2 of schema.strings ?? []) {
    const v = pick(key2)
    result[key2] = v != null && v !== false && v !== '' ? String(v) : undefined
  }
  for (const key3 of schema.numbers ?? []) {
    const v = pick(key3)
    const n = v != null && v !== false && v !== '' ? Number(v) : Number.NaN
    // Non-numeric input maps to undefined (flag ignored), never NaN —
    // handlers must not have to NaN-guard every numeric option.
    result[key3] = Number.isNaN(n) ? undefined : n
  }
  return result
}
