#!/usr/bin/env bun

import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(__dirname, '..')

// os.homedir() ignores a mutated process.env.HOME under Bun, so any production
// caller bypasses the test HOME sandbox and can overwrite the developer's real
// config (mem_19026). Production code must resolve the home through these two
// canonical modules, which honor the override.
const ALLOWLIST = new Set(['core/infrastructure/user-home.ts', 'core/infrastructure/cli-home.ts'])

function trackedProductionFiles(): string[] {
  const result = Bun.spawnSync(['git', 'ls-files', '-z'], { cwd: ROOT })
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.toString().trim() || 'git ls-files failed')
  }
  return result.stdout
    .toString()
    .split('\0')
    .filter(
      (file) =>
        file.length > 0 &&
        file.startsWith('core/') &&
        !file.startsWith('core/__tests__/') &&
        (file.endsWith('.ts') || file.endsWith('.js')) &&
        !ALLOWLIST.has(file)
    )
}

function stripComments(source: string): string {
  const noBlocks = source.replace(/\/\*[\s\S]*?\*\//g, '')
  return noBlocks
    .split('\n')
    .map((line) => {
      const idx = line.indexOf('//')
      return idx === -1 ? line : line.slice(0, idx)
    })
    .join('\n')
}

type Hit = { file: string; line: number }

function scan(file: string): Hit[] {
  const stripped = stripComments(fs.readFileSync(path.join(ROOT, file), 'utf-8'))
  const hits: Hit[] = []
  stripped.split('\n').forEach((line, i) => {
    if (/\bos\.homedir\s*\(\s*\)/.test(line) || /(?<![\w.])homedir\s*\(\s*\)/.test(line)) {
      hits.push({ file, line: i + 1 })
    }
  })
  return hits
}

const hits = trackedProductionFiles().flatMap(scan)
if (hits.length > 0) {
  const details = hits.map(({ file, line }) => `  ${file}:${line}`).join('\n')
  process.stderr.write(
    `Homedir check failed: ${hits.length} raw os.homedir() call(s) outside the canonical ` +
      `resolvers.\nUse resolveUserHome()/resolveUserPath() (honors the test HOME sandbox) ` +
      `instead.\n${details}\n`
  )
  process.exit(1)
}

process.stdout.write('Homedir check passed: no raw os.homedir() in production code.\n')
