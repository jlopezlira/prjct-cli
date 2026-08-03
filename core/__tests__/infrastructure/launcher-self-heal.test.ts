import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const ROOT = path.resolve(__dirname, '../../..')
const LAUNCHER = path.join(ROOT, 'bin/prjct')
const STATUSLINE_SOURCE = path.join(ROOT, 'assets/statusline/statusline.sh')
const SKILL_SOURCE = path.join(ROOT, 'templates/skills/prjct/SKILL.md')
const SKILL_BODY = fs.readFileSync(SKILL_SOURCE, 'utf8')
const PACKAGE_VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
  .version as string

let tempDir: string
let testHome: string
let setupLog: string

function writeExecutable(filePath: string, body: string): void {
  fs.writeFileSync(filePath, body, { mode: 0o755 })
}

function resolveExecutable(command: string): string {
  for (const directory of (process.env.PATH ?? '').split(path.delimiter)) {
    const candidate = path.join(directory || '.', command)
    try {
      fs.accessSync(candidate, fs.constants.X_OK)
      return candidate
    } catch {
      // Try the next PATH entry.
    }
  }
  throw new Error(`Required test executable not found on PATH: ${command}`)
}

function installMutationWrappers(binDir: string): void {
  const commands = ['mkdir', 'cp', 'chmod', 'rm', 'ln', 'sed'].map(
    (command) => [command, resolveExecutable(command)] as const
  )
  const failLn = 'if [ "$PRJCT_TEST_FAIL_LN" = "1" ]; then exit 1; fi\n'
  for (const [command, executable] of commands) {
    writeExecutable(
      path.join(binDir, command),
      `#!/bin/sh\nprintf '%s\\n' '${command}' >> "$PRJCT_TEST_SETUP_LOG"\n${command === 'ln' ? failLn : ''}exec ${JSON.stringify(executable)} "$@"\n`
    )
  }
}

function installCurrentDestinations(): void {
  const statuslineDir = path.join(testHome, '.prjct-cli/statusline')
  const statuslineDest = path.join(statuslineDir, 'statusline.sh')
  const claudeDir = path.join(testHome, '.claude')
  const skillDest = path.join(claudeDir, 'skills/prjct/SKILL.md')

  fs.mkdirSync(path.dirname(skillDest), { recursive: true })
  fs.mkdirSync(statuslineDir, { recursive: true })
  fs.writeFileSync(
    statuslineDest,
    fs
      .readFileSync(STATUSLINE_SOURCE, 'utf8')
      .replace('CLI_VERSION="__VERSION__"', `CLI_VERSION="${PACKAGE_VERSION}"`)
  )
  fs.writeFileSync(skillDest, SKILL_BODY)
  fs.chmodSync(statuslineDest, 0o755)
  fs.symlinkSync(statuslineDest, path.join(claudeDir, 'prjct-statusline.sh'))

  // Destination-newer is deterministic and models an already current install.
  const future = new Date('2100-01-01T00:00:00.000Z')
  fs.utimesSync(statuslineDest, future, future)
  fs.utimesSync(skillDest, future, future)
}

function runLauncher(options: { failLn?: boolean } = {}): string[] {
  fs.writeFileSync(setupLog, '')
  const result = spawnSync('/bin/sh', [LAUNCHER, '--version'], {
    cwd: ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: testHome,
      PATH: `${path.join(tempDir, 'bin')}:/usr/bin:/bin`,
      PRJCT_TEST_SETUP_LOG: setupLog,
      PRJCT_TEST_FAIL_LN: options.failLn ? '1' : '0',
    },
  })

  expect(result.status).toBe(0)
  return fs.readFileSync(setupLog, 'utf8').split('\n').filter(Boolean)
}

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prjct-launcher-self-heal-'))
  testHome = path.join(tempDir, 'home')
  setupLog = path.join(tempDir, 'setup.log')
  const binDir = path.join(tempDir, 'bin')
  fs.mkdirSync(binDir, { recursive: true })
  writeExecutable(path.join(binDir, 'bun'), '#!/bin/sh\nexit 0\n')
  installMutationWrappers(binDir)
})

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true })
})

