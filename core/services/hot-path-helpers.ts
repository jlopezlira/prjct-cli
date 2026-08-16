/**
 * Shared hot-path helpers for Stop-hook detectors (`friction-detector.ts`,
 * `skill-miss-detector.ts`). Both run on every session Stop, so these stay
 * dependency-light: no async, no imports beyond node builtins.
 */

/** Flatten an Anthropic-style transcript content value into plain text. */
export function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    // Anthropic content blocks: [{ type: 'text', text: '...' }, ...]
    return content
      .map((block) => {
        if (typeof block === 'string') return block
        if (block && typeof block === 'object' && 'text' in block) {
          const t = (block as { text?: unknown }).text
          return typeof t === 'string' ? t : ''
        }
        return ''
      })
      .join('\n')
      .trim()
  }
  return ''
}

/** Lightweight sync read of `.prjct/prjct.config.json`, avoiding the full config-manager round trip on hot paths. */
export function projectIdFromPath(projectPath: string): string | null {
  try {
    const fs2 = require('node:fs') as typeof import('node:fs')
    const path2 = require('node:path') as typeof import('node:path')
    const file = path2.join(projectPath, '.prjct', 'prjct.config.json')
    const raw = fs2.readFileSync(file, 'utf-8')
    const parsed = JSON.parse(raw) as { projectId?: string }
    return parsed.projectId ?? null
  } catch {
    return null
  }
}
