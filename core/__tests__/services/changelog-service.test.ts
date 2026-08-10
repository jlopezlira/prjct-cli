import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { ChangelogService } from '../../services/changelog-service'

// Idempotency guards against the "double changelog entry on ship retry"
// failure mode where a partial ship leaves CHANGELOG.md modified, then
// the retry stacks another entry on top instead of reusing the existing
// one.

describe('ChangelogService.addFeature (idempotency)', () => {
  const fixture: {
    dir: string
  } = {
    dir: '',
  }

  beforeEach(async () => {
    fixture.dir = await fs.mkdtemp(path.join(os.tmpdir(), 'prjct-changelog-'))
  })

  afterEach(async () => {
    await fs.rm(fixture.dir, { recursive: true, force: true }).catch(() => {})
  })

  async function readChangelog(): Promise<string> {
    return fs.readFile(path.join(fixture.dir, 'CHANGELOG.md'), 'utf-8')
  }

  it('appends a new entry on first call', async () => {
    const svc = new ChangelogService(fixture.dir)
    await svc.addFeature('1.2.4', 'first feature')
    expect(await readChangelog()).toContain('## [1.2.4]')
    expect(await readChangelog()).toContain('first feature')
  })

  it('does NOT add a duplicate entry when version already exists', async () => {
    const svc = new ChangelogService(fixture.dir)
    await svc.addFeature('1.2.4', 'first feature')
    const before = await readChangelog()

    // Retry with same version — should be a no-op.
    await svc.addFeature('1.2.4', 'spurious second call')
    const after = await readChangelog()
    expect(after).toBe(before)
    expect((after.match(/^## \[1\.2\.4\]/gm) ?? []).length).toBe(1)
    expect(after).not.toContain('spurious second call')
  })

  it('still adds entries for new versions after an existing entry', async () => {
    const svc = new ChangelogService(fixture.dir)
    await svc.addFeature('1.2.4', 'patch')
    await svc.addFeature('1.3.0', 'feature')
    const content = await readChangelog()
    expect(content).toContain('## [1.2.4]')
    expect(content).toContain('## [1.3.0]')
  })

  it('PROMOTES [Unreleased] into the release, leaving a fresh empty one (mem_2895)', async () => {
    const file = path.join(fixture.dir, 'CHANGELOG.md')
    await fs.writeFile(
      file,
      [
        '# Changelog',
        '',
        'Based on [Keep a Changelog](https://keepachangelog.com/).',
        '',
        '## [Unreleased]',
        '',
        '### Added',
        '- **rich hand-written entry** with detail',
        '',
        '### Fixed',
        '- a real bug fix',
        '',
        '## [1.2.3] - 2025-01-01',
        '',
        '### Added',
        '- old release',
        '',
      ].join('\n')
    )
    const svc = new ChangelogService(fixture.dir)
    await svc.addFeature('1.3.0', 'ship feature line')
    const c = await readChangelog()

    // Exactly ONE [Unreleased], and it is empty + on top.
    expect((c.match(/^## \[Unreleased\]/gm) ?? []).length).toBe(1)
    // The rich content was carried INTO the release, not stranded.
    const relIdx = c.indexOf('## [1.3.0]')
    const unrelIdx = c.indexOf('## [Unreleased]')
    expect(unrelIdx).toBeLessThan(relIdx) // Unreleased above the new release
    expect(c).toContain('## [1.3.0]')
    expect(c.slice(relIdx)).toContain('rich hand-written entry') // rich content under the release
    expect(c.slice(relIdx)).toContain('a real bug fix')
    expect(c.slice(relIdx)).toContain('ship feature line') // ship feature folded in
    // No stranded [Unreleased] below a version, prior release intact.
    expect(c).toContain('## [1.2.3] - 2025-01-01')
    expect(c).not.toMatch(/## \[1\.3\.0\][\s\S]*## \[Unreleased\]/) // Unreleased never below the release
  })

  it('does not re-strand across consecutive ships (the 3× recurrence)', async () => {
    const file = path.join(fixture.dir, 'CHANGELOG.md')
    await fs.writeFile(file, `${'# Changelog'}\n\nKeep a Changelog\n\n## [Unreleased]\n\n`)
    const svc = new ChangelogService(fixture.dir)

    await svc.addFeature('2.0.0', 'first ship')
    // A dev/process accumulates rich content under the fresh [Unreleased].
    const c = (await readChangelog()).replace(
      /## \[Unreleased\]\n/,
      '## [Unreleased]\n\n### Changed\n- accumulated work\n'
    )
    await fs.writeFile(file, c)
    await svc.addFeature('2.1.0', 'second ship')

    const final = await readChangelog()
    expect((final.match(/^## \[Unreleased\]/gm) ?? []).length).toBe(1) // never piles up
    expect(final).toContain('## [2.0.0]')
    expect(final).toContain('## [2.1.0]')
    // The accumulated work landed in 2.1.0, not stranded under [Unreleased].
    const v210 = final.slice(final.indexOf('## [2.1.0]'))
    expect(v210).toContain('accumulated work')
    expect(final.indexOf('## [Unreleased]')).toBeLessThan(final.indexOf('## [2.1.0]'))
  })

  it('handles generic markdown format (no Keep a Changelog markers)', async () => {
    const file = path.join(fixture.dir, 'CHANGELOG.md')
    await fs.writeFile(file, '# Changelog\n\n## 1.2.3 - 2025-01-01\n\n- old entry\n')
    const svc = new ChangelogService(fixture.dir)
    await svc.addFeature('1.2.4', 'new feature')
    const content = await readChangelog()
    expect(content).toContain('## 1.2.4')

    // Idempotent retry.
    await svc.addFeature('1.2.4', 'spurious')
    expect((content.match(/^## 1\.2\.4/gm) ?? []).length).toBe(1)
  })
})