describe('bin/prjct statusline self-heal', () => {
  test('does not run setup mutations for current statusline and skill destinations', () => {
    installCurrentDestinations()
    const statuslineDest = path.join(testHome, '.prjct-cli/statusline/statusline.sh')
    const skillDest = path.join(testHome, '.claude/skills/prjct/SKILL.md')
    const before = [statuslineDest, skillDest].map((filePath) => ({
      body: fs.readFileSync(filePath, 'utf8'),
      mtimeMs: fs.statSync(filePath).mtimeMs,
    }))

    expect(runLauncher()).toEqual([])
    expect(
      [statuslineDest, skillDest].map((filePath) => ({
        body: fs.readFileSync(filePath, 'utf8'),
        mtimeMs: fs.statSync(filePath).mtimeMs,
      }))
    ).toEqual(before)
  })

  test('installs statusline and skill when HOME has no .claude directory', () => {
    const statuslineDest = path.join(testHome, '.prjct-cli/statusline/statusline.sh')
    const claudeStatusline = path.join(testHome, '.claude/prjct-statusline.sh')
    const skillDest = path.join(testHome, '.claude/skills/prjct/SKILL.md')

    const mutations = runLauncher()

    expect(mutations).toContain('mkdir')
    expect(mutations).toContain('cp')
    expect(mutations).toContain('ln')
    expect(fs.lstatSync(claudeStatusline).isSymbolicLink()).toBe(true)
    expect(fs.realpathSync(claudeStatusline)).toBe(fs.realpathSync(statuslineDest))
    expect(fs.readFileSync(skillDest, 'utf8')).toBe(SKILL_BODY)
  })

  test('repairs a missing statusline destination', () => {
    installCurrentDestinations()
    const statuslineDest = path.join(testHome, '.prjct-cli/statusline/statusline.sh')
    const claudeStatusline = path.join(testHome, '.claude/prjct-statusline.sh')
    fs.rmSync(statuslineDest)
    fs.rmSync(claudeStatusline)

    const mutations = runLauncher()

    expect(mutations).toContain('mkdir')
    expect(mutations).toContain('cp')
    expect(fs.readFileSync(statuslineDest, 'utf8')).toContain(`CLI_VERSION="${PACKAGE_VERSION}"`)
    expect(fs.realpathSync(claudeStatusline)).toBe(fs.realpathSync(statuslineDest))
  })

  test('repairs a stale statusline destination', () => {
    installCurrentDestinations()
    const statuslineDest = path.join(testHome, '.prjct-cli/statusline/statusline.sh')
    fs.writeFileSync(statuslineDest, '#!/bin/sh\nCLI_VERSION="stale"\n')
    const stale = new Date(1_000)
    fs.utimesSync(statuslineDest, stale, stale)

    const mutations = runLauncher()

    expect(mutations).toContain('mkdir')
    expect(mutations).toContain('cp')
    const repaired = fs.readFileSync(statuslineDest, 'utf8')
    expect(repaired).not.toContain('CLI_VERSION="stale"')
    expect(repaired).toContain(`CLI_VERSION="${PACKAGE_VERSION}"`)
  })

  test('repairs a missing skill destination with the exact source body', () => {
    installCurrentDestinations()
    const skillDest = path.join(testHome, '.claude/skills/prjct/SKILL.md')
    fs.rmSync(skillDest)

    const mutations = runLauncher()

    expect(mutations).toContain('mkdir')
    expect(mutations).toContain('cp')
    expect(fs.readFileSync(skillDest, 'utf8')).toBe(SKILL_BODY)
  })

  test('repairs a stale skill destination with the exact source body', () => {
    installCurrentDestinations()
    const skillDest = path.join(testHome, '.claude/skills/prjct/SKILL.md')
    fs.writeFileSync(skillDest, 'stale skill\n')
    const stale = new Date(1_000)
    fs.utimesSync(skillDest, stale, stale)

    const mutations = runLauncher()

    expect(mutations).toContain('mkdir')
    expect(mutations).toContain('cp')
    expect(fs.readFileSync(skillDest, 'utf8')).toBe(SKILL_BODY)
  })

  test('falls back to a regular statusline copy when symlink creation fails', () => {
    installCurrentDestinations()
    const statuslineDest = path.join(testHome, '.prjct-cli/statusline/statusline.sh')
    const claudeStatusline = path.join(testHome, '.claude/prjct-statusline.sh')
    fs.rmSync(statuslineDest)
    fs.rmSync(claudeStatusline)

    const mutations = runLauncher({ failLn: true })

    expect(mutations).toContain('ln')
    expect(mutations.filter((mutation) => mutation === 'cp').length).toBeGreaterThan(1)
    const installed = fs.lstatSync(claudeStatusline)
    expect(installed.isSymbolicLink()).toBe(false)
    expect(installed.isFile()).toBe(true)
    expect(fs.readFileSync(claudeStatusline, 'utf8')).toBe(fs.readFileSync(statuslineDest, 'utf8'))
  })
})
