/**
 * Project / agent / stack auto-detection for the onboarding wizard.
 *
 * Pure functions parameterised by `projectPath`. Returned values feed
 * the wizard's "we detected X — confirm?" prompts.
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import { resolveUserPath } from '../../infrastructure/user-home'
import type {
  AIAgent,
  OnboardingDetectedStack as DetectedStack,
  ProjectType,
} from '../../types/workflows.js'
import { dirExists, fileExists } from '../../utils/file-helper'

export const PROJECT_TYPES: { value: ProjectType; title: string; description: string }[] = [
  { value: 'web-app', title: 'Web Application', description: 'React, Vue, Angular, Next.js, etc.' },
  {
    value: 'api-backend',
    title: 'API / Backend Service',
    description: 'Express, Hono, FastAPI, etc.',
  },
  {
    value: 'fullstack',
    title: 'Full-Stack (Monorepo)',
    description: 'Frontend + Backend in one repo',
  },
  { value: 'cli-tool', title: 'CLI Tool', description: 'Command-line application' },
  { value: 'library', title: 'Library / Package', description: 'Reusable npm/pip/cargo package' },
  {
    value: 'monorepo',
    title: 'Monorepo (Multiple Projects)',
    description: 'Turborepo, Nx, Lerna, etc.',
  },
]

export const AI_AGENTS: { value: AIAgent; title: string; description: string }[] = [
  { value: 'claude', title: 'Claude Code', description: "Anthropic's Claude in VS Code/CLI" },
  { value: 'cursor', title: 'Cursor', description: 'AI-first code editor' },
  { value: 'copilot', title: 'GitHub Copilot', description: "GitHub's AI pair programmer" },
  { value: 'gemini', title: 'Gemini CLI', description: "Google's Gemini in terminal" },
  { value: 'codex', title: 'OpenAI Codex', description: "OpenAI's coding agent in terminal" },
  { value: 'opencode', title: 'OpenCode', description: 'Open-source terminal coding agent' },
  { value: 'pi', title: 'Pi', description: 'Minimal terminal coding harness (skills + AGENTS.md)' },
  { value: 'qwen-code', title: 'Qwen Code', description: 'Qwen-family coding runtime' },
  { value: 'goose', title: 'Goose', description: 'Open-source coding agent with extensions' },
  { value: 'aider', title: 'Aider', description: 'Terminal pair-programming agent' },
  { value: 'cline', title: 'Cline', description: 'VS Code coding agent' },
  { value: 'roo-code', title: 'Roo Code', description: 'VS Code coding agent with MCP' },
  { value: 'continue', title: 'Continue', description: 'IDE assistant with MCP config' },
  { value: 'kiro', title: 'Kiro', description: 'Agentic IDE with steering docs' },
  { value: 'zed', title: 'Zed', description: 'Editor agent with ACP support' },
]

export async function detectProjectType(projectPath: string): Promise<ProjectType> {
  try {
    const files = await fs.readdir(projectPath)

    if (files.includes('turbo.json') || files.includes('lerna.json') || files.includes('nx.json')) {
      return 'monorepo'
    }

    if (files.includes('package.json')) {
      const pkgPath = path.join(projectPath, 'package.json')
      const pkg = JSON.parse(await fs.readFile(pkgPath, 'utf-8'))
      const deps = { ...pkg.dependencies, ...pkg.devDependencies }

      if (pkg.bin) return 'cli-tool'
      if (pkg.main && !deps.react && !deps.vue && !deps.angular && !deps.express && !deps.hono) {
        return 'library'
      }
      if ((deps.react || deps.vue) && (deps.express || deps.hono || deps.fastify)) {
        return 'fullstack'
      }
      if (deps.react || deps.vue || deps['@angular/core'] || deps.next || deps.nuxt) {
        return 'web-app'
      }
      if (deps.express || deps.hono || deps.fastify || deps.koa || deps.nestjs) {
        return 'api-backend'
      }
    }

    if (files.includes('pyproject.toml') || files.includes('setup.py')) {
      const hasServer = files.some((f) => ['main.py', 'app.py', 'server.py'].includes(f))
      return hasServer ? 'api-backend' : 'library'
    }

    if (files.includes('go.mod')) {
      return files.includes('main.go') ? 'cli-tool' : 'library'
    }

    if (files.includes('Cargo.toml')) return 'cli-tool'

    return 'unknown'
  } catch {
    return 'unknown'
  }
}

export async function detectInstalledAgents(projectPath: string): Promise<AIAgent[]> {
  const agents: AIAgent[] = []

  if (await dirExists(resolveUserPath('.claude'))) agents.push('claude')
  if (await fileExists(path.join(projectPath, '.cursorrules'))) agents.push('cursor')
  if (await fileExists(path.join(projectPath, '.github', 'copilot-instructions.md'))) {
    agents.push('copilot')
  }
  if (await dirExists(resolveUserPath('.gemini'))) agents.push('gemini')
  if (await dirExists(resolveUserPath('.gemini', 'antigravity'))) {
    agents.push('antigravity')
  }
  if (await dirExists(path.join(projectPath, '.opencode'))) agents.push('opencode')
  if (
    (await dirExists(path.join(projectPath, '.pi'))) ||
    (await dirExists(resolveUserPath('.pi')))
  ) {
    agents.push('pi')
  }
  if (await dirExists(path.join(projectPath, '.qwen'))) agents.push('qwen-code')
  if (await dirExists(path.join(projectPath, '.goose'))) agents.push('goose')
  if (
    (await fileExists(path.join(projectPath, '.aider.conf.yml'))) ||
    (await fileExists(path.join(projectPath, '.aider.conf.yaml')))
  ) {
    agents.push('aider')
  }
  if (
    (await dirExists(path.join(projectPath, '.cline'))) ||
    (await dirExists(path.join(projectPath, '.clinerules'))) ||
    (await fileExists(path.join(projectPath, '.clinerules')))
  ) {
    agents.push('cline')
  }
  if (await dirExists(path.join(projectPath, '.roo'))) agents.push('roo-code')
  if (await dirExists(path.join(projectPath, '.continue'))) agents.push('continue')
  if (await dirExists(path.join(projectPath, '.kiro'))) agents.push('kiro')
  if (await dirExists(path.join(projectPath, '.zed'))) agents.push('zed')

  // Codex: Check codex binary OR ~/.codex directory
  try {
    const { execAsync } = await import('../../utils/exec')
    await execAsync('which codex')
    agents.push('codex')
  } catch {
    if (await dirExists(resolveUserPath('.codex'))) agents.push('codex')
  }

  return agents
}

export async function detectStack(projectPath: string): Promise<DetectedStack> {
  const stack: DetectedStack = { language: 'Unknown', technologies: [] }

  try {
    const files = await fs.readdir(projectPath)

    if (files.includes('package.json')) {
      const pkgPath = path.join(projectPath, 'package.json')
      const pkg = JSON.parse(await fs.readFile(pkgPath, 'utf-8'))
      const deps = { ...pkg.dependencies, ...pkg.devDependencies }

      stack.language = deps.typescript ? 'TypeScript' : 'JavaScript'

      if (deps.next) stack.framework = 'Next.js'
      else if (deps.nuxt) stack.framework = 'Nuxt'
      else if (deps.react) stack.framework = 'React'
      else if (deps.vue) stack.framework = 'Vue'
      else if (deps['@angular/core']) stack.framework = 'Angular'
      else if (deps.express) stack.framework = 'Express'
      else if (deps.hono) stack.framework = 'Hono'
      else if (deps.fastify) stack.framework = 'Fastify'
      else if (deps.nestjs || deps['@nestjs/core']) stack.framework = 'NestJS'

      if (deps.bun || deps['@types/bun']) stack.runtime = 'Bun'
      else if (pkg.engines?.bun) stack.runtime = 'Bun'
      else stack.runtime = 'Node.js'

      if (files.includes('bun.lockb')) stack.packageManager = 'Bun'
      else if (files.includes('pnpm-lock.yaml')) stack.packageManager = 'pnpm'
      else if (files.includes('yarn.lock')) stack.packageManager = 'Yarn'
      else if (files.includes('package-lock.json')) stack.packageManager = 'npm'

      if (deps.prisma || deps['@prisma/client']) stack.technologies.push('Prisma')
      if (deps.drizzle || deps['drizzle-orm']) stack.technologies.push('Drizzle')
      if (deps.tailwindcss) stack.technologies.push('Tailwind CSS')
      if (deps.zod) stack.technologies.push('Zod')
      if (deps.trpc || deps['@trpc/server']) stack.technologies.push('tRPC')
    } else if (files.includes('pyproject.toml') || files.includes('requirements.txt')) {
      stack.language = 'Python'
    } else if (files.includes('go.mod')) {
      stack.language = 'Go'
    } else if (files.includes('Cargo.toml')) {
      stack.language = 'Rust'
    } else if (files.includes('pom.xml') || files.includes('build.gradle')) {
      stack.language = 'Java'
    }

    return stack
  } catch {
    return stack
  }
}
