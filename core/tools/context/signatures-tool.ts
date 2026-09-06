/**
 * Signatures Tool - Extract code signatures without full content
 *
 * Extracts:
 * - Function names + params + return types
 * - Interface/type definitions
 * - Class names + methods
 * - Export lists
 *
 * Achieves ~90% token reduction by returning structure only.
 *
 * Uses regex patterns for broad language support.
 * Falls back to full file if language not supported.
 *
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import type { CodeSignature, SignaturesToolOutput, SignatureType } from '../../types/context-tools'
import { isNotFoundError } from '../../types/fs'
import { resolveInsideProject } from '../../utils/path-jail'
import { measureCompression, noCompression } from './token-counter'

// Language Support

type LanguageId =
  | 'typescript'
  | 'javascript'
  | 'python'
  | 'go'
  | 'rust'
  | 'java'
  | 'csharp'
  | 'php'
  | 'ruby'
  | 'unknown'

/**
 * Map file extensions to language identifiers
 */
const EXTENSION_TO_LANGUAGE: Record<string, LanguageId> = {
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.py': 'python',
  '.go': 'go',
  '.rs': 'rust',
  '.java': 'java',
  '.cs': 'csharp',
  '.php': 'php',
  '.rb': 'ruby',
}

// Extraction Patterns

interface ExtractionPattern {
  type: SignatureType
  pattern: RegExp
  nameIndex: number
  signatureIndex?: number
  exported?: boolean
}

/**
 * TypeScript/JavaScript extraction patterns
 */
