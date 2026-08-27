#!/usr/bin/env bun

import fs from 'node:fs'
import path from 'node:path'
import {
  findMutableDeclarations,
  isJavaScriptOrTypeScript,
  type MutableDeclaration,
} from '../core/services/const-only-source'

const ROOT = path.resolve(__dirname, '..')

function repositorySourceFiles(): string[] {
  const result = Bun.spawnSync(
    ['git', 'ls-files', '-z', '--cached', '--others', '--exclude-standard'],
    { cwd: ROOT }
  )
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.toString().trim() || 'git ls-files failed')
  }

  return result.stdout
    .toString()
    .split('\0')
    .filter((file) => file.length > 0 && isJavaScriptOrTypeScript(file))
}

function scanRepository(): MutableDeclaration[] {
  return repositorySourceFiles().flatMap((file) =>
    findMutableDeclarations(file, fs.readFileSync(path.join(ROOT, file), 'utf-8'))
  )
}

const declarations = scanRepository()
if (declarations.length > 0) {
  const details = declarations
    .map(({ file, line, column, keyword }) => `  ${file}:${line}:${column} — ${keyword}`)
    .join('\n')
  process.stderr.write(
    `Const-only check failed: ${declarations.length} mutable declaration(s).\n${details}\n`
  )
  process.exit(1)
}

process.stdout.write('Const-only check passed: zero let/var declarations.\n')
