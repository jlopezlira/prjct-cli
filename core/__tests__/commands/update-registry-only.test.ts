/**
 * Upgrade must install ONLY the npm registry package — never monorepo/local.
 * Doctrine mem_9174: install from outside (registry), never link / local tree.
 */

import { describe, expect, it } from 'bun:test'
import os from 'node:os'
import {
  MANAGERS,
  registryInstallArgs,
  registryInstallCwd,
} from '../../commands/update/package-managers'

describe('upgrade installs from npm registry only', () => {
  it('registryInstallCwd is a neutral directory (never monorepo)', () => {
    const cwd = registryInstallCwd()
    expect(cwd).toBe(os.tmpdir())
    expect(cwd).not.toContain('prjct-cli')
  })

  it('registryInstallArgs pin exact prjct-cli@X.Y.Z for every manager', () => {
    const pin = 'prjct-cli@3.69.0'
    for (const pm of [MANAGERS.npm, MANAGERS.pnpm, MANAGERS.bun, MANAGERS.yarn]) {
      const args = registryInstallArgs(pm, pin)
      expect(args.some((a) => a === pin)).toBe(true)
      expect(args.some((a) => a === 'prjct-cli@latest')).toBe(false)
      // Never a path or bare package name without version pin when pin provided
      expect(args.some((a) => a === '.' || a.startsWith('/') || a.startsWith('file:'))).toBe(false)
    }
  })

  it('uses cache flags only when the selected package manager supports them', () => {
    expect(MANAGERS.npm.installArgs).toContain('--prefer-online')
    expect(MANAGERS.pnpm.installArgs).not.toContain('--prefer-online')
    expect(registryInstallArgs(MANAGERS.pnpm, 'prjct-cli@3.80.0')).toEqual([
      'add',
      '-g',
      'prjct-cli@3.80.0',
    ])
  })

  it('installArgs always name the registry package prjct-cli@…', () => {
    for (const pm of Object.values(MANAGERS)) {
      expect(pm.installArgs.some((a) => a.startsWith('prjct-cli@'))).toBe(true)
    }
  })
})
