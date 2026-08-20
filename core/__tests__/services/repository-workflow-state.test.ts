import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  _resetRepositoryWorkflowStateForTests,
  detectRepositoryWorkflowState,
} from '../../services/repository-workflow-state'

const fixture = { root: '' }

beforeEach(async () => {
  fixture.root = await fs.mkdtemp(path.join(os.tmpdir(), 'prjct-repo-workflow-'))
  _resetRepositoryWorkflowStateForTests()
})

afterEach(async () => {
  await fs.rm(fixture.root, { recursive: true, force: true })
})

describe('repository-workflow-state', () => {
  it('detects merge metadata in a normal git directory', async () => {
    await fs.mkdir(path.join(fixture.root, '.git'))
    expect(detectRepositoryWorkflowState(fixture.root).hasMergeConflicts).toBe(false)
    await fs.writeFile(path.join(fixture.root, '.git', 'MERGE_HEAD'), 'abc123\n')
    _resetRepositoryWorkflowStateForTests()
    expect(detectRepositoryWorkflowState(fixture.root).hasMergeConflicts).toBe(true)
  })

  it('resolves worktree gitdir pointers and rebase state', async () => {
    const gitDir = path.join(fixture.root, 'git-meta', 'worktrees', 'feature')
    const worktree = path.join(fixture.root, 'checkout')
    await fs.mkdir(path.join(gitDir, 'rebase-merge'), { recursive: true })
    await fs.mkdir(worktree)
    await fs.writeFile(path.join(worktree, '.git'), `gitdir: ${gitDir}\n`)
    expect(detectRepositoryWorkflowState(worktree).hasMergeConflicts).toBe(true)
  })

  it('fails soft outside a git worktree', () => {
    expect(detectRepositoryWorkflowState(fixture.root)).toEqual({ hasMergeConflicts: false })
  })
})
