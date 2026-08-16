/**
 * Shared `--flag value` / `--flag=value` parser for commands that accept
 * their own raw token array (as opposed to the CLI's pre-parsed `options`
 * object) — e.g. so a direct programmatic call or a test can pass a plain
 * string array and get the same parsing the CLI flag pre-parser gives.
 */
export function flag(parts: string[], name: string): string | undefined {
  const i = parts.indexOf(`--${name}`)
  if (i >= 0 && parts[i + 1]) return parts[i + 1]
  const eq = parts.find((p) => p.startsWith(`--${name}=`))
  return eq ? eq.slice(name.length + 3) : undefined
}
