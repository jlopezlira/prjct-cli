/**
 * E2E: per-command `--help` / `-h` interception (DX 2.3).
 *
 * `prjct search --help` used to die with "Missing required parameter:
 * query" — the flag sailed into the verb's option parser. The bin entry
 * now routes `<verb> --help` to the help system BEFORE the daemon fast
 * path and the setup gate, so help works for core verbs, bin-only verbs,
 * and on machines with no project/config at all.
 */

import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { makeSandbox, type Sandbox } from './_harness'

setDefaultTimeout(120_000)

describe('e2e: per-command --help', () => {
  const fixture: { sb: Sandbox } = { sb: undefined as unknown as Sandbox }
  beforeAll(async () => {
    fixture.sb = await makeSandbox()
  })
  afterAll(async () => {
    await fixture.sb.cleanup()
  })

  test('search --help prints command help instead of the missing-param error', async () => {
    const r = await fixture.sb.cli(['search', '--help'])

    expect(r.code).toBe(0)
    expect(r.stdout).toContain('search')
    expect(r.stdout).toContain('USAGE')
    expect(r.stderr).not.toContain('Missing required parameter')
  })

  test('search -h behaves like --help', async () => {
    const r = await fixture.sb.cli(['search', '-h'])

    expect(r.code).toBe(0)
    expect(r.stdout).toContain('USAGE')
  })

  test('context --help (bin-only verb) prints manifest help', async () => {
    const r = await fixture.sb.cli(['context', '--help'])

    expect(r.code).toBe(0)
    expect(r.stdout).toContain('prjct context')
  })

  test('daemon --help documents its subcommands and short flags', async () => {
    const r = await fixture.sb.cli(['daemon', '--help'])

    expect(r.code).toBe(0)
    expect(r.stdout).toContain('logs')
    expect(r.stdout).toContain('--follow|-f')
  })

  test('bare prjct help still prints the main help', async () => {
    const r = await fixture.sb.cli(['help'])

    expect(r.code).toBe(0)
    expect(r.stdout).toContain('TERMINAL COMMANDS')
    expect(r.stdout).toContain('prjct health')
    expect(r.stdout).toContain('prjct harness')
  })

  test('unknown verb still fails loud (help interception does not swallow it)', async () => {
    const r = await fixture.sb.cli(['wrok'])

    expect(r.code).toBe(1)
  })
})
