/**
 * Project command detection tests
 * Ensures prjct-cli uses the repo's own test/lint tooling (not hardcoded).
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { detectProjectCommands } from '../../utils/project-commands'

const fixture: {
  tmpRoot: string | null
} = {
  tmpRoot: null,
}

async function writeJson(filePath: string, data: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf-8')
}

async function writeText(filePath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.writeFile(filePath, content, 'utf-8')
}

describe('detectProjectCommands', () => {
  beforeEach(async () => {
    fixture.tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'prjct-detect-commands-'))
  })

  afterEach(async () => {
    if (!fixture.tmpRoot) return
    await fs.rm(fixture.tmpRoot, { recursive: true, force: true })
    fixture.tmpRoot = null
  })

  it('detects JS project and respects declared pnpm packageManager', async () => {
    await writeJson(path.join(fixture.tmpRoot!, 'package.json'), {
      name: 'x',
      packageManager: 'pnpm@9.0.0',
      scripts: { test: 'vitest', lint: 'eslint .', typecheck: 'tsc -p tsconfig.json' },
    })

    const detected = await detectProjectCommands(fixture.tmpRoot!)
    expect(detected.stack).toBe('js')
    expect(detected.packageManager).toBe('pnpm')
    expect(detected.test?.command).toBe('pnpm test')
    expect(detected.lint?.command).toBe('pnpm run lint')
    expect(detected.typecheck?.command).toBe('pnpm run typecheck')
  })

  it('detects Python pytest via pytest.ini', async () => {
    await writeText(path.join(fixture.tmpRoot!, 'pytest.ini'), '[pytest]\n')
    const detected = await detectProjectCommands(fixture.tmpRoot!)
    expect(detected.stack).toBe('python')
    expect(detected.test?.command).toBe('pytest')
  })

  it('detects Go via go.mod', async () => {
    await writeText(path.join(fixture.tmpRoot!, 'go.mod'), 'module example.com/test\n')
    const detected = await detectProjectCommands(fixture.tmpRoot!)
    expect(detected.stack).toBe('go')
    expect(detected.test?.command).toBe('go test ./...')
  })

  it('detects Rust via Cargo.toml', async () => {
    await writeText(
      path.join(fixture.tmpRoot!, 'Cargo.toml'),
      '[package]\nname="x"\nversion="0.1.0"\n'
    )
    const detected = await detectProjectCommands(fixture.tmpRoot!)
    expect(detected.stack).toBe('rust')
    expect(detected.test?.command).toBe('cargo test')
  })

  // Version file detection
  it('detects package.json as version file for JS projects', async () => {
    await writeJson(path.join(fixture.tmpRoot!, 'package.json'), {
      name: 'x',
      version: '1.0.0',
      scripts: { test: 'vitest' },
    })
    const detected = await detectProjectCommands(fixture.tmpRoot!)
    expect(detected.versionFile).toBe('package.json')
  })

  it('detects Cargo.toml as version file for Rust projects', async () => {
    await writeText(
      path.join(fixture.tmpRoot!, 'Cargo.toml'),
      '[package]\nname="x"\nversion="0.1.0"\n'
    )
    const detected = await detectProjectCommands(fixture.tmpRoot!)
    expect(detected.versionFile).toBe('Cargo.toml')
  })

  it('detects pyproject.toml as version file for Python projects', async () => {
    await writeText(path.join(fixture.tmpRoot!, 'pyproject.toml'), '[tool.pytest]\n')
    const detected = await detectProjectCommands(fixture.tmpRoot!)
    expect(detected.versionFile).toBe('pyproject.toml')
  })

  it('detects VERSION file for Go projects', async () => {
    await writeText(path.join(fixture.tmpRoot!, 'go.mod'), 'module example.com/test\n')
    await writeText(path.join(fixture.tmpRoot!, 'VERSION'), '1.2.3\n')
    const detected = await detectProjectCommands(fixture.tmpRoot!)
    expect(detected.versionFile).toBe('VERSION')
  })

  it('detects .csproj as version file for .NET projects', async () => {
    await writeText(path.join(fixture.tmpRoot!, 'MyApp.csproj'), '<Project></Project>\n')
    const detected = await detectProjectCommands(fixture.tmpRoot!)
    expect(detected.stack).toBe('dotnet')
    expect(detected.versionFile).toBe('MyApp.csproj')
  })

  // Changelog file detection
  it('detects CHANGELOG.md', async () => {
    await writeJson(path.join(fixture.tmpRoot!, 'package.json'), { name: 'x', version: '1.0.0' })
    await writeText(path.join(fixture.tmpRoot!, 'CHANGELOG.md'), '# Changelog\n')
    const detected = await detectProjectCommands(fixture.tmpRoot!)
    expect(detected.changelogFile).toBe('CHANGELOG.md')
  })

  it('detects HISTORY.md as changelog', async () => {
    await writeJson(path.join(fixture.tmpRoot!, 'package.json'), { name: 'x', version: '1.0.0' })
    await writeText(path.join(fixture.tmpRoot!, 'HISTORY.md'), '# History\n')
    const detected = await detectProjectCommands(fixture.tmpRoot!)
    expect(detected.changelogFile).toBe('HISTORY.md')
  })

  it('prefers CHANGELOG.md over HISTORY.md', async () => {
    await writeJson(path.join(fixture.tmpRoot!, 'package.json'), { name: 'x', version: '1.0.0' })
    await writeText(path.join(fixture.tmpRoot!, 'CHANGELOG.md'), '# Changelog\n')
    await writeText(path.join(fixture.tmpRoot!, 'HISTORY.md'), '# History\n')
    const detected = await detectProjectCommands(fixture.tmpRoot!)
    expect(detected.changelogFile).toBe('CHANGELOG.md')
  })

  it('returns undefined for missing version/changelog files', async () => {
    await writeText(path.join(fixture.tmpRoot!, 'go.mod'), 'module example.com/test\n')
    const detected = await detectProjectCommands(fixture.tmpRoot!)
    expect(detected.versionFile).toBeUndefined()
    expect(detected.changelogFile).toBeUndefined()
  })

  it('detects version and changelog files for unknown stack', async () => {
    await writeText(path.join(fixture.tmpRoot!, 'VERSION'), '0.1.0\n')
    await writeText(path.join(fixture.tmpRoot!, 'CHANGES.md'), '# Changes\n')
    const detected = await detectProjectCommands(fixture.tmpRoot!)
    expect(detected.stack).toBe('unknown')
    expect(detected.versionFile).toBe('VERSION')
    expect(detected.changelogFile).toBe('CHANGES.md')
  })
})
