import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { detectCiVerifyCommands } from '../../services/ci-verify-commands'

/**
 * The point of this path: prjct knows NOTHING about Swift, Haskell, Zig, Scala
 * or Nim, and must still gate them. Every case below uses a language with zero
 * hardcoded support — the commands come from the repo's own CI, so the gate
 * travels to ecosystems that did not exist when this code was written.
 */

const fixture: { root: string } = { root: '' }

beforeEach(async () => {
  fixture.root = await fs.mkdtemp(path.join(os.tmpdir(), 'prjct-ci-'))
})

afterEach(async () => {
  await fs.rm(fixture.root, { recursive: true, force: true }).catch(() => undefined)
})

async function write(rel: string, content: string): Promise<void> {
  const target = path.join(fixture.root, rel)
  await fs.mkdir(path.dirname(target), { recursive: true })
  await fs.writeFile(target, content)
}

const commandFor = async (kind: string): Promise<string | undefined> =>
  (await detectCiVerifyCommands(fixture.root)).find((c) => c.kind === kind)?.command

describe('verify commands lifted from the project’s own CI', () => {
  it('Swift via GitHub Actions — a language with zero hardcoded support', async () => {
    await write(
      '.github/workflows/ci.yml',
      [
        'name: CI',
        'jobs:',
        '  build:',
        '    steps:',
        '      - uses: actions/checkout@v4',
        '      - name: Test',
        '        run: swift test',
      ].join('\n')
    )
    expect(await commandFor('test')).toBe('swift test')
  })

  it('Haskell via a multiline run block', async () => {
    await write(
      '.github/workflows/haskell.yml',
      [
        'jobs:',
        '  ci:',
        '    steps:',
        '      - run: |',
        '          stack build',
        '          stack test',
      ].join('\n')
    )
    expect(await commandFor('test')).toBe('stack test')
  })

  it('Zig + Scala via GitLab script lists', async () => {
    await write('.gitlab-ci.yml', ['verify:', '  script:', '    - zig build test'].join('\n'))
    expect(await commandFor('test')).toBe('zig build test')
  })

  it('uses the STEP NAME as the kind, so an unknown tool still classifies', async () => {
    // `credo` (Elixir) and `hlint` (Haskell) are in no keyword table anywhere —
    // the step's own name is what says "this is the lint step", in any language.
    await write(
      '.github/workflows/ci.yml',
      [
        'jobs:',
        '  ci:',
        '    steps:',
        '      - name: Lint',
        '        run: mix credo --strict',
        '      - name: Typecheck',
        '        run: dialyzer --src',
      ].join('\n')
    )
    expect(await commandFor('lint')).toBe('mix credo --strict')
    expect(await commandFor('typecheck')).toBe('dialyzer --src')
  })

  it('never lifts a command that deploys, installs, or pipes the network to a shell', async () => {
    await write(
      '.github/workflows/release.yml',
      [
        'jobs:',
        '  release:',
        '    steps:',
        '      - run: npm publish --access public',
        '      - run: curl -sSL https://example.com/i.sh | sh',
        '      - run: pip install pytest',
        '      - run: docker build -t app . && docker push app',
        '      - run: rm -rf dist',
        '      - run: kubectl apply -f k8s/',
      ].join('\n')
    )
    expect(await detectCiVerifyCommands(fixture.root)).toEqual([])
  })

  it('drops unresolved CI template expressions instead of running them', async () => {
    await write(
      '.github/workflows/ci.yml',
      ['jobs:', '  ci:', '    steps:', '      - run: ${{ matrix.test_command }}'].join('\n')
    )
    expect(await detectCiVerifyCommands(fixture.root)).toEqual([])
  })

  it('reports provenance so a receipt can say where the command came from', async () => {
    await write(
      '.github/workflows/ci.yml',
      ['jobs:', '  ci:', '    steps:', '      - run: swift test'].join('\n')
    )
    const [found] = await detectCiVerifyCommands(fixture.root)
    expect(found.source).toBe('.github/workflows/ci.yml')
  })

  it('returns nothing when the repo has no CI at all', async () => {
    await write('README.md', '# no ci here\n')
    expect(await detectCiVerifyCommands(fixture.root)).toEqual([])
  })
})
