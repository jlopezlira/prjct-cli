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

  test('denies broad killall and pkill -f termination commands', async () => {
    for (const command of [
      'killall node',
      'sudo killall vite',
      'pkill -f "vite --host"',
      'MODE=test /usr/bin/killall node',
      'env -i MODE=test killall node',
      '/usr/bin/env -i MODE=test /usr/bin/killall node',
      'sudo -u root killall node',
      'command -- killall node',
      'echo ready & pkill --full vite',
      "sh -c 'killall node'",
      "bash -lc 'pkill -f vite'",
      'printf node | xargs killall',
      'pkill node',
      'KILLALL node',
      'pgrep -f vite | xargs kill',
      'sudo -Eu root killall node',
    ]) {
      const out = await runWith(command)
      expect(out).toContain('permissionDecision')
      expect(out).toContain('deny')
      expect(out).toContain('broad process termination')
    }
  })

  test('allows explicit numeric PID termination', async () => {
    expect(await runWith('kill 12345')).toBe('{}\n')
    expect(await runWith('kill -TERM 12345')).toBe('{}\n')
    expect(await runWith('kill -15 12345')).toBe('{}\n')
  })

  test('does not treat quoted command names as executable syntax', async () => {
    expect(await runWith("printf '%s' 'pkill -f vite'")).toBe('{}\n')
    expect(await runWith('echo killall node')).toBe('{}\n')
  })

  test('still catches broad termination when a host sends tool_input.command_line instead of .command', async () => {
    // Regression: extractCommand() previously had no command_line fallback
    // (unlike pre-package.ts's), so a host using this field silently
    // bypassed the gate entirely — the extracted command was always ''.
    const chunks: string[] = []
    await runPreBashHook(fixture.projectPath, {
      input: { tool_name: 'Bash', tool_input: { command_line: 'killall node' } },
      sink: (chunk) => chunks.push(chunk),
      detachAfterEmit: () => {},
    })
    const out = chunks.join('')
    expect(out).toContain('permissionDecision')
    expect(out).toContain('deny')
    expect(out).toContain('broad process termination')
  })
})
