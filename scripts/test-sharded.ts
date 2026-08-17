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

async function runShard(name: string, dirs: readonly string[]): Promise<ShardResult> {
  const proc = Bun.spawn(['bun', 'test', '--dots', ...dirs], {
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { name, exitCode, output: `${stdout}${stderr}` }
}

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
  process.stderr.write(`Failed shards: ${failed.map(({ name }) => name).join(', ')}\n`)
  process.exit(1)
}
