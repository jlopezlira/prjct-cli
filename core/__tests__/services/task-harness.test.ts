import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { CurrentTask } from '../../schemas/state'
import { buildTaskHarness, evaluateHarnessCompletion } from '../../services/task-harness'
import { execFileAsync } from '../../utils/exec'

const fixture: {
  dir: string
} = {
  dir: '',
}

async function git(args: string[]): Promise<void> {
  await execFileAsync('git', args, { cwd: fixture.dir })
}

async function currentTask(description: string): Promise<CurrentTask> {
  return {
    id: 'task-1',
    description,
    startedAt: new Date().toISOString(),
    sessionId: 'session-1',
    harness: buildTaskHarness(description),
  }
}

beforeEach(async () => {
  fixture.dir = await fs.mkdtemp(path.join(os.tmpdir(), 'prjct-task-harness-'))
  await git(['init', '-q', '-b', 'main'])
  await git(['config', 'user.email', 'test@example.com'])
  await git(['config', 'user.name', 'Test'])
  await git(['config', 'commit.gpgsign', 'false'])
  await fs.mkdir(path.join(fixture.dir, 'src'), { recursive: true })
  await fs.writeFile(path.join(fixture.dir, 'src', 'index.ts'), 'export const value = 1\n')
  await git(['add', '.'])
  await git(['commit', '-q', '-m', 'init'])
})

afterEach(async () => {
  await fs.rm(fixture.dir, { recursive: true, force: true }).catch(() => {})
})

describe('buildTaskHarness', () => {
  test('classifies a Codex install bug as H1 with regression evidence', () => {
    const harness = buildTaskHarness('bug en codex no se instala el statusbar eso es un must')

    expect(harness.level).toBe('H1')
    expect(harness.kind).toBe('bug')
    expect(harness.risk).toBe('high')
    expect(harness.expectedEvidence).toContain('regression-test')
    expect(harness.expectedEvidence).toContain('docs-if-public-behavior')
    expect(harness.gates).toContain('verify-before-done')
  })

  test('classifies a new implementation as H2 with scope-check evidence', () => {
    const harness = buildTaskHarness('implement transparent auto-harness on task start')

    expect(harness.level).toBe('H2')
    expect(harness.kind).toBe('feature')
    expect(harness.expectedEvidence).toContain('scope-check')
    expect(harness.expectedEvidence).toContain('spec-or-design')
  })

  test('keeps docs-only work low friction', () => {
    const harness = buildTaskHarness('docs typo in README')

    expect(harness.level).toBe('H0')
    expect(harness.kind).toBe('docs')
    expect(harness.expectedEvidence).toEqual([])
    expect(harness.gates).toEqual([])
  })

  test('classifies a Spanish "revisa" research ask as H1 research, not H2 feature', () => {
    // Live friction case: this exact phrasing fell through the research
    // check (missing "revisa"), hit 'mejora' in the feature branch, and
    // triggered discuss-lock's H2 ceremony on a pure research ask.
    const harness = buildTaskHarness(
      'revisa que otras mejoras de eficiencia para los modelos, plan para agentes y sobre todo performance podemos hacer'
    )

    expect(harness.kind).toBe('research')
    expect(harness.level).toBe('H1')
  })

  test('classifies "review" as research when no code-intent verb rides along', () => {
    const harness = buildTaskHarness('review the current retry logic and report back')

    expect(harness.kind).toBe('research')
    expect(harness.level).toBe('H1')
  })

  test('does NOT let "review" smuggle a real code-change task past H2 (gaming guard)', () => {
    // "review and refactor" is a genuine code-change ask; research must not
    // win just because a research verb rides in the same sentence.
    const harness = buildTaskHarness('review and refactor the export pipeline')

    expect(harness.kind).toBe('refactor')
    expect(harness.level).toBe('H2')
  })
})

describe('evaluateHarnessCompletion', () => {
  test('warns when a bug task changes product code without a regression test', async () => {
    await fs.writeFile(path.join(fixture.dir, 'src', 'index.ts'), 'export const value = 2\n')

    const evaluation = await evaluateHarnessCompletion(
      fixture.dir,
      await currentTask('fix settings regression')
    )

    expect(evaluation.changedFiles).toContain('src/index.ts')
    expect(evaluation.warnings.join('\n')).toContain('expects a regression test')
  })

  test('does not warn about regression evidence when a test file changed', async () => {
    await fs.mkdir(path.join(fixture.dir, 'src', '__tests__'), { recursive: true })
    await fs.writeFile(
      path.join(fixture.dir, 'src', '__tests__', 'index.test.ts'),
      'test("x", () => {})\n'
    )

    const evaluation = await evaluateHarnessCompletion(
      fixture.dir,
      await currentTask('fix settings regression')
    )

    expect(evaluation.observedEvidence).toContain('tests-changed')
    expect(evaluation.warnings.join('\n')).not.toContain('expects a regression test')
  })
})

describe('detectKind — word-aware matching (no mid-word false positives)', () => {
  test('"docker" no longer classifies as docs/H0 (was: substring "doc")', () => {
    const h = buildTaskHarness('add docker healthcheck to the daemon')
    expect(h.kind).not.toBe('docs')
    expect(h.level).not.toBe('H0')
  })

  test('"author" no longer classifies as security/H3 (was: substring "auth")', () => {
    const h = buildTaskHarness('update author field in package metadata')
    expect(h.kind).not.toBe('security')
    expect(h.level).not.toBe('H3')
  })

  test('"debug" no longer classifies as bug (was: substring "bug")', () => {
    expect(buildTaskHarness('debug output improvements for the daemon').kind).not.toBe('bug')
  })

  test('legit families still match: documentation→docs, authentication→security, implementation→feature', () => {
    expect(buildTaskHarness('update the documentation site').kind).toBe('docs')
    expect(buildTaskHarness('harden the authentication flow').kind).toBe('security')
    expect(buildTaskHarness('improve the implement flow for exports').kind).toBe('feature')
  })
})

/**
 * PATH-hijack: an empty dir as PATH means `git` resolves nowhere, so spawn
 * fails with a real ENOENT — exercises the infra-failure path without mocks.
 */
async function withBrokenGit<T>(fn: () => Promise<T>): Promise<T> {
  const noGitDir = await fs.mkdtemp(path.join(os.tmpdir(), 'prjct-no-git-'))
  const oldPath = process.env.PATH
  process.env.PATH = noGitDir
  try {
    return await fn()
  } finally {
    if (oldPath === undefined) delete process.env.PATH
    else process.env.PATH = oldPath
    await fs.rm(noGitDir, { recursive: true, force: true }).catch(() => {})
  }
}

describe('evaluateHarnessCompletion — typed git failures (WS1)', () => {
  test('git infra failure → "evidence unavailable", never a fabricated missing-test warning', async () => {
    if (process.platform === 'win32') return
    const task = await currentTask('bug en codex no se instala el statusbar eso es un must')
    await withBrokenGit(async () => {
      const result = await evaluateHarnessCompletion(fixture.dir, task)
      expect(result.warnings.some((w) => w.includes('evidence unavailable'))).toBe(true)
      expect(result.warnings.some((w) => w.includes('no test file changed'))).toBe(false)
    })
  })
})
