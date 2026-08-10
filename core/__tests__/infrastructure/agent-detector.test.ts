/**
 * Sandbox detection — `sandboxed` was historically hardcoded false; it now
 * derives from CODEX_SANDBOX / PRJCT_SANDBOX so write-error messaging and any
 * future degraded-mode branching can react to a restricted harness (Codex).
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { isSandboxed } from '../../infrastructure/agent-detector'

const fixture: {
  prevCodex: string | undefined
  prevPrjct: string | undefined
} = {
  prevCodex: undefined as unknown as string | undefined,
  prevPrjct: undefined as unknown as string | undefined,
}

beforeEach(() => {
  fixture.prevCodex = process.env.CODEX_SANDBOX
  fixture.prevPrjct = process.env.PRJCT_SANDBOX
  delete process.env.CODEX_SANDBOX
  delete process.env.PRJCT_SANDBOX
})

afterEach(() => {
  if (fixture.prevCodex === undefined) delete process.env.CODEX_SANDBOX
  else process.env.CODEX_SANDBOX = fixture.prevCodex
  if (fixture.prevPrjct === undefined) delete process.env.PRJCT_SANDBOX
  else process.env.PRJCT_SANDBOX = fixture.prevPrjct
})

describe('isSandboxed', () => {
  it('is false with no sandbox signal', () => {
    expect(isSandboxed()).toBe(false)
  })

  it('is true under CODEX_SANDBOX', () => {
    process.env.CODEX_SANDBOX = 'seatbelt'
    expect(isSandboxed()).toBe(true)
  })

  it('is true under PRJCT_SANDBOX=1', () => {
    process.env.PRJCT_SANDBOX = '1'
    expect(isSandboxed()).toBe(true)
  })
})
