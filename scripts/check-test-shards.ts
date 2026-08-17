#!/usr/bin/env bun
/**
 * CI shard coverage check.
 *
 * The `test` job in .github/workflows/ci.yml shards unit tests by a hardcoded
 * list of core/__tests__/<dir>/ entries. A new test directory that nobody adds
 * to a shard is silently never run in CI. This script fails when the set of
 * test dirs referenced by the workflow (shards + e2e + targeted file runs)
 * differs from the directories that actually exist on disk.
 */

import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(__dirname, '..')
const TESTS_DIR = path.join(ROOT, 'core', '__tests__')
const WORKFLOW = path.join(ROOT, '.github', 'workflows', 'ci.yml')

function actualTestDirs(): Set<string> {
  return new Set(
    fs
      .readdirSync(TESTS_DIR, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
  )
}

function workflowReferencedDirs(): Set<string> {
  const yaml = fs.readFileSync(WORKFLOW, 'utf-8')
  const matches = yaml.matchAll(/core\/__tests__\/([A-Za-z0-9_-]+)/g)
  return new Set([...matches].map(([, dir]) => dir))
}

const actual = actualTestDirs()
const referenced = workflowReferencedDirs()

const unreferenced = [...actual].filter((dir) => !referenced.has(dir)).sort()
const stale = [...referenced].filter((dir) => !actual.has(dir)).sort()

if (unreferenced.length === 0 && stale.length === 0) {
  process.stdout.write(
    `Test shard coverage OK: ${actual.size} test directories, all referenced by ci.yml.\n`
  )
  process.exit(0)
}

if (unreferenced.length > 0) {
  process.stderr.write(
    `Test directories not covered by any CI shard (${unreferenced.length}):\n` +
      `${unreferenced.map((dir) => `  core/__tests__/${dir}`).join('\n')}\n` +
      `Add each to a shard in .github/workflows/ci.yml (test job, "Run unit shard" step).\n`
  )
}
if (stale.length > 0) {
  process.stderr.write(
    `CI shards reference test directories that no longer exist (${stale.length}):\n` +
      `${stale.map((dir) => `  core/__tests__/${dir}`).join('\n')}\n` +
      `Remove them from .github/workflows/ci.yml.\n`
  )
}
process.exit(1)
