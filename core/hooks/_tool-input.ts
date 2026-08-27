/** Portable extraction for hook payloads across Claude, Codex, Cursor, Gemini, and Kimi. */

export interface PortableHookInput {
  tool_input?: unknown
  toolInput?: unknown
  parameters?: unknown
  file_path?: unknown
  filePath?: unknown
  path?: unknown
}

const PATH_KEYS = new Set(['file_path', 'filePath', 'path'])
const PATCH_FILE_PATTERNS = [
  /^\*\*\* (?:Update|Add|Delete) File:\s*(.+)$/gm,
  /^\+\+\+\s+b\/(.+)$/gm,
]

function payload(input: PortableHookInput): unknown {
  return input.tool_input ?? input.toolInput ?? input.parameters
}

function walkPayload(
  input: PortableHookInput,
  onPath: (path: string) => void,
  onField: (key: string, value: string) => void
): void {
  const seen = new Set<object>()
  const visit = (value: unknown, depth: number): void => {
    if (!value || typeof value !== 'object' || depth > 3 || seen.has(value)) return
    seen.add(value)
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1)
      return
    }
    for (const [key, nested] of Object.entries(value)) {
      if (typeof nested === 'string') {
        if (PATH_KEYS.has(key) && nested.trim()) onPath(nested.trim())
        onField(key, nested)
      } else {
        visit(nested, depth + 1)
      }
    }
  }

  const raw = payload(input)
  if (typeof raw === 'string') onField('input', raw)
  else visit(raw, 0)
  const top = input as Record<string, unknown>
  for (const key of PATH_KEYS) {
    const value = top[key]
    if (typeof value === 'string' && value.trim()) onPath(value.trim())
  }
}

/** All explicit file targets, including every file in a freeform apply_patch payload. */
export function hookFilePaths(input: PortableHookInput): string[] {
  const files = new Set<string>()
  walkPayload(
    input,
    (file) => files.add(file),
    (_key, text) => {
      for (const pattern of PATCH_FILE_PATTERNS) {
        pattern.lastIndex = 0
        for (const match of text.matchAll(pattern)) {
          const file = match[1]?.trim()
          if (file && file !== '/dev/null') files.add(file)
        }
      }
    }
  )
  return [...files]
}

/** First string value carried under one of the provider-specific field names. */
export function hookStringField(input: PortableHookInput, keys: readonly string[]): string | null {
  const wanted = new Set(keys)
  const hits: string[] = []
  walkPayload(
    input,
    () => {},
    (key, value) => {
      if (hits.length === 0 && wanted.has(key) && value.trim()) hits.push(value)
    }
  )
  return hits[0] ?? null
}
