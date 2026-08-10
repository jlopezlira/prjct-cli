/**
 * E2E harness — runs the REAL CLI entrypoint (`bun bin/prjct.ts`) as a
 * subprocess against a fully hermetic sandbox.
 *
 * Hermetic means: every invocation gets its own tmp project dir (a fresh git
 * repo) AND its own `PRJCT_CLI_HOME` + `HOME`, so the suite never reads or
 * writes the developer's real `~/.prjct-cli` data. This is the "fake project"
 * isolation — it also structurally prevents the case-variant / orphan-project
 * footgun from leaking into real data.
 *
 * The entrypoint is the repo source, so e2e always exercises the *latest*
 * version (package.json), not whatever stale `prjct` is on global PATH.
 */

import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

export const REPO_ROOT = path.resolve(__dirname, '../../..')
export const BIN = path.join(REPO_ROOT, 'bin', 'prjct.ts')

export interface CliResult {
  code: number
  stdout: string
  stderr: string
}

export interface Sandbox {
  /** tmp working dir — a real git repo on branch `main` */
  dir: string
  /** isolated PRJCT_CLI_HOME — where ALL prjct data must land */
  home: string
  /** the HOME env value (== home unless splitCliHome) — used to assert
   *  no prjct data leaked to `<HOME>/.prjct-cli` */
  osHome: string
  /** run the real CLI in this sandbox; never throws on non-zero exit */
  cli: (args: string[], opts?: { cwd?: string; timeoutMs?: number }) => Promise<CliResult>
  cleanup: () => Promise<void>
}

async function git(cwd: string, args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const p = spawn('git', args, { cwd, stdio: 'ignore' })
    p.on('error', reject)
    p.on('exit', (c) => (c === 0 ? resolve() : reject(new Error(`git ${args.join(' ')} → ${c}`))))
  })
}

/**
 * Spawn `bun bin/prjct.ts <args>` with an isolated environment. Resolves with
 * the exit code + captured streams (does NOT reject on non-zero — e2e asserts
 * on the code).
 */
function runCli(
  args: string[],
  env: NodeJS.ProcessEnv,
  cwd: string,
  timeoutMs = 60_000
): Promise<CliResult> {
  return new Promise((resolve) => {
    const child = spawn('bun', [BIN, ...args], {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const capture = { stdout: '', stderr: '', done: false }
    const finish = (code: number) => {
      if (capture.done) return
      capture.done = true
      clearTimeout(timer)
      resolve({ code, stdout: capture.stdout, stderr: capture.stderr })
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      capture.stderr += `\n[harness] timeout after ${timeoutMs}ms`
      finish(124)
    }, timeoutMs)
    child.stdout.on('data', (d) => {
      capture.stdout += d.toString()
    })
    child.stderr.on('data', (d) => {
      capture.stderr += d.toString()
    })
    child.on('error', (e) => {
      capture.stderr += `\n[harness] spawn error: ${e.message}`
      finish(127)
    })
    child.on('exit', (c) => finish(c ?? 0))
  })
}

export interface SandboxOpts {
  seedFiles?: boolean
  /**
   * Point PRJCT_CLI_HOME at a directory DISTINCT from HOME. Surfaces any
   * code that resolves prjct's data dir via os.homedir() instead of
   * pathManager (PRJCT_CLI_HOME) — when they coincide, that bug hides.
   */
  splitCliHome?: boolean
}

/** Create a fresh hermetic sandbox: tmp git repo + isolated CLI home. */
export async function makeSandbox(opts: SandboxOpts | boolean = true): Promise<Sandbox> {
  const { seedFiles = true, splitCliHome = false } =
    typeof opts === 'boolean' ? { seedFiles: opts } : opts
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'prjct-e2e-'))
  const dir = path.join(root, 'proj')
  const home = path.join(root, 'home')
  // When split, the prjct data dir lives somewhere HOME-independent.
  const cliHome = splitCliHome ? path.join(root, 'cli-home') : home
  await fs.mkdir(dir, { recursive: true })
  await fs.mkdir(home, { recursive: true })
  await fs.mkdir(cliHome, { recursive: true })

  await git(dir, ['init', '-q', '-b', 'main'])
  await git(dir, ['config', 'user.email', 'e2e@example.com'])
  await git(dir, ['config', 'user.name', 'E2E'])
  await git(dir, ['config', 'commit.gpgsign', 'false'])

  if (seedFiles) {
    await fs.writeFile(
      path.join(dir, 'package.json'),
      JSON.stringify({ name: 'fake-proj', version: '0.1.0', private: true }, null, 2)
    )
    await fs.writeFile(path.join(dir, 'README.md'), '# fake-proj\n')
    await git(dir, ['add', '.'])
    await git(dir, ['commit', '-q', '-m', 'init'])
  }

  const baseEnv: NodeJS.ProcessEnv = {
    ...process.env,
    PRJCT_CLI_HOME: cliHome,
    HOME: home,
    // keep prompts/daemons out of the way during e2e
    CI: '1',
    NO_COLOR: '1',
    PRJCT_NO_DAEMON: '1',
  }

  return {
    dir,
    home: cliHome,
    osHome: home,
    cli: (args, opts = {}) => runCli(args, baseEnv, opts.cwd ?? dir, opts.timeoutMs),
    cleanup: () => fs.rm(root, { recursive: true, force: true }).catch(() => {}),
  }
}
