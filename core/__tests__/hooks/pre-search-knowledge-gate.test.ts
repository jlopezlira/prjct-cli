import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { runPreSearchHook } from '../../hooks/pre-search'
import prjctDb from '../../storage/database'
import { patchPathManager, restorePathManager } from '../_setup/path-manager-mock'

/**
 * Knowledge-first behaviour. The DEFAULT is now `inject`: advisory text was
 * measured not to make the agent consult prjct, and a hard deny taxes the
 * obedient model — so the recorded judgment rides the Grep as context instead
 * of blocking it. The legacy `deny` mode is still available and still enforced.
 */

const fixture: { root: string; dir: string; projectId: string } = {
  root: '',
  dir: '',
  projectId: '',
}

beforeEach(async () => {
  fixture.root = await fs.mkdtemp(path.join(os.tmpdir(), 'prjct-knowledge-gate-'))
  fixture.dir = path.join(fixture.root, 'proj')
  await fs.mkdir(path.join(fixture.dir, '.prjct'), { recursive: true })
  fixture.projectId = `gate-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  await writeConfig({})
  patchPathManager(fixture.root)
  prjctDb.run(fixture.projectId, 'SELECT 1 WHERE 1=0')
})

afterEach(async () => {
  restorePathManager()
  await fs.rm(fixture.root, { recursive: true, force: true }).catch(() => undefined)
})

async function writeConfig(extra: Record<string, unknown>): Promise<void> {
  await fs.writeFile(
    path.join(fixture.dir, '.prjct', 'prjct.config.json'),
    JSON.stringify({ projectId: fixture.projectId, dataPath: fixture.root, ...extra })
  )
}

function remember(type: string, content: string): void {
  prjctDb.appendEvent(fixture.projectId, `memory.remember.${type}`, {
    content,
    tags: {},
    provenance: 'declared',
  })
}

async function grep(pattern: string, sessionId = 'session-1'): Promise<Record<string, unknown>> {
  const chunks: string[] = []
  await runPreSearchHook(fixture.dir, {
    input: { tool_name: 'Grep', tool_input: { pattern }, session_id: sessionId },
    sink: (chunk) => chunks.push(chunk),
    detachAfterEmit: (fn) => {
      void fn().catch(() => undefined)
    },
  })
  return JSON.parse(chunks.at(-1)?.trim() || '{}') as Record<string, unknown>
}

const hookOut = (out: Record<string, unknown>) =>
  out.hookSpecificOutput as
    | { permissionDecision?: string; permissionDecisionReason?: string; additionalContext?: string }
    | undefined

const denyReasonOf = (out: Record<string, unknown>): string | null => {
  const hook = hookOut(out)
  return hook?.permissionDecision === 'deny' ? (hook.permissionDecisionReason ?? '') : null
}

const injectOf = (out: Record<string, unknown>): string | null => {
  const hook = hookOut(out)
  return hook?.permissionDecision === 'deny' ? null : (hook?.additionalContext ?? null)
}

describe('knowledge-first — inject (default)', () => {
  it('injects the recorded judgment inline and never blocks the grep', async () => {
    remember('decision', 'The daemon socket path is fixed; never derive it per call.')
    remember('gotcha', 'A stale daemon serves old code — restart it before trusting output.')

    const out = await grep('daemon')
    expect(denyReasonOf(out)).toBeNull()
    const inject = injectOf(out)
    expect(inject).not.toBeNull()
    expect(inject).toContain('recorded judgment about `daemon`')
    expect(inject).toMatch(/stale daemon|socket path/i)
  })

  it('injects at most once per token per session', async () => {
    remember('decision', 'Retention runs in apply mode on every sync.')
    remember('gotcha', 'Retention idle penalty starts later for declared entries.')

    expect(injectOf(await grep('retention'))).not.toBeNull()
    expect(injectOf(await grep('retention'))).toBeNull()
  })

  it('stays silent when the project has no judgment about the token', async () => {
    remember('decision', 'Something entirely unrelated to the search term.')
    const out = await grep('unrelatedtoken')
    expect(denyReasonOf(out)).toBeNull()
    expect(injectOf(out)).toBeNull()
  })

  it('ignores non-judgment memory — telemetry never rides the grep', async () => {
    remember('context', 'daemon restarted at 12:00')
    remember('context', 'daemon restarted at 13:00')
    expect(injectOf(await grep('daemon'))).toBeNull()
  })
})

describe('knowledge-first — deny (opt-in)', () => {
  it('DENIES a grep whose token prjct has judgment about, and names the lookup', async () => {
    await writeConfig({ enforce: { knowledgeFirst: 'deny' } })
    remember('decision', 'The daemon socket path is fixed; never derive it per call.')
    remember('gotcha', 'A stale daemon serves old code — restart it before trusting output.')

    const reason = denyReasonOf(await grep('daemon'))
    expect(reason).not.toBeNull()
    expect(reason).toContain('prjct search "daemon"')
    expect(reason).toMatch(/not in any file|no grep/i)
  })

  it('never blocks the same token twice — the retry after the lookup must pass', async () => {
    await writeConfig({ enforce: { knowledgeFirst: 'deny' } })
    remember('decision', 'Retention runs in apply mode on every sync.')
    remember('gotcha', 'Retention idle penalty starts later for declared entries.')

    expect(denyReasonOf(await grep('retention'))).not.toBeNull()
    expect(denyReasonOf(await grep('retention'))).toBeNull()
  })
})

describe('knowledge-first — off', () => {
  it('is disableable with enforce.knowledgeFirst: false (no deny, no inject)', async () => {
    await writeConfig({ enforce: { knowledgeFirst: false } })
    remember('decision', 'The embeddings leg is a local hashing embedder.')
    remember('gotcha', 'Embeddings backfill only runs in the Stop hook.')
    const out = await grep('embeddings')
    expect(denyReasonOf(out)).toBeNull()
    expect(injectOf(out)).toBeNull()
  })
})
