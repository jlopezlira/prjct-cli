import { createHash } from 'node:crypto'
import path from 'node:path'

export type CommentDisciplineReason = 'long-comment-block' | 'comment-density'

export interface CommentDisciplineSignal {
  reason: CommentDisciplineReason
  fingerprint: string
  lineBucket: string
  expectedBehavior: string
  observedBehavior: string
}

const CODE_EXTENSIONS = new Set([
  '.bash',
  '.c',
  '.cc',
  '.cpp',
  '.cs',
  '.go',
  '.h',
  '.hpp',
  '.java',
  '.js',
  '.jsx',
  '.kt',
  '.kts',
  '.mjs',
  '.php',
  '.py',
  '.rb',
  '.rs',
  '.sh',
  '.swift',
  '.ts',
  '.tsx',
  '.zsh',
])

const GENERATED_PATH =
  /(?:^|\/)(?:dist|build|coverage|generated|vendor|node_modules)(?:\/|$)|(?:\.min|\.generated|\.gen)\.[^.]+$/i
const DIRECTIVE_COMMENT =
  /(?:spdx-license-identifier|copyright|@license|eslint|biome-ignore|prettier-ignore|istanbul ignore|ts-ignore|ts-expect-error|noqa|type:\s*ignore|shellcheck|swiftlint|nolint|cspell)/i
const PUBLIC_DOC_TAG = /@(param|returns?|throws?|example|deprecated|public|property|template)\b/i

interface CommentGroup {
  lines: number
  words: number
  publicDoc: boolean
  directive: boolean
}

function wordCount(text: string): number {
  return text.match(/[\p{L}\p{N}]+/gu)?.length ?? 0
}

function lineBucket(lines: number): string {
  if (lines < 10) return '6-9'
  if (lines < 20) return '10-19'
  return '20-plus'
}

function fingerprintFor(
  reason: CommentDisciplineReason,
  extension: string,
  bucket: string
): string {
  return createHash('sha256').update(`${reason}:${extension}:${bucket}`).digest('hex')
}

function commentGroups(
  text: string,
  extension: string
): { groups: CommentGroup[]; nonBlank: number } {
  const groups: CommentGroup[] = []
  const lines = text.split(/\r?\n/)
  let nonBlank = 0
  let block: CommentGroup | null = null
  let lineGroup: CommentGroup | null = null

  const pushLineGroup = (): void => {
    if (lineGroup) groups.push(lineGroup)
    lineGroup = null
  }

  const add = (group: CommentGroup, raw: string): void => {
    const cleaned = raw
      .replace(/^\s*(?:\/\/\/?|#|--|\/\*+|\*+\/?)\s?/, '')
      .replace(/\*\/\s*$/, '')
      .trim()
    group.lines += 1
    group.words += wordCount(cleaned)
    group.directive ||= DIRECTIVE_COMMENT.test(cleaned)
    group.publicDoc ||= PUBLIC_DOC_TAG.test(cleaned)
  }

  for (const raw of lines) {
    if (raw.trim()) nonBlank += 1

    if (block) {
      add(block, raw)
      if (raw.includes('*/')) {
        groups.push(block)
        block = null
      }
      continue
    }

    const blockStart = raw.indexOf('/*')
    if (blockStart >= 0) {
      pushLineGroup()
      block = { lines: 0, words: 0, publicDoc: false, directive: false }
      add(block, raw.slice(blockStart))
      if (raw.slice(blockStart + 2).includes('*/')) {
        groups.push(block)
        block = null
      }
      continue
    }

    const trimmed = raw.trimStart()
    const hashComment = ['.bash', '.py', '.rb', '.sh', '.zsh'].includes(extension)
    const isLineComment =
      trimmed.startsWith('//') ||
      (hashComment && trimmed.startsWith('#') && !trimmed.startsWith('#!'))
    if (isLineComment) {
      lineGroup ??= { lines: 0, words: 0, publicDoc: false, directive: false }
      add(lineGroup, raw)
    } else {
      pushLineGroup()
    }
  }

  pushLineGroup()
  if (block) groups.push(block)
  return { groups, nonBlank }
}

/**
 * Conservative analysis of newly-written code only. It returns coarse,
 * content-free metadata so neither source text nor paths enter memory.
 */
export function analyzeCommentDiscipline(input: {
  filePath: string
  changedText: string
}): CommentDisciplineSignal | null {
  const normalizedPath = input.filePath.replaceAll('\\', '/')
  const extension = path.extname(normalizedPath).toLowerCase()
  if (!CODE_EXTENSIONS.has(extension) || GENERATED_PATH.test(normalizedPath)) return null
  if (!input.changedText.trim()) return null

  const { groups, nonBlank } = commentGroups(input.changedText, extension)
  const candidates = groups.filter((group) => !group.directive && !group.publicDoc)
  const longest = candidates
    .filter((group) => group.lines >= 6 && group.words >= 50)
    .sort((a, b) => b.lines - a.lines || b.words - a.words)[0]

  if (longest) {
    const bucket = lineBucket(longest.lines)
    return {
      reason: 'long-comment-block',
      fingerprint: fingerprintFor('long-comment-block', extension, bucket),
      lineBucket: bucket,
      expectedBehavior:
        'Comments capture intent, invariants, or non-obvious tradeoffs in the shortest form that preserves them.',
      observedBehavior: `New code contains a ${bucket}-line explanatory comment block.`,
    }
  }

  const commentLines = candidates.reduce((sum, group) => sum + group.lines, 0)
  const commentWords = candidates.reduce((sum, group) => sum + group.words, 0)
  if (commentLines >= 10 && commentWords >= 100 && nonBlank > 0 && commentLines / nonBlank >= 0.4) {
    const bucket = lineBucket(commentLines)
    return {
      reason: 'comment-density',
      fingerprint: fingerprintFor('comment-density', extension, bucket),
      lineBucket: bucket,
      expectedBehavior:
        'Comments capture intent, invariants, or non-obvious tradeoffs in the shortest form that preserves them.',
      observedBehavior: `New code has a high explanatory-comment density (${bucket} comment-line bucket).`,
    }
  }

  return null
}
