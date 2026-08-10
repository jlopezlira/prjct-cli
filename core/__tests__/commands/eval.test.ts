import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { COMMANDS } from '../../commands/command-data'
import { EvalCommands } from '../../commands/eval'
import { REGISTERED_VERBS_SET } from '../../commands/verb-names'
import { execFileAsync } from '../../utils/exec'

const fixture: {
  tmpRoot: string
  projectPath: string
  originalCliHome: string | undefined
  spies: Array<ReturnType<typeof spyOn>>
} = {
  tmpRoot: '',
  projectPath: '',
  originalCliHome: undefined as unknown as string | undefined,
  spies: [],
}

async function writeFile(relativePath: string, content: string): Promise<void> {
  const filePath = path.join(fixture.projectPath, relativePath)
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.writeFile(filePath, content, 'utf-8')
}

beforeEach(async () => {
  fixture.tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'prjct-eval-command-'))
  fixture.projectPath = path.join(fixture.tmpRoot, 'repo')
  await fs.mkdir(fixture.projectPath, { recursive: true })
  fixture.originalCliHome = process.env.PRJCT_CLI_HOME
  process.env.PRJCT_CLI_HOME = path.join(fixture.tmpRoot, 'home')
  fixture.spies.push(spyOn(console, 'log').mockImplementation(() => {}))
  fixture.spies.push(spyOn(console, 'error').mockImplementation(() => {}))
  await execFileAsync('git', ['init'], { cwd: fixture.projectPath })
  await execFileAsync('git', ['config', 'user.email', 'eval-command@example.com'], {
    cwd: fixture.projectPath,
  })
  await execFileAsync('git', ['config', 'user.name', 'Eval Command'], { cwd: fixture.projectPath })
  await execFileAsync('git', ['remote', 'add', 'origin', 'git@github.com:acme/prjct-evals.git'], {
    cwd: fixture.projectPath,
  })
  await writeFile('AGENTS.md', '# Agent contract\n')
  await writeFile('.prjct/prjct.config.json', '{"projectId":"eval-command"}\n')
  await writeFile(
    'package.json',
    JSON.stringify(
      { name: 'eval-command', scripts: { test: 'bun test', lint: 'biome check .' } },
      null,
      2
    )
  )
})

afterEach(async () => {
  for (const spy of fixture.spies) spy.mockRestore()
  fixture.spies = []
  if (fixture.originalCliHome === undefined) delete process.env.PRJCT_CLI_HOME
  else process.env.PRJCT_CLI_HOME = fixture.originalCliHome
  await fs.rm(fixture.tmpRoot, { recursive: true, force: true }).catch(() => undefined)
})

describe('prjct eval command', () => {
  test('is registered through the manifest with daemon-safe option mapping', () => {
    const meta = COMMANDS.find((command) => command.name === 'eval')

    expect(meta?.routing).toEqual({ group: 'eval', method: 'eval' })
    expect(meta?.optionSchema).toEqual({
      booleans: ['publish', 'dryRun', 'json'],
      strings: ['baseline', 'candidate', 'source', 'target', 'file'],
    })
    expect(REGISTERED_VERBS_SET.has('eval')).toBe(true)
  })

  test('can run before provider setup so CI and external repos can publish metrics', async () => {
    const binSource = await fs.readFile(path.join(process.cwd(), 'bin', 'prjct.ts'), 'utf-8')
    const launcherSource = await fs.readFile(path.join(process.cwd(), 'bin', 'prjct.cjs'), 'utf-8')

    expect(binSource).toContain("'eval'")
    expect(launcherSource).toContain("'eval'")
  })

  test('runs, reports, and compares through the command surface', async () => {
    const cmd = new EvalCommands()

    const run = await cmd.eval('run', fixture.projectPath, { candidate: 'command-a', md: true })
    const report = await cmd.eval('report', fixture.projectPath, { json: true })
    const compare = await cmd.eval('compare', fixture.projectPath, { candidate: 'command-a' })

    expect(run.success).toBe(true)
    expect(run.runId).toBeString()
    expect(report.success).toBe(true)
    expect(compare.success).toBe(true)
  })

  test('compare --publish publishes comparison artifacts in dry-run mode', async () => {
    const cmd = new EvalCommands()

    await cmd.eval('run', fixture.projectPath, { candidate: 'baseline-command' })
    await cmd.eval('run', fixture.projectPath, { candidate: 'candidate-command' })
    const result = await cmd.eval('compare', fixture.projectPath, {
      baseline: 'baseline-command',
      candidate: 'candidate-command',
      publish: true,
      dryRun: true,
      target: 'cloud',
    })

    expect(result.success).toBe(true)
    expect(result.comparisonId).toBeString()
    expect(result.publish).toMatchObject({ artifactType: 'comparison', dryRun: true })
  })

  test('documents cloud publishing and ships no GitHub eval workflow', async () => {
    const docs = await fs.readFile(path.join(process.cwd(), 'EVALS.md'), 'utf-8')
    const workflowPath = path.join(process.cwd(), '.github', 'workflows', 'prjct-evals.yml')

    expect(docs).toContain('POST <apiUrl>/benchmarks/evals')
    expect(docs).toContain('prjct cloud link')
    await expect(fs.access(workflowPath)).rejects.toThrow()
  })

  test('publish subcommand supports dry-run cloud output', async () => {
    const cmd = new EvalCommands()

    await cmd.eval('run', fixture.projectPath, { candidate: 'command-publish' })
    const published = await cmd.eval('publish', fixture.projectPath, {
      dryRun: true,
      target: 'cloud',
    })

    expect(published.success).toBe(true)
    expect(published.dryRun).toBe(true)
    expect(published.target).toBe('cloud')
    expect(published.projectId).toBe('eval-command')
    expect(published.endpoint).toBe('https://api.prjct.app/benchmarks/evals')
  })
})
