/**
 * Shared `k:v,k2:v2` tag-flag parser.
 *
 * Used by every command that accepts `--tags k:v,...` (capture, remember,
 * spec inventory). Malformed pairs (no `:`, or `:` in position 0) are
 * silently skipped rather than rejected — tagging is best-effort metadata,
 * not validated input.
 */
export function parseFlagTags(raw: string | undefined): Record<string, string> {
  if (!raw) return {}
  const tags: Record<string, string> = {}
  for (const token of raw.split(',')) {
    const pair = token.trim()
    const idx = pair.indexOf(':')
    if (idx > 0) tags[pair.slice(0, idx)] = pair.slice(idx + 1)
  }
  return tags
}
