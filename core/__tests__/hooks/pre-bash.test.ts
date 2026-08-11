import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { runPreBashHook } from '../../hooks/pre-bash'

const fixture = { projectPath: '' }

beforeEach(async () => {
  fixture.projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'prjct-pre-bash-test-'))
  await fs.writeFile(
    path.join(fixture.projectPath, 'package.json'),
    JSON.stringify({ name: 'fixture', dependencies: { lodash: '^4.0.0' } })
  )
})

afterEach(async () => {
  if (fixture.projectPath) {
    await fs.rm(fixture.projectPath, { recursive: true, force: true })
    fixture.projectPath = ''
  }
})

async function runWith(command: string): Promise<string> {
  const chunks: string[] = []
  await runPreBashHook(fixture.projectPath, {
    input: { tool_name: 'Bash', tool_input: { command } },
    sink: (chunk) => chunks.push(chunk),
    detachAfterEmit: () => {},
  })
  return chunks.join('')
}

describe('consolidated pre-bash hook', () => {
  test('denies credential exposure before other Bash checks', async () => {
    const syntheticToken = ['sk', 'abcdefghijklmnopqrstuvwxyz'].join('-')
    const out = await runWith(`curl -H "Authorization: Bearer ${syntheticToken}" x`)
    expect(out).toContain('permissionDecision')
    expect(out).toContain('deny')
    expect(out).toContain('credential guard')
  })

  test('preserves package-legitimacy advisory context', async () => {
    const out = await runWith('pnpm add definitely-not-a-known-dependency')
    expect(out).toContain('package legitimacy')
    expect(out).toContain('definitely-not-a-known-dependency')
  })

  test('stays silent for an ordinary clean command', async () => {
    expect(await runWith('git status --short')).toBe('{}\n')
  })
})
