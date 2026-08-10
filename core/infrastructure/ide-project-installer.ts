/**
 * Intelligent merge using HTML comment markers.
 *
 * Handles three cases:
 * 1. No existing content -> create with template
 * 2. Existing content without markers -> append template
 * 3. Existing content with markers -> replace section between markers
 *
 * Used by setup.ts (Gemini config) and command-installer.ts (Claude config).
 */
export function mergeWithMarkers(
  existing: string,
  template: string,
  startMarker: string,
  endMarker: string
): { content: string; action: 'created' | 'appended' | 'updated' } {
  if (!existing) {
    return { content: template, action: 'created' }
  }

  const hasMarkers = existing.includes(startMarker) && existing.includes(endMarker)

  if (!hasMarkers) {
    return {
      content: `${existing}\n\n${template}`,
      action: 'appended',
    }
  }

  // Markers exist - replace content between markers
  const beforeMarker = existing.substring(0, existing.indexOf(startMarker))
  const afterMarker = existing.substring(existing.indexOf(endMarker) + endMarker.length)

  // Extract prjct section from template (in case template has extra content around markers)
  const prjctSection =
    template.includes(startMarker) && template.includes(endMarker)
      ? template.substring(
          template.indexOf(startMarker),
          template.indexOf(endMarker) + endMarker.length
        )
      : template

  return {
    content: beforeMarker + prjctSection + afterMarker,
    action: 'updated',
  }
}
