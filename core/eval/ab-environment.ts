/**
 * Private A/B environments used by the live runner: isolate harness state,
 * remove answer-bearing artifacts, and record successful native hook calls.
 * Model execution and grading stay with the runner; no user config is installed.
 */
import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { PRJCT_HOOKS } from '../services/settings-installer'

type Environment = { worktree: string; home: string; arm: 'with' | 'without' }
const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`

export function abEnvironment(ctx: Environment): NodeJS.ProcessEnv {
  const env = { ...process.env }
  for (const key of [
    'PRJCT_PROJECT_PATH',
    'PRJCT_CWD',
    'PRJCT_SESSION_ID',
    'CLAUDE_SESSION_ID',
    'CODEX_SESSION_ID',
    'PI_SESSION_ID',
    'CLAUDECODE',
  ])
    delete env[key]
  return {
    ...env,
    PRJCT_CLI_HOME: ctx.home,
    PRJCT_PROJECTS_DIR: path.join(ctx.home, 'projects'),
    PRJCT_NO_DAEMON: '1',
    PRJCT_NO_SELF_SYNC: '1',
    PRJCT_DISABLE_CAPTURE: '1',
    PRJCT_HOOK_HOST: 'claude',
    PRJCT_AGENT_RUNTIME: 'claude',
  }
}

export async function prepareAbEnvironment(
  ctx: Environment,
  cli: string[]
): Promise<NodeJS.ProcessEnv> {
  await fs.mkdir(ctx.home, { recursive: true })
  // Neither arm may discover the corpus or previous scored answers via Grep/Read.
  await fs.rm(path.join(ctx.worktree, 'evals', 'ab'), { recursive: true, force: true })
  await fs.rm(path.join(ctx.worktree, '.prjct', 'evaluations'), { recursive: true, force: true })
  const hooks: Record<string, unknown[]> = {}
  if (ctx.arm === 'without') {
    await fs.rm(path.join(ctx.worktree, '.prjct'), { recursive: true, force: true })
  } else {
    const locator = path.join(ctx.worktree, '.prjct', 'prjct.config.json')
    const previous = await fs
      .readFile(locator, 'utf8')
      .then(JSON.parse)
      .catch(() => null)
    const projectId = typeof previous?.projectId === 'string' ? previous.projectId : randomUUID()
    const dataPath = path.join(ctx.home, 'projects', projectId)
    await fs.mkdir(dataPath, { recursive: true })
    await fs.mkdir(path.dirname(locator), { recursive: true })
    await fs.writeFile(locator, JSON.stringify({ projectId, dataPath }))
    const wrapper = path.join(ctx.home, 'hook.mjs')
    const observations = path.join(ctx.home, 'hooks-observed.jsonl')
    await fs.writeFile(observations, '')
    // Log after valid CLI output, not before a hook that might fail to launch.
    await fs.writeFile(
      wrapper,
      `import {execFileSync} from 'node:child_process';
import {readFileSync,appendFileSync} from 'node:fs';
const cli=${JSON.stringify(cli)};
const output=execFileSync(cli[0],[...cli.slice(1),'hook',process.argv[2]],{input:readFileSync(0),env:process.env,timeout:10000,encoding:'utf8'});
const result=JSON.parse(output);
if(!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('Invalid hook output');
appendFileSync(${JSON.stringify(observations)},JSON.stringify({hook:process.argv[2]})+'\\n');
process.stdout.write(output);
`
    )
    for (const spec of PRJCT_HOOKS) {
      // CwdChanged belongs to other hosts, not Claude's settings schema.
      if (spec.event === 'CwdChanged') continue
      const entries = hooks[spec.event] ?? []
      entries.push({
        matcher: spec.matcher,
        hooks: [
          {
            type: 'command',
            command: `${quote(process.execPath)} ${quote(wrapper)} ${quote(spec.subcommand)}`,
            timeout: 15,
          },
        ],
      })
      hooks[spec.event] = entries
    }
  }
  await fs.writeFile(path.join(ctx.home, 'claude-settings.json'), JSON.stringify({ hooks }))
  return abEnvironment(ctx)
}

export async function assertAbHarnessObserved(home: string): Promise<void> {
  const observed = await fs
    .readFile(path.join(home, 'hooks-observed.jsonl'), 'utf8')
    .catch(() => '')
  if (
    !observed.split('\n').some((line) => {
      try {
        return JSON.parse(line).hook === 'prompt'
      } catch {
        return false
      }
    })
  )
    throw new Error(
      'ab: with-arm prompt hook did not execute successfully; refusing uninstrumented results'
    )
}
