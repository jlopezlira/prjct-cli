/**
 * Verified project command facts — pins the contract:
 *   1. No package.json → empty facts, no guessing.
 *   2. Only known, actually-present scripts are returned (never guessed by lockfile).
 *   3. Package manager comes from real lockfile presence.
 *   4. Mutation classification is a pure, best-effort signal — read-only by default.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  classifyCommandMutation,
  detectVerifiedCommands,
} from '../../services/project-command-facts'

const fixture: { dir: string } = { dir: '' }

beforeEach(async () => {
  fixture.dir = await fs.mkdtemp(path.join(os.tmpdir(), 'prjct-command-facts-test-'))
})

afterEach(async () => {
  await fs.rm(fixture.dir, { recursive: true, force: true }).catch(() => {})
})

async function writePkg(scripts: Record<string, string>): Promise<void> {
  await fs.writeFile(
    path.join(fixture.dir, 'package.json'),
    JSON.stringify({ name: 'fixture', scripts }, null, 2)
  )
}

describe('detectVerifiedCommands', () => {
  it('returns empty facts when there is no package.json', async () => {
    const facts = await detectVerifiedCommands(fixture.dir)
    expect(facts).toEqual({ packageManager: null, commands: [] })
  })

  it('only includes known scripts that actually exist — never guessed', async () => {
    await writePkg({ test: 'vitest run', 'custom-thing': 'do something weird' })
    const facts = await detectVerifiedCommands(fixture.dir)
    expect(facts.commands).toHaveLength(1)
    expect(facts.commands[0]).toMatchObject({
      scriptName: 'test',
      command: 'vitest run',
      kind: 'test',
      mutating: false,
    })
  })

  it('classifies all known dimensions when present', async () => {
    await writePkg({
      typecheck: 'tsc --noEmit',
      lint: 'biome check',
      test: 'bun test',
      build: 'tsc -p .',
      dev: 'vite',
      format: 'biome format',
    })
    const facts = await detectVerifiedCommands(fixture.dir)
    expect(new Set(facts.commands.map((c) => c.kind))).toEqual(
      new Set(['build', 'dev', 'format', 'lint', 'test', 'typecheck'])
    )
  })

  it('flags a script as mutating when its real command carries a mutation signal', async () => {
    await writePkg({ lint: 'biome check --write' })
    const facts = await detectVerifiedCommands(fixture.dir)
    expect(facts.commands[0]?.mutating).toBe(true)
  })

  it('detects package manager from real lockfile presence, bun preferred first', async () => {
    await writePkg({ test: 'bun test' })
    await fs.writeFile(path.join(fixture.dir, 'bun.lock'), '')
    const facts = await detectVerifiedCommands(fixture.dir)
    expect(facts.packageManager).toBe('bun')
  })

  it('reports no package manager when no lockfile is present', async () => {
    await writePkg({ test: 'bun test' })
    const facts = await detectVerifiedCommands(fixture.dir)
    expect(facts.packageManager).toBeNull()
  })
})

describe('detectVerifiedCommands — non-Node ecosystems', () => {
  it('offers cargo toolchain commands from Cargo.toml presence alone', async () => {
    await fs.writeFile(path.join(fixture.dir, 'Cargo.toml'), '[package]\nname = "fixture"\n')
    const facts = await detectVerifiedCommands(fixture.dir)
    expect(facts.packageManager).toBeNull()
    expect(new Set(facts.commands.map((c) => c.kind))).toEqual(
      new Set(['typecheck', 'test', 'build', 'lint', 'format'])
    )
    expect(facts.commands.find((c) => c.kind === 'test')).toMatchObject({
      command: 'cargo test',
      mutating: false,
    })
    // cargo fmt rewrites in place by default — mutating even with no flags.
    expect(facts.commands.find((c) => c.kind === 'format')).toMatchObject({
      command: 'cargo fmt',
      mutating: true,
    })
  })

  it('offers go toolchain commands from go.mod presence alone, format stays read-only (gofmt -l)', async () => {
    await fs.writeFile(path.join(fixture.dir, 'go.mod'), 'module fixture\n\ngo 1.22\n')
    const facts = await detectVerifiedCommands(fixture.dir)
    expect(new Set(facts.commands.map((c) => c.kind))).toEqual(
      new Set(['test', 'build', 'lint', 'format'])
    )
    expect(facts.commands.find((c) => c.kind === 'format')).toMatchObject({
      command: 'gofmt -l .',
      mutating: false,
    })
  })

  it('only offers python commands whose tool section actually exists in pyproject.toml', async () => {
    await fs.writeFile(
      path.join(fixture.dir, 'pyproject.toml'),
      '[project]\nname = "fixture"\n\n[tool.pytest.ini_options]\n\n[tool.ruff]\n'
    )
    const facts = await detectVerifiedCommands(fixture.dir)
    expect(new Set(facts.commands.map((c) => c.kind))).toEqual(new Set(['test', 'lint']))
    expect(facts.commands.find((c) => c.kind === 'test')?.command).toBe('pytest')
    // black/mypy sections are absent — must not be guessed into existence.
    expect(facts.commands.some((c) => c.kind === 'format' || c.kind === 'typecheck')).toBe(false)
  })

  it('offers nothing for a bare pyproject.toml with no recognized tool sections', async () => {
    await fs.writeFile(path.join(fixture.dir, 'pyproject.toml'), '[project]\nname = "fixture"\n')
    const facts = await detectVerifiedCommands(fixture.dir)
    expect(facts.commands).toEqual([])
  })

  it('combines multiple ecosystems present in the same repo', async () => {
    await writePkg({ test: 'bun test' })
    await fs.writeFile(path.join(fixture.dir, 'Cargo.toml'), '[package]\nname = "fixture"\n')
    const facts = await detectVerifiedCommands(fixture.dir)
    const kinds = facts.commands.map((c) => `${c.scriptName}:${c.command}`)
    expect(kinds).toContain('test:bun test')
    expect(kinds).toContain('test:cargo test')
  })
})

describe('classifyCommandMutation', () => {
  it('treats a plain read command as read-only', () => {
    expect(classifyCommandMutation('biome check')).toBe(false)
    expect(classifyCommandMutation('tsc --noEmit')).toBe(false)
    expect(classifyCommandMutation('bun test')).toBe(false)
  })

  it('flags known mutation flags', () => {
    expect(classifyCommandMutation('biome check --write')).toBe(true)
    expect(classifyCommandMutation('eslint . --fix')).toBe(true)
    expect(classifyCommandMutation('prettier -w .')).toBe(true)
  })

  it('flags known mutating verbs', () => {
    expect(classifyCommandMutation('prisma migrate deploy')).toBe(true)
    expect(classifyCommandMutation('npm publish')).toBe(true)
  })

  it('unwraps env/sudo wrappers before classifying, like instruction-guidance', () => {
    expect(classifyCommandMutation('env NODE_ENV=test biome check --write')).toBe(true)
    expect(classifyCommandMutation('env NODE_ENV=test biome check')).toBe(false)
  })
})
