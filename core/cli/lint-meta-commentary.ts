/**
 * Lint rule: no-meta-commentary
 *
 * Catches AI memory meta-commentary patterns that should be avoided.
 * Preferences should be presented as facts, not as memories.
 *
 * Anti-patterns:
 * - "I remember you prefer..."
 * - "Based on your history..."
 * - "I've learned that..."
 * - "From previous sessions..."
 *
 * Correct pattern:
 * - "Use TypeScript strict mode" (not "I remember you like strict mode")
 *
 * @see PRJ-103
 */

import { readdir, readFile } from 'node:fs/promises'
import { join, relative } from 'node:path'

const META_COMMENTARY_PATTERNS = [
  // Direct memory references
  /\bI remember\b/gi,
  /\bI recall\b/gi,
  /\bI('ve| have) learned\b/gi,

  // History references
  /\bBased on (your |)history\b/gi,
  /\bFrom previous (session|conversation)s?\b/gi,
  /\bIn (the |)past,? you\b/gi,

  // Preference meta-commentary
  /\byou (usually|typically|always|often) prefer\b/gi,
  /\byou mentioned (before|earlier|previously)\b/gi,
  /\blast time you\b/gi,

  // Section headers that expose memory mechanism
  /\bLEARNED PATTERNS\b/g,
  /\bRELEVANT MEMORIES\b/g,
  /\bLearned Patterns\b/g,
  /\bRelevant Memories\b/g,
]

// Files/directories to skip
const SKIP_PATTERNS = [
  /node_modules/,
  /\.git/,
  /dist/,
  /build/,
  /coverage/,
  /\.test\.ts$/,
  /\.spec\.ts$/,
  /lint-meta-commentary\.ts$/, // Skip self
  /\/docs\//, // Skip documentation (describes features, not agent output)
]

// Only check these extensions
const INCLUDE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.md']

interface Violation {
  file: string
  line: number
  column: number
  match: string
  pattern: string
}

async function* walkDir(dir: string): AsyncGenerator<string> {
  const entries = await readdir(dir, { withFileTypes: true })

  for (const entry of entries) {
    const fullPath = join(dir, entry.name)

    if (SKIP_PATTERNS.some((p) => p.test(fullPath))) {
      continue
    }

    if (entry.isDirectory()) {
      yield* walkDir(fullPath)
    } else if (entry.isFile() && INCLUDE_EXTENSIONS.some((ext) => entry.name.endsWith(ext))) {
      yield fullPath
    }
  }
}

async function checkFile(filePath: string): Promise<Violation[]> {
  const violations: Violation[] = []
  const content = await readFile(filePath, 'utf-8')
  const lines = content.split('\n')

  for (const lineNum of lines.keys()) {
    const line = lines[lineNum]

    // Skip comments - we only care about string literals that become agent output
    const trimmed = line.trim()
    if (
      trimmed.startsWith('//') || // Inline comments
      trimmed.startsWith('*') || // JSDoc/block comments
      trimmed.startsWith('/*') || // Block comment start
      line.includes('Anti-pattern') || // Documentation
      line.includes('@see') || // JSDoc refs
      line.includes('@example') // JSDoc examples
    ) {
      continue
    }

    for (const pattern of META_COMMENTARY_PATTERNS) {
      // Reset lastIndex for global patterns
      pattern.lastIndex = 0

      for (const match of line.matchAll(pattern)) {
        violations.push({
          file: filePath,
          line: lineNum + 1,
          column: match.index + 1,
          match: match[0],
          pattern: pattern.source,
        })
      }
    }
  }

  return violations
}

async function main() {
  const rootDir = process.cwd()
  const allViolations: Violation[] = []

  console.log('Checking for meta-commentary patterns...\n')

  for await (const filePath of walkDir(rootDir)) {
    const violations = await checkFile(filePath)
    if (violations.length > 0) {
      allViolations.push(...violations)
    }
  }

  if (allViolations.length === 0) {
    console.log('✅ No meta-commentary patterns found\n')
    process.exit(0)
  }

  console.log(`❌ Found ${allViolations.length} meta-commentary violation(s):\n`)

  // Group by file
  const byFile = new Map<string, Violation[]>()
  for (const v of allViolations) {
    const rel = relative(rootDir, v.file)
    if (!byFile.has(rel)) {
      byFile.set(rel, [])
    }
    byFile.get(rel)!.push(v)
  }

  for (const [file, violations] of byFile) {
    console.log(`  ${file}`)
    for (const v2 of violations) {
      console.log(`    ${v2.line}:${v2.column}  "${v2.match}"`)
    }
    console.log('')
  }

  console.log('Fix: Present preferences as facts, not memories.')
  console.log('  ❌ "I remember you prefer TypeScript"')
  console.log('  ✅ "Use TypeScript"\n')

  process.exit(1)
}

main().catch((err) => {
  console.error('Error:', err.message)
  process.exit(1)
})
