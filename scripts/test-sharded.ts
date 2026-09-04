#!/usr/bin/env bun
/**
 * Local parallel unit-test shards.
 *
 * bun has no cross-file shard flag, so this spawns one `bun test` process per
 * directory group in parallel. The groups mirror the `test` job matrix in
 * .github/workflows/ci.yml (core-a / core-b / core-c) exactly — keep them in
 * sync. scripts/check-test-shards.ts remains the coverage guard: a new
 * core/__tests__/<dir>/ that nobody adds to ci.yml (and here) fails that check.
 */

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { runProc } from '../core/utils/exec'

const SHARD_TIMEOUT_MS = 240_000
const SHARD_MAX_BUFFER = 32 * 1024 * 1024

const SHARDS: ReadonlyArray<readonly [string, readonly string[]]> = [
  [
    'core-a',
    [
      'core/__tests__/domain',
      'core/__tests__/schemas',
      'core/__tests__/utils',
      'core/__tests__/hooks',
      'core/__tests__/packs',
      'core/__tests__/mcp',
      'core/__tests__/infrastructure',
      'core/__tests__/memory',
      'core/__tests__/tools',
      'core/__tests__/types',
      'core/__tests__/statusline',
      'core/__tests__/eval',
      'core/__tests__/performance',
    ],
  ],
  ['core-b', ['core/__tests__/services', 'core/__tests__/storage']],
  [
    'core-c',
    [
      'core/__tests__/commands',
      'core/__tests__/daemon',
      'core/__tests__/workflow-engine',
      'core/__tests__/workflow',
      'core/__tests__/sync',
      'core/__tests__/_setup',
    ],
  ],
]

interface ShardResult {
  readonly name: string
  readonly exitCode: number
  readonly output: string
}

const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'prjct-sharded-'))
const abortController = new AbortController()

function cleanup(): void {
  rmSync(tempRoot, { recursive: true, force: true })
}

function stop(signal: 'SIGINT' | 'SIGTERM'): void {
  // runProc aborts synchronously into its process-tree killer before exit.
  abortController.abort()
  cleanup()
  process.exit(signal === 'SIGINT' ? 130 : 143)
}

process.once('SIGINT', () => stop('SIGINT'))
process.once('SIGTERM', () => stop('SIGTERM'))

async function runShard(name: string, dirs: readonly string[]): Promise<ShardResult> {
  const shardTemp = path.join(tempRoot, name)
  mkdirSync(shardTemp, { recursive: true })
  const result = await runProc('bun', ['test', '--timeout', '20000', '--dots', ...dirs], {
    cwd: process.cwd(),
    env: { ...process.env, TMPDIR: shardTemp },
    timeoutMs: SHARD_TIMEOUT_MS,
    maxBuffer: SHARD_MAX_BUFFER,
    signal: abortController.signal,
  })
  if (result.ok) return { name, exitCode: 0, output: `${result.stdout}${result.stderr}` }
  if (result.kind === 'exit') {
    return { name, exitCode: result.code, output: `${result.stdout}${result.stderr}` }
  }
  if (result.kind === 'timeout') {
    return {
      name,
      exitCode: 124,
      output: `${result.stdout}${result.stderr}\nShard timed out after ${result.budgetMs}ms.`,
    }
  }
  if (result.kind === 'overflow') {
    return {
      name,
      exitCode: 125,
      output: `${result.stdout}${result.stderr}\nShard output exceeded ${result.maxBuffer} bytes.`,
    }
  }
  return { name, exitCode: 127, output: `Could not start shard: ${result.cause.message}\n` }
}

try {
  const startedAt = performance.now()
  const results = await Promise.all(SHARDS.map(([name, dirs]) => runShard(name, dirs)))
  const wallSeconds = ((performance.now() - startedAt) / 1000).toFixed(1)

  // Output stays readable: each shard's full output is printed as one block.
  for (const { name, output } of results) {
    process.stdout.write(`\n===== shard ${name} =====\n${output}`)
  }

  const failed = results.filter(({ exitCode }) => exitCode !== 0)
  for (const { name, exitCode } of results) {
    process.stdout.write(`shard ${name}: exit ${exitCode}\n`)
  }
  process.stdout.write(`sharded tests: wall ${wallSeconds}s\n`)

  if (failed.length > 0) {
    // Keep the actionable failure at the very end so gauntlet's bounded output
    // tail includes the test name/assertion instead of only the shard summary.
    for (const { name, output } of failed) {
      process.stderr.write(`\n===== failed shard ${name} (tail) =====\n${output.slice(-4_000)}`)
    }
    process.stderr.write(`Failed shards: ${failed.map(({ name }) => name).join(', ')}\n`)
    process.exitCode = 1
  }
} finally {
  cleanup()
}
