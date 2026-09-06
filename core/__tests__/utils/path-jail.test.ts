/**
 * Realpath jail (SEC-01 / SEC-02): a symlink that lives inside the project
 * and points outside it must be rejected by every surface that accepts a
 * caller-supplied path — signatures extraction, owned-agent paths, and the
 * MCP `projectPath` argument.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { PathDeniedError, resolveSafePath } from '../../agent/paths'
import { resolveProjectPath, serverProjectRoot } from '../../mcp/resolve'
import { extractSignatures } from '../../tools/context/signatures-tool'
import { isInsideProject, realpathOrNearest, resolveInsideProject } from '../../utils/path-jail'

const fixture = { root: '', outside: '', secret: '' }
const ORIGINAL_PROJECT_PATH = process.env.PRJCT_PROJECT_PATH
const ORIGINAL_CWD = process.env.PRJCT_CWD

beforeEach(async () => {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'prjct-path-jail-'))
  fixture.root = path.join(base, 'project')
  fixture.outside = path.join(base, 'outside')
  await fsp.mkdir(path.join(fixture.root, 'src'), { recursive: true })
  await fsp.mkdir(fixture.outside, { recursive: true })
  fixture.secret = path.join(fixture.outside, 'secret.ts')
  await fsp.writeFile(fixture.secret, 'export const leakedSecret = 1\n')
  await fsp.writeFile(path.join(fixture.root, 'src', 'ok.ts'), 'export function ok() {}\n')
  // In-tree symlinks: one to a file outside, one to a directory outside.
  fs.symlinkSync(fixture.secret, path.join(fixture.root, 'link.ts'))
  fs.symlinkSync(fixture.outside, path.join(fixture.root, 'linkdir'))
})

afterEach(async () => {
  await fsp.rm(path.dirname(fixture.root), { recursive: true, force: true }).catch(() => {})
  if (ORIGINAL_PROJECT_PATH === undefined) delete process.env.PRJCT_PROJECT_PATH
  else process.env.PRJCT_PROJECT_PATH = ORIGINAL_PROJECT_PATH
  if (ORIGINAL_CWD === undefined) delete process.env.PRJCT_CWD
  else process.env.PRJCT_CWD = ORIGINAL_CWD
})

describe('realpathOrNearest / resolveInsideProject', () => {
  it('canonicalises through the nearest existing ancestor', () => {
    const real = fs.realpathSync.native(fixture.root)
    expect(realpathOrNearest(path.join(fixture.root, 'src', 'new', 'file.ts'))).toBe(
      path.join(real, 'src', 'new', 'file.ts')
    )
    // A missing leaf under a symlinked parent resolves to the target tree.
    expect(realpathOrNearest(path.join(fixture.root, 'linkdir', 'new.ts'))).toBe(
      path.join(fs.realpathSync.native(fixture.outside), 'new.ts')
    )
  })

  it('accepts the root itself, in-tree files, and not-yet-created in-tree files', () => {
    const real = fs.realpathSync.native(fixture.root)
    expect(resolveInsideProject(fixture.root, fixture.root)).toBe(real)
    expect(resolveInsideProject(fixture.root, 'src/ok.ts')).toBe(path.join(real, 'src', 'ok.ts'))
    expect(isInsideProject(fixture.root, 'src/not-yet.ts')).toBe(true)
  })

  it('rejects in-tree symlinks that point outside, and sibling prefixes', () => {
    expect(resolveInsideProject(fixture.root, 'link.ts')).toBeNull()
    expect(resolveInsideProject(fixture.root, 'linkdir/secret.ts')).toBeNull()
    expect(resolveInsideProject(fixture.root, '../outside/secret.ts')).toBeNull()
    expect(isInsideProject(fixture.root, `${fixture.root}-evil/x.ts`)).toBe(false)
  })
})

describe('extractSignatures jail (SEC-01)', () => {
  it('reads an in-tree file but refuses a symlink to an outside file', async () => {
    const ok = await extractSignatures('src/ok.ts', fixture.root)
    expect(ok.fallback).toBe(false)
    expect(ok.signatures.map((s) => s.name)).toContain('ok')

    const escaped = await extractSignatures('link.ts', fixture.root)
    expect(escaped.fallback).toBe(true)
    expect(escaped.fallbackReason).toMatch(/outside project/i)
    expect(JSON.stringify(escaped)).not.toContain('leakedSecret')

    const viaDir = await extractSignatures(
      path.join(fixture.root, 'linkdir', 'secret.ts'),
      fixture.root
    )
    expect(viaDir.fallback).toBe(true)
    expect(JSON.stringify(viaDir)).not.toContain('leakedSecret')
  })
})

describe('resolveSafePath jail (SEC-01, owned agent)', () => {
  it('returns the canonical in-root path and throws on symlink escapes', () => {
    const real = fs.realpathSync.native(fixture.root)
    expect(resolveSafePath(fixture.root, 'src/ok.ts')).toBe(path.join(real, 'src', 'ok.ts'))
    expect(() => resolveSafePath(fixture.root, 'link.ts')).toThrow(PathDeniedError)
    expect(() => resolveSafePath(fixture.root, 'linkdir/secret.ts')).toThrow(/escapes project root/)
    expect(() => resolveSafePath(fixture.root, '../outside/secret.ts')).toThrow(PathDeniedError)
  })
})

describe('MCP resolveProjectPath jail (SEC-02)', () => {
  it('honours an explicit path only inside the server project root', () => {
    process.env.PRJCT_PROJECT_PATH = fixture.root
    delete process.env.PRJCT_CWD
    const real = fs.realpathSync.native(fixture.root)
    expect(serverProjectRoot()).toBe(fixture.root)
    expect(resolveProjectPath(undefined)).toBe(fixture.root)
    expect(resolveProjectPath('src')).toBe(path.join(real, 'src'))
    expect(resolveProjectPath(path.join(fixture.root, 'src'))).toBe(path.join(real, 'src'))
    // Confused deputy: /etc, a plain outside dir, and an in-tree symlink to
    // it are refused loudly rather than routed into the server's project.
    expect(() => resolveProjectPath('/etc')).toThrow(/outside this MCP server's project/)
    expect(() => resolveProjectPath(fixture.outside)).toThrow(/not an initialized prjct project/)
    expect(() => resolveProjectPath('linkdir')).toThrow(/outside this MCP server's project/)
  })

  it('still serves another initialized prjct project (multi-project install)', () => {
    process.env.PRJCT_PROJECT_PATH = fixture.root
    delete process.env.PRJCT_CWD
    fs.mkdirSync(path.join(fixture.outside, '.prjct'), { recursive: true })
    fs.writeFileSync(
      path.join(fixture.outside, '.prjct', 'prjct.config.json'),
      '{"projectId":"other"}\n'
    )
    expect(resolveProjectPath(fixture.outside)).toBe(fs.realpathSync.native(fixture.outside))
    // Reaching it through the in-tree symlink resolves to the same root.
    expect(resolveProjectPath('linkdir')).toBe(fs.realpathSync.native(fixture.outside))
  })
})
