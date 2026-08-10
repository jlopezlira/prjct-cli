/**
 * Template Loader
 * Loads and parses command templates with frontmatter.
 *
 * Supports two modes:
 * - Production: reads from dist/templates.json (single bundled file)
 * - Development: reads from templates/commands/ (individual files)
 *
 */

import fsSync from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { TemplateError } from '../errors'
import { buildEditorSurface } from '../services/skill-generator/editor-surfaces'
import type { Frontmatter } from '../types/agentic'
import type { ParsedTemplate } from '../types/agentic/templates-orchestration'
import { PACKAGE_ROOT } from '../utils/version'

// ============ Module State (LRU Cache) ============

const MAX_CACHE_SIZE = 50

const cache = new Map<string, ParsedTemplate>()
const cacheOrder: string[] = []

// Lazily loaded template bundle (production mode)
const bundleState: { templates: Record<string, string> | null; loaded: boolean } = {
  templates: null,
  loaded: false,
}

// ============ Bundle Loading ============

function loadBundle(): Record<string, string> | null {
  if (bundleState.loaded) return bundleState.templates

  bundleState.loaded = true
  const bundlePath = path.join(PACKAGE_ROOT, 'dist', 'templates.json')

  try {
    const content = fsSync.readFileSync(bundlePath, 'utf-8')
    bundleState.templates = JSON.parse(content)
    return bundleState.templates
  } catch {
    // Bundle not available (dev mode) — fall back to filesystem
    return null
  }
}

// ============ Cache Helpers ============

function updateLruOrder(key: string): void {
  const index = cacheOrder.indexOf(key)
  if (index > -1) cacheOrder.splice(index, 1)
  cacheOrder.push(key)
}

function evictLru(): void {
  while (cache.size >= MAX_CACHE_SIZE && cacheOrder.length > 0) {
    const oldest = cacheOrder.shift()
    if (oldest) cache.delete(oldest)
  }
}

// ============ Parsing Functions ============

function parseFrontmatter(content: string): ParsedTemplate {
  const frontmatterRegex = /^---\n([\s\S]+?)\n---\n([\s\S]*)$/
  const match = content.match(frontmatterRegex)

  if (!match) {
    return { frontmatter: {}, content: content.trim() }
  }

  const [, frontmatterText, mainContent] = match
  const frontmatter: Frontmatter = {}

  frontmatterText.split('\n').forEach((line) => {
    const [key, ...valueParts] = line.split(':')
    if (key && valueParts.length > 0) {
      const value = valueParts.join(':').trim()

      // Parse arrays
      if (value.startsWith('[') && value.endsWith(']')) {
        frontmatter[key.trim()] = value
          .slice(1, -1)
          .split(',')
          .map((v) => v.trim())
      } else {
        // Remove quotes if present
        frontmatter[key.trim()] = value.replace(/^["']|["']$/g, '')
      }
    }
  })

  return { frontmatter, content: mainContent.trim() }
}

// ============ Main Functions ============

async function load(commandName: string): Promise<ParsedTemplate> {
  // Check cache first
  if (cache.has(commandName)) {
    updateLruOrder(commandName)
    return cache.get(commandName)!
  }

  // Try bundled templates first (production)
  const bundle = loadBundle()
  const bundledContent = bundle?.[`commands/${commandName}.md`]
  const rawContent =
    bundledContent ??
    (await fs
      .readFile(path.join(PACKAGE_ROOT, 'templates', 'commands', `${commandName}.md`), 'utf-8')
      .catch(() => {
        throw TemplateError.notFound(commandName)
      }))

  const parsed = parseFrontmatter(rawContent)

  // Evict LRU if needed before adding
  evictLru()

  // Cache result
  cache.set(commandName, parsed)
  cacheOrder.push(commandName)

  return parsed
}

async function getAllowedTools(commandName: string): Promise<string[]> {
  const template = await load(commandName)
  return template.frontmatter['allowed-tools'] || []
}

function clearCache(): void {
  cache.clear()
  cacheOrder.length = 0
}

/**
 * Reset the template bundle so the next loadBundle() re-reads from disk.
 * Called after `prjct update` installs a new version to pick up new templates.
 */
export function resetBundle(): void {
  bundleState.templates = null
  bundleState.loaded = false
  clearCache()
}

/**
 * Get raw template content by relative path (e.g., "global/CLAUDE.md")
 * Used by command-installer and other modules that need non-command templates.
 */
export function getTemplateContent(relativePath: string): string | null {
  const bundle = loadBundle()
  if (bundle?.[relativePath]) {
    return bundle[relativePath]
  }

  const generated = buildEditorSurface(relativePath)
  if (generated) return generated

  // Fall back to filesystem
  const filePath = path.join(PACKAGE_ROOT, 'templates', relativePath)
  try {
    return fsSync.readFileSync(filePath, 'utf-8')
  } catch {
    return null
  }
}

/**
 * List all template files matching a prefix (e.g., "commands/")
 * Returns relative paths like ["commands/p.md", "commands/task.md", ...]
 */
export function listTemplates(prefix: string): string[] {
  const bundle = loadBundle()
  if (bundle) {
    return Object.keys(bundle).filter((key) => key.startsWith(prefix))
  }

  // Fall back to filesystem
  const dir = path.join(PACKAGE_ROOT, 'templates', prefix)
  try {
    const files = fsSync.readdirSync(dir)
    return files.map((f) => `${prefix}${f}`)
  } catch {
    return []
  }
}

const templateLoader = {
  load,
  parseFrontmatter,
  getAllowedTools,
  clearCache,
  getTemplateContent,
  listTemplates,
}
export default templateLoader
