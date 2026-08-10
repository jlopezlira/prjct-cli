/**
 * prjct plan ceremony — draft → write → approve host contract
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { CeremonyCommands } from '../../commands/ceremonies'

const fixture: {
  dir: string
} = {
  dir: '',
}
const cmd = new CeremonyCommands()

beforeEach(async () => {
  fixture.dir = await fs.mkdtemp(path.join(os.tmpdir(), 'prjct-plan-ceremony-'))
  await fs.mkdir(path.join(fixture.dir, '.prjct'), { recursive: true })
  await fs.writeFile(
    path.join(fixture.dir, '.prjct/prjct.config.json'),
    JSON.stringify({ projectId: `plan-ceremony-${Date.now()}` })
  )
})

afterEach(async () => {
  await fs.rm(fixture.dir, { recursive: true, force: true }).catch(() => {})
})

describe('prjct plan ceremony', () => {
  it('starts draft, writes body, approves', async () => {
    const started = await cmd.plan('Add rate limiting', fixture.dir, { md: true })
    expect(started.success).toBe(true)
    expect(started.status).toBe('draft')

    const written = await cmd.plan(
      'write "# Plan: rate limit\n\n## Context\n\nAPI abuse.\n"',
      fixture.dir,
      { md: true }
    )
    expect(written.success).toBe(true)
    expect(written.written).toBe(true)

    const approved = await cmd.plan('approve', fixture.dir, { md: true })
    expect(approved.success).toBe(true)
    expect(approved.status).toBe('approved')
  })

  it('show fails when no plan', async () => {
    const r = await cmd.plan('show', fixture.dir, { md: true })
    expect(r.success).toBe(false)
  })
})
