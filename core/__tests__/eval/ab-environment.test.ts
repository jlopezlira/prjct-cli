import { describe, expect, it } from 'bun:test'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { assertAbHarnessObserved, prepareAbEnvironment } from '../../eval/ab-environment'

describe('A/B isolated environment', () => {
  it('hides answer keys in both arms and requires actual successful hook execution', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ab-env-'))
    try {
      const cli = path.join(root, 'fake-cli.mjs')
      await fs.writeFile(
        cli,
        'process.stdin.resume(); process.stdin.on("end",()=>console.log("{}"))'
      )
      for (const arm of ['with', 'without'] as const) {
        const worktree = path.join(root, arm)
        const home = path.join(root, `${arm}-home`)
        await fs.mkdir(path.join(worktree, 'evals', 'ab', 'tasks'), { recursive: true })
        await fs.writeFile(
          path.join(worktree, 'evals', 'ab', 'tasks', 'answer.json'),
          '{"gold":"secret answer"}'
        )
        const env = await prepareAbEnvironment({ worktree, home, arm }, [process.execPath, cli])
        expect(await fs.stat(path.join(worktree, 'evals', 'ab')).catch(() => null)).toBeNull()
        const settings = JSON.parse(
          await fs.readFile(path.join(home, 'claude-settings.json'), 'utf8')
        )
        if (arm === 'without') {
          expect(settings.hooks).toEqual({})
          expect(await fs.stat(path.join(worktree, '.prjct')).catch(() => null)).toBeNull()
        } else {
          await expect(assertAbHarnessObserved(home)).rejects.toThrow('did not execute')
          const hook = settings.hooks.UserPromptSubmit[0].hooks[0].command
          execFileSync('sh', ['-c', hook], { cwd: worktree, env, input: '{}' })
          await assertAbHarnessObserved(home)
          expect(
            JSON.parse(
              await fs.readFile(path.join(worktree, '.prjct', 'prjct.config.json'), 'utf8')
            ).dataPath
          ).toContain(home)
        }
        expect(env.PRJCT_NO_SELF_SYNC).toBe('1')
        expect(env.PRJCT_PROJECTS_DIR).toBe(path.join(home, 'projects'))
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })
})
