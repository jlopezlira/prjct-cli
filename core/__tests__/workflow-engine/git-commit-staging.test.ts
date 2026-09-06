/**
 * SEC-09: the ship commit's fallback staging (empty index → take the working
 * tree) must never sweep credential material into a release commit. It skips
 * secret-like paths (.env, key files) and files whose bytes trip the secret
 * scanner, staging everything else. Real temp git repo, asserts on what git
 * actually staged.
 *
 * Secret-shaped fixtures are assembled at RUNTIME — a literal one would be
 * denied by the pre-secrets guard (this file could not be written) and no
 * credential-shaped literal belongs in the repo.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { execFile } from 'node:child_process'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { stageWorkingTree } from '../../workflow-engine/workflow-engine'

const run = promisify(execFile)
const fixture = { repo: '' }

const PEM = `-----BEGIN RSA ${'PRIVATE KEY-----'}\n`
const AWS_SECRET = 'Kp9rXe2LqTv7Nb4Zc1Hm6Wd3Yf8Ju5Ra0Sg7Vt2B'
const AWS_LEAK = `const aws_secret_access_key = "${AWS_SECRET}"\n`

async function git(args: string[]): Promise<string> {
  const { stdout } = await run('git', args, { cwd: fixture.repo })
  return stdout.trim()
}

beforeEach(async () => {
  fixture.repo = await fsp.mkdtemp(path.join(os.tmpdir(), 'prjct-stage-'))
  await git(['init', '-q'])
  await git(['config', 'user.email', 't@t'])
  await git(['config', 'user.name', 't'])
})

afterEach(async () => {
  await fsp.rm(fixture.repo, { recursive: true, force: true }).catch(() => {})
})

const write = (rel: string, body: string) =>
  fsp
    .mkdir(path.dirname(path.join(fixture.repo, rel)), { recursive: true })
    .then(() => fsp.writeFile(path.join(fixture.repo, rel), body))

describe('stageWorkingTree', () => {
  it('stages ordinary files and skips credential material', async () => {
    await write('src/app.ts', 'export const x = 1\n')
    await write('README.md', '# hello\n')
    await write('.env', 'API_KEY=sk-live-abc\n')
    await write('deploy/id_rsa', PEM)
    await write('config/secrets.pem', PEM)
    // Ordinary-named file whose CONTENTS are a real secret.
    await write('src/leak.ts', AWS_LEAK)

    const { added, skipped } = await stageWorkingTree(fixture.repo)

    expect(added).toContain('src/app.ts')
    expect(added).toContain('README.md')
    const skippedPaths = skipped.map((s) => s.split(' ')[0])
    expect(skippedPaths).toContain('.env')
    expect(skippedPaths).toContain('deploy/id_rsa')
    expect(skippedPaths).toContain('config/secrets.pem')
    expect(skippedPaths).toContain('src/leak.ts')

    const staged = (await git(['diff', '--cached', '--name-only'])).split('\n').filter(Boolean)
    expect(staged.sort()).toEqual(['README.md', 'src/app.ts'])
  })

  it('stages a large ordinary file and does not choke on a binary blob', async () => {
    await write('data/big.txt', `${'lorem ipsum '.repeat(100_000)}\n`)
    await write('assets/logo.bin', `binary\0data${String.fromCharCode(1, 2, 3)}`)
    const { added } = await stageWorkingTree(fixture.repo)
    expect(added).toContain('data/big.txt')
    expect(added).toContain('assets/logo.bin')
  })
})
