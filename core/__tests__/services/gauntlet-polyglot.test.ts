import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { detectVerifiedCommands } from '../../services/project-command-facts'

/**
 * Language-agnosticism is a CLAIM until a matrix proves it. Each case writes
 * the manifest a real project of that ecosystem carries, then asserts the
 * gauntlet's verify kinds are discovered from it. A regression here means the
 * machine gate silently went vacuous for that language — the worst failure
 * mode, because a vacuous gauntlet passes.
 */

const fixture: { root: string } = { root: '' }

beforeEach(async () => {
  fixture.root = await fs.mkdtemp(path.join(os.tmpdir(), 'prjct-polyglot-'))
})

afterEach(async () => {
  await fs.rm(fixture.root, { recursive: true, force: true }).catch(() => undefined)
})

async function write(rel: string, content: string): Promise<void> {
  const target = path.join(fixture.root, rel)
  await fs.mkdir(path.dirname(target), { recursive: true })
  await fs.writeFile(target, content)
}

async function kinds(): Promise<Set<string>> {
  const facts = await detectVerifiedCommands(fixture.root)
  return new Set(facts.commands.map((c) => c.kind))
}

async function commandFor(kind: string): Promise<string | undefined> {
  const facts = await detectVerifiedCommands(fixture.root)
  return facts.commands.find((c) => c.kind === kind)?.command
}

describe('gauntlet verify-command detection is polyglot', () => {
  it('Node — reads author-chosen package.json scripts', async () => {
    await write(
      'package.json',
      JSON.stringify({
        scripts: { test: 'vitest run', lint: 'eslint .', typecheck: 'tsc --noEmit' },
      })
    )
    expect(await kinds()).toEqual(new Set(['typecheck', 'lint', 'test']))
    expect(await commandFor('test')).toBe('vitest run')
  })

  it('Rust — cargo check/test/clippy from Cargo.toml alone', async () => {
    await write('Cargo.toml', '[package]\nname = "x"\n')
    const found = await kinds()
    expect(found.has('typecheck')).toBe(true) // cargo check
    expect(found.has('test')).toBe(true)
    expect(found.has('lint')).toBe(true) // cargo clippy
    expect(await commandFor('typecheck')).toBe('cargo check')
  })

  it('Go — test/vet from go.mod alone', async () => {
    await write('go.mod', 'module example.com/x\n\ngo 1.22\n')
    expect(await commandFor('test')).toBe('go test ./...')
    expect(await commandFor('lint')).toBe('go vet ./...')
  })

  it('Python — only tools pyproject.toml actually configures', async () => {
    await write('pyproject.toml', '[tool.pytest.ini_options]\n[tool.mypy]\n')
    const found = await kinds()
    expect(found.has('test')).toBe(true)
    expect(found.has('typecheck')).toBe(true)
    expect(found.has('lint')).toBe(false) // no [tool.ruff] → never assumed
  })

  it('Java/Maven — prefers the ./mvnw wrapper when the repo pins one', async () => {
    await write('pom.xml', '<project></project>')
    expect(await commandFor('test')).toBe('mvn -B test')
    await write('mvnw', '#!/bin/sh\n')
    expect(await commandFor('test')).toBe('./mvnw -B test')
  })

  it('Gradle — prefers ./gradlew, supports .kts', async () => {
    await write('build.gradle.kts', 'plugins {}\n')
    expect(await commandFor('test')).toBe('gradle test')
    await write('gradlew', '#!/bin/sh\n')
    expect(await commandFor('test')).toBe('./gradlew test')
  })

  it('Ruby — rspec/rubocop only when configured', async () => {
    await write('Gemfile', "source 'https://rubygems.org'\n")
    expect((await kinds()).size).toBe(0) // Gemfile alone proves nothing
    await write('.rspec', '--require spec_helper\n')
    await write('.rubocop.yml', 'AllCops:\n')
    expect(await commandFor('test')).toBe('bundle exec rspec')
    expect(await commandFor('lint')).toBe('bundle exec rubocop')
  })

  it('PHP — phpunit/phpstan only when configured', async () => {
    await write('composer.json', '{}')
    await write('phpunit.xml', '<phpunit/>')
    expect(await commandFor('test')).toBe('vendor/bin/phpunit')
  })

  it('.NET — from a .csproj or .sln in the tree', async () => {
    await write('App.csproj', '<Project/>')
    expect(await commandFor('test')).toBe('dotnet test')
  })

  it('Elixir — mix test + warnings-as-errors compile', async () => {
    await write('mix.exs', 'defmodule X.MixProject do\nend\n')
    expect(await commandFor('test')).toBe('mix test')
    expect(await commandFor('typecheck')).toBe('mix compile --warnings-as-errors')
  })

  it('Make — the catch-all for C/C++/anything, but only declared targets', async () => {
    await write('Makefile', 'all:\n\tcc main.c\n\ntest:\n\t./run_tests.sh\n')
    expect(await commandFor('test')).toBe('make test')
    expect((await kinds()).has('lint')).toBe(false) // no `lint:` target declared
  })

  it('polyglot repo — the ecosystem toolchain wins over the Makefile', async () => {
    await write('package.json', JSON.stringify({ scripts: { test: 'bun test' } }))
    await write('Makefile', 'test:\n\t./legacy.sh\n')
    // Consumers take the first command per kind; Make is concatenated last.
    expect(await commandFor('test')).toBe('bun test')
  })

  it('an unknown ecosystem detects nothing — which is why declaring is the guarantee', async () => {
    await write('Package.swift', '// swift-tools-version:5.9\n')
    expect((await kinds()).size).toBe(0)
  })
})