const TS_PATTERNS: ExtractionPattern[] = [
  // Exported function declarations
  {
    type: 'function',
    pattern:
      /^export\s+(?:async\s+)?function\s+(\w+)\s*(<[^>]*>)?\s*\(([^)]*)\)\s*(?::\s*([^{;]+))?/gm,
    nameIndex: 1,
    exported: true,
  },
  // Exported const arrow functions
  {
    type: 'function',
    pattern:
      /^export\s+const\s+(\w+)\s*(?::\s*[^=]+)?\s*=\s*(?:async\s+)?\([^)]*\)\s*(?::\s*[^=]+)?\s*=>/gm,
    nameIndex: 1,
    exported: true,
  },
  // Regular function declarations
  {
    type: 'function',
    pattern: /^(?:async\s+)?function\s+(\w+)\s*(<[^>]*>)?\s*\(([^)]*)\)\s*(?::\s*([^{;]+))?/gm,
    nameIndex: 1,
  },
  // Const arrow functions
  {
    type: 'function',
    pattern: /^const\s+(\w+)\s*(?::\s*[^=]+)?\s*=\s*(?:async\s+)?\([^)]*\)\s*(?::\s*[^=]+)?\s*=>/gm,
    nameIndex: 1,
  },
  // Interface declarations
  {
    type: 'interface',
    pattern: /^export\s+interface\s+(\w+)(?:<[^>]+>)?\s*(?:extends\s+[^{]+)?\s*\{/gm,
    nameIndex: 1,
    exported: true,
  },
  {
    type: 'interface',
    pattern: /^interface\s+(\w+)(?:<[^>]+>)?\s*(?:extends\s+[^{]+)?\s*\{/gm,
    nameIndex: 1,
  },
  // Type aliases
  {
    type: 'type',
    pattern: /^export\s+type\s+(\w+)(?:<[^>]+>)?\s*=/gm,
    nameIndex: 1,
    exported: true,
  },
  {
    type: 'type',
    pattern: /^type\s+(\w+)(?:<[^>]+>)?\s*=/gm,
    nameIndex: 1,
  },
  // Class declarations
  {
    type: 'class',
    pattern:
      /^export\s+(?:abstract\s+)?class\s+(\w+)(?:<[^>]+>)?(?:\s+extends\s+[^{]+)?(?:\s+implements\s+[^{]+)?\s*\{/gm,
    nameIndex: 1,
    exported: true,
  },
  {
    type: 'class',
    pattern:
      /^(?:abstract\s+)?class\s+(\w+)(?:<[^>]+>)?(?:\s+extends\s+[^{]+)?(?:\s+implements\s+[^{]+)?\s*\{/gm,
    nameIndex: 1,
  },
  // Enum declarations
  {
    type: 'enum',
    pattern: /^export\s+enum\s+(\w+)\s*\{/gm,
    nameIndex: 1,
    exported: true,
  },
  {
    type: 'enum',
    pattern: /^enum\s+(\w+)\s*\{/gm,
    nameIndex: 1,
  },
  // Exported constants
  {
    type: 'const',
    pattern: /^export\s+const\s+(\w+)\s*(?::\s*([^=]+))?\s*=/gm,
    nameIndex: 1,
    exported: true,
  },
]

/**
 * Python extraction patterns
 */
const PYTHON_PATTERNS: ExtractionPattern[] = [
  // Function definitions
  {
    type: 'function',
    pattern: /^def\s+(\w+)\s*\(([^)]*)\)\s*(?:->\s*([^:]+))?\s*:/gm,
    nameIndex: 1,
  },
  // Async function definitions
  {
    type: 'function',
    pattern: /^async\s+def\s+(\w+)\s*\(([^)]*)\)\s*(?:->\s*([^:]+))?\s*:/gm,
    nameIndex: 1,
  },
  // Class definitions
  {
    type: 'class',
    pattern: /^class\s+(\w+)(?:\(([^)]*)\))?\s*:/gm,
    nameIndex: 1,
  },
]

/**
 * Go extraction patterns
 */
const GO_PATTERNS: ExtractionPattern[] = [
  // Function declarations
  {
    type: 'function',
    pattern: /^func\s+(\w+)\s*\(([^)]*)\)\s*(?:\(([^)]*)\)|([^\s{]+))?\s*\{/gm,
    nameIndex: 1,
  },
  // Method declarations
  {
    type: 'method',
    pattern: /^func\s+\([^)]+\)\s+(\w+)\s*\(([^)]*)\)\s*(?:\(([^)]*)\)|([^\s{]+))?\s*\{/gm,
    nameIndex: 1,
  },
  // Type definitions
  {
    type: 'type',
    pattern: /^type\s+(\w+)\s+(?:struct|interface)\s*\{/gm,
    nameIndex: 1,
  },
]

/**
 * Rust extraction patterns
 */
const RUST_PATTERNS: ExtractionPattern[] = [
  // Public function declarations
  {
    type: 'function',
    pattern: /^pub\s+(?:async\s+)?fn\s+(\w+)(?:<[^>]+>)?\s*\(([^)]*)\)\s*(?:->\s*([^{]+))?\s*\{/gm,
    nameIndex: 1,
    exported: true,
  },
  // Private function declarations
  {
    type: 'function',
    pattern: /^(?:async\s+)?fn\s+(\w+)(?:<[^>]+>)?\s*\(([^)]*)\)\s*(?:->\s*([^{]+))?\s*\{/gm,
    nameIndex: 1,
  },
  // Struct definitions
  {
    type: 'class',
    pattern: /^pub\s+struct\s+(\w+)(?:<[^>]+>)?\s*(?:\{|;)/gm,
    nameIndex: 1,
    exported: true,
  },
  {
    type: 'class',
    pattern: /^struct\s+(\w+)(?:<[^>]+>)?\s*(?:\{|;)/gm,
    nameIndex: 1,
  },
  // Trait definitions
  {
    type: 'interface',
    pattern: /^pub\s+trait\s+(\w+)(?:<[^>]+>)?\s*(?:\{|:)/gm,
    nameIndex: 1,
    exported: true,
  },
  {
    type: 'interface',
    pattern: /^trait\s+(\w+)(?:<[^>]+>)?\s*(?:\{|:)/gm,
    nameIndex: 1,
  },
  // Enum definitions
  {
    type: 'enum',
    pattern: /^pub\s+enum\s+(\w+)(?:<[^>]+>)?\s*\{/gm,
    nameIndex: 1,
    exported: true,
  },
  {
    type: 'enum',
    pattern: /^enum\s+(\w+)(?:<[^>]+>)?\s*\{/gm,
    nameIndex: 1,
  },
]

/**
 * Java extraction patterns
 */
const JAVA_PATTERNS: ExtractionPattern[] = [
  // Class declarations
  {
    type: 'class',
    pattern:
      /^(?:public\s+)?(?:abstract\s+)?(?:final\s+)?class\s+(\w+)(?:<[^>]+>)?(?:\s+extends\s+\w+)?(?:\s+implements\s+[^{]+)?\s*\{/gm,
    nameIndex: 1,
    exported: true,
  },
  // Interface declarations
  {
    type: 'interface',
    pattern: /^(?:public\s+)?interface\s+(\w+)(?:<[^>]+>)?(?:\s+extends\s+[^{]+)?\s*\{/gm,
    nameIndex: 1,
    exported: true,
  },
  // Method declarations
  {
    type: 'method',
    pattern:
      /^\s+(?:public|private|protected)?\s*(?:static\s+)?(?:final\s+)?(?:synchronized\s+)?(?:<[^>]+>\s+)?(\w+(?:<[^>]+>)?)\s+(\w+)\s*\([^)]*\)\s*(?:throws\s+[^{]+)?\s*\{/gm,
    nameIndex: 2,
  },
]

/**
 * Language to patterns mapping
 */
const LANGUAGE_PATTERNS: Record<LanguageId, ExtractionPattern[]> = {
  typescript: TS_PATTERNS,
  javascript: TS_PATTERNS,
  python: PYTHON_PATTERNS,
  go: GO_PATTERNS,
  rust: RUST_PATTERNS,
  java: JAVA_PATTERNS,
  csharp: JAVA_PATTERNS, // Similar enough for basic extraction
  php: [], // Fallback to full file
  ruby: [], // Fallback to full file
  unknown: [],
}

// Main Function

/**
 * Extract code signatures from a file
 *
 * @param filePath - Path to the file (absolute or relative to cwd)
 * @param projectPath - Project root path (for resolving relative paths)
 * @returns Extracted signatures with compression metrics
 */
export async function extractSignatures(
  filePath: string,
  projectPath: string = process.cwd()
): Promise<SignaturesToolOutput> {
  // Jail on the canonical path: an in-tree symlink to /etc or ~/.ssh reads
  // as inside the project lexically but its bytes live outside it.
  const absolutePath = resolveInsideProject(projectPath, filePath)
  if (absolutePath === null) {
    return {
      file: filePath,
      language: 'unknown',
      signatures: [],
      fallback: true,
      fallbackReason: 'Path traversal denied: file is outside project directory',
      metrics: noCompression(''),
    }
  }

  // Read file content
  const content = await fs.readFile(absolutePath, 'utf-8').catch((error) => {
    if (isNotFoundError(error)) {
      return null
    }
    throw error
  })
  if (content === null) {
    return {
      file: filePath,
      language: 'unknown',
      signatures: [],
      fallback: true,
      fallbackReason: 'File not found',
      metrics: noCompression(''),
    }
  }

  // Detect language
  const ext = path.extname(filePath).toLowerCase()
  const language = EXTENSION_TO_LANGUAGE[ext] || 'unknown'
  const patterns = LANGUAGE_PATTERNS[language]

  // No patterns = fallback to full file
  if (!patterns || patterns.length === 0) {
    return {
      file: filePath,
      language,
      signatures: [],
      fallback: true,
      fallbackReason: `No extraction patterns for ${language}`,
      metrics: noCompression(content),
    }
  }

  // Extract signatures
  const signatures = extractFromContent(content, patterns)

  // Build filtered output (just signatures)
  const filteredContent = signatures
    .map((sig) => {
      const exportPrefix = sig.exported ? 'export ' : ''
      return `${exportPrefix}${sig.type} ${sig.name}: ${sig.signature}`
    })
    .join('\n')

  return {
    file: filePath,
    language,
    signatures,
    fallback: false,
    metrics: measureCompression(content, filteredContent),
  }
}

// Helper Functions

/**
 * Extract signatures from content using patterns
 */
function extractFromContent(content: string, patterns: ExtractionPattern[]): CodeSignature[] {
  const signatures: CodeSignature[] = []
  const lines = content.split('\n')

  // Track what we've extracted to avoid duplicates
  const seen = new Set<string>()

  for (const patternDef of patterns) {
    // Reset lastIndex for global regex
    patternDef.pattern.lastIndex = 0

    for (const match of content.matchAll(patternDef.pattern)) {
      const name = match[patternDef.nameIndex]
      if (!name) continue

      // Create a key for deduplication
      const key = `${patternDef.type}:${name}`
      if (seen.has(key)) continue
      seen.add(key)

      // Get line number
      const matchIndex = match.index
      const lineNumber = content.substring(0, matchIndex).split('\n').length

      // Extract the full signature line
      const signatureLine = match[0].trim()

      // Try to extract docstring (line before the signature)
      const previousLine = lineNumber > 1 ? lines[lineNumber - 2]?.trim() : undefined
      const docstring =
        previousLine?.startsWith('/**') ||
        previousLine?.startsWith('///') ||
        previousLine?.startsWith('#')
          ? previousLine
          : undefined

      signatures.push({
        type: patternDef.type,
        name,
        signature: cleanSignature(signatureLine),
        exported: patternDef.exported || false,
        line: lineNumber,
        docstring,
      })
    }
  }

  // Sort by line number
  return signatures.sort((a, b) => a.line - b.line)
}

/**
 * Clean up a signature line for display
 */
function cleanSignature(signature: string): string {
  return signature
    .replace(/\{$/, '') // Remove trailing {
    .replace(/\s+/g, ' ') // Normalize whitespace
    .trim()
}
