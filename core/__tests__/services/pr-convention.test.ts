import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { defaultPrConventionFor, detectPrConventionSignal } from '../../services/pr-convention'

function initGit(projectPath: string, remote?: string): void {
  execFileSync('git', ['init', '-q'], { cwd: projectPath })
  if (remote) {
    execFileSync('git', ['remote', 'add', 'origin', remote], { cwd: projectPath })
  }
}

describe('detectPrConventionSignal', () => {
  const fixture: { projectPath: string } = { projectPath: '' }

  beforeEach(async () => {
    fixture.projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'prjct-pr-convention-'))
  })

  afterEach(async () => {
    if (fixture.projectPath) await fs.rm(fixture.projectPath, { recursive: true, force: true })
  })

  test('finds a committed PR template before ever looking at the remote', async () => {
    await fs.mkdir(path.join(fixture.projectPath, '.github'), { recursive: true })
    await fs.writeFile(
      path.join(fixture.projectPath, '.github', 'pull_request_template.md'),
      '## Summary\n'
    )
    initGit(fixture.projectPath, 'https://github.com/acme/widgets.git')

    const signal = await detectPrConventionSignal(fixture.projectPath)
    expect(signal.kind).toBe('template')
    expect(defaultPrConventionFor(signal)).toBe('auto')
  })

  test('github remote with no template is ambiguous', async () => {
    initGit(fixture.projectPath, 'git@github.com:acme/widgets.git')

    const signal = await detectPrConventionSignal(fixture.projectPath)
    expect(signal.kind).toBe('github-ambiguous')
    expect(defaultPrConventionFor(signal)).toBe('auto')
  })

  test('non-GitHub remote defaults to manual — pr:ensure only speaks gh', async () => {
    initGit(fixture.projectPath, 'https://gitlab.com/acme/widgets.git')

    const signal = await detectPrConventionSignal(fixture.projectPath)
    expect(signal.kind).toBe('non-github')
    expect(defaultPrConventionFor(signal)).toBe('manual')
  })

  test('no remote configured defaults to manual', async () => {
    initGit(fixture.projectPath)

    const signal = await detectPrConventionSignal(fixture.projectPath)
    expect(signal.kind).toBe('no-remote')
    expect(defaultPrConventionFor(signal)).toBe('manual')
  })

  test('not a git repo at all defaults to manual', async () => {
    const signal = await detectPrConventionSignal(fixture.projectPath)
    expect(signal.kind).toBe('no-remote')
    expect(defaultPrConventionFor(signal)).toBe('manual')
  })
})
