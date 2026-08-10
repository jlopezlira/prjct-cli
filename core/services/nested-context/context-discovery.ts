/**
 * PRJCT.md discovery + parsing + chain merging.
 *
 * Pattern from OpenAI Codex AGENTS.md:
 * "Scope = directory tree. Deeper files take precedence."
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import type { MonorepoInfo, MonorepoPackage } from '../../types/infrastructure'
import type { ContextSection, NestedContext, ResolvedContext } from '../../types/services/extracted'
import * as fileHelper from '../../utils/file-helper'
import {
  buildInheritanceChain,
  computeDepth,
  findParentByDir,
  pickBestMatchForPath,
  scanForNestedFiles,
} from './_shared'

const FILENAME = 'PRJCT.md'

export class ContextDiscovery {
  constructor(
    private rootPath: string,
    private monoInfo: MonorepoInfo | null
  ) {}

  async discoverFiles(): Promise<NestedContext[]> {
    const contexts: NestedContext[] = []

    const rootFile = path.join(this.rootPath, FILENAME)
    if (await fileHelper.fileExists(rootFile)) {
      contexts.push(await this.loadFile(rootFile, null))
    }

    if (this.monoInfo?.isMonorepo) {
      for (const pkg of this.monoInfo.packages) {
        const pkgFile = path.join(pkg.path, FILENAME)
        if (await fileHelper.fileExists(pkgFile)) {
          const parent = contexts.find((c) => c.depth === 0) || null
          const ctx = await this.loadFile(pkgFile, parent, pkg)
          contexts.push(ctx)
          parent?.children.push(ctx)
        }
      }
    }

    const existingPaths = new Set(contexts.map((c) => c.path))
    await scanForNestedFiles(this.rootPath, FILENAME, existingPaths, async (filePath) => {
      const parent = findParentByDir(filePath, contexts)
      const ctx = await this.loadFile(filePath, parent)
      contexts.push(ctx)
      parent?.children.push(ctx)
    })

    return contexts
  }

  async resolveForPath(targetPath: string): Promise<ResolvedContext> {
    const contexts = await this.discoverFiles()
    const best = pickBestMatchForPath(targetPath, contexts)
    if (!best) return { content: '', sources: [], overrides: [] }
    return mergeChain(buildInheritanceChain(best))
  }

  private async loadFile(
    filePath: string,
    parent: NestedContext | null,
    pkg: MonorepoPackage | null = null
  ): Promise<NestedContext> {
    const content = await fs.readFile(filePath, 'utf-8')
    return {
      path: filePath,
      relativePath: path.relative(this.rootPath, filePath),
      depth: computeDepth(this.rootPath, filePath),
      parent,
      children: [],
      content,
      sections: parseSections(content),
      package: pkg,
    }
  }
}

function parseSections(content: string): ContextSection[] {
  type ParseState = { sections: ContextSection[]; current: ContextSection | null; lines: string[] }
  const parsed = content.split('\n').reduce<ParseState>(
    (state, line) => {
      const headerMatch = line.match(/^##\s+(.+)$/)
      if (headerMatch) {
        const sections = state.current
          ? [...state.sections, { ...state.current, content: state.lines.join('\n').trim() }]
          : state.sections
        const name = headerMatch[1]
        return {
          sections,
          current: {
            name: name.replace(/@override|\(override\)/gi, '').trim(),
            content: '',
            override: name.includes('@override') || name.includes('(override)'),
          },
          lines: [],
        }
      }
      if (state.current) state.lines.push(line)
      return state
    },
    { sections: [], current: null, lines: [] }
  )
  return parsed.current
    ? [...parsed.sections, { ...parsed.current, content: parsed.lines.join('\n').trim() }]
    : parsed.sections
}

function mergeChain(chain: NestedContext[]): ResolvedContext {
  const merged = new Map<string, string>()
  const sources: string[] = []
  const overrides: string[] = []

  for (const ctx of chain) {
    sources.push(ctx.relativePath)
    for (const section of ctx.sections) {
      if (section.override || !merged.has(section.name)) {
        merged.set(section.name, section.content)
        if (section.override) overrides.push(`${ctx.relativePath}:${section.name}`)
      } else {
        const existing = merged.get(section.name) || ''
        merged.set(section.name, `${existing}\n\n${section.content}`)
      }
    }
  }

  const parts: string[] = []
  for (const [name, content] of merged) {
    parts.push(`## ${name}\n\n${content}`)
  }

  return { content: parts.join('\n\n---\n\n'), sources, overrides }
}
