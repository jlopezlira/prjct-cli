/**
 * `scanLegacyRepoCrewFiles` — report-only detector for crew files an older
 * prjct wrote into the customer worktree.
 *
 * Spins up a temp repo, plants leftovers, and asserts what is named. The
 * load-bearing case is the last one: the scan must leave the tree byte-for-byte
 * unchanged, because prjct does not delete from a repo it does not own.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  formatLegacyRepoCrewLine,
  scanLegacyRepoCrewFiles,
} from '../../services/legacy-repo-crew-scan'

const STALE_AGENT = `---\nname: leader\n---\n\nWrite a plan to \`.prjct/sessions/<task-slug>/plan.md\`.\n`

const fixture: { projectPath: string } = { projectPath: '' }

beforeEach(async () => {
  fixture.projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'prjct-crew-scan-'))
})

afterEach(async () => {
  if (fixture.projectPath) {
    await fs.rm(fixture.projectPath, { recursive: true, force: true }).catch(() => undefined)
    fixture.projectPath = ''
  }
})

async function write(relative: string, content: string): Promise<string> {
  const abs = path.join(fixture.projectPath, relative)
  await fs.mkdir(path.dirname(abs), { recursive: true })
  await fs.writeFile(abs, content, 'utf-8')
  return abs
}

describe('scanLegacyRepoCrewFiles', () => {
  test('a clean tree reports nothing', async () => {
    const scan = await scanLegacyRepoCrewFiles(fixture.projectPath)
    expect(scan.staleFiles).toEqual([])
    expect(scan.errors).toEqual([])
    expect(formatLegacyRepoCrewLine(scan)).toBeNull()
  })

  test('names a leftover agent file that instructs worktree writes', async () => {
    await write(path.join('.claude', 'agents', 'leader.md'), STALE_AGENT)

    const scan = await scanLegacyRepoCrewFiles(fixture.projectPath)
    expect(scan.staleFiles).toEqual([path.join('.claude', 'agents', 'leader.md')])
    expect(formatLegacyRepoCrewLine(scan)).toContain('.prjct/sessions/')
  })

  test('names CREW.md and the CLAUDE.md marker block', async () => {
    await write('CREW.md', STALE_AGENT)
    await write('CLAUDE.md', '<!-- prjct:crew:start -->\nanything\n<!-- prjct:crew:end -->\n')

    const scan = await scanLegacyRepoCrewFiles(fixture.projectPath)
    expect(scan.staleFiles.sort()).toEqual(['CLAUDE.md', 'CREW.md'])
  })

  test("ignores a user's own agent file that never names the session path", async () => {
    await write(
      path.join('.claude', 'agents', 'leader.md'),
      '---\nname: leader\n---\n\nReview the diff and report findings inline.\n'
    )

    const scan = await scanLegacyRepoCrewFiles(fixture.projectPath)
    expect(scan.staleFiles).toEqual([])
  })

  test('ignores ban-only mentions of the session path', async () => {
    await write(
      path.join('.claude', 'agents', 'reviewer.md'),
      '---\nname: reviewer\n---\n\nNever write `.prjct/sessions/` into the customer worktree.\n'
    )

    const scan = await scanLegacyRepoCrewFiles(fixture.projectPath)
    expect(scan.staleFiles).toEqual([])
  })

  test('leaves the worktree byte-for-byte unchanged', async () => {
    const agentPath = await write(path.join('.claude', 'agents', 'leader.md'), STALE_AGENT)
    const crewPath = await write('CREW.md', STALE_AGENT)
    const claudePath = await write('CLAUDE.md', '<!-- prjct:crew:start -->\nx\n')

    const scan = await scanLegacyRepoCrewFiles(fixture.projectPath)
    expect(scan.staleFiles.length).toBe(3)

    expect(await fs.readFile(agentPath, 'utf-8')).toBe(STALE_AGENT)
    expect(await fs.readFile(crewPath, 'utf-8')).toBe(STALE_AGENT)
    expect(await fs.readFile(claudePath, 'utf-8')).toBe('<!-- prjct:crew:start -->\nx\n')
  })
})
