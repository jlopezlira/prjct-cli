import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { runPreSearchHook } from '../../hooks/pre-search'
import prjctDb from '../../storage/database'
import { patchPathManager, restorePathManager } from '../_setup/path-manager-mock'

/**
 * The enforcement this exists to prove: advisory text did not make the agent
 * consult prjct (measured — it grepped instead), so the gate must actually
 * block. These assert the deny fires on real stored judgment, that it never
 * repeats for the same token, and that it fails open everywhere else.
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
  await fs.writeFile(
    path.join(fixture.dir, '.prjct', 'prjct.config.json'),
    JSON.stringify({ projectId: fixture.projectId, dataPath: fixture.root })
  )
  patchPathManager(fixture.root)
  prjctDb.run(fixture.projectId, 'SELECT 1 WHERE 1=0')
})

afterEach(async () => {
  restorePathManager()
  await fs.rm(fixture.root, { recursive: true, force: true }).catch(() => undefined)
})

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

const denyReasonOf = (out: Record<string, unknown>): string | null => {
  const hook = out.hookSpecificOutput as
    | { permissionDecision?: string; permissionDecisionReason?: string }
    | undefined
  return hook?.permissionDecision === 'deny' ? (hook.permissionDecisionReason ?? '') : null
}

describe('knowledge-first gate', () => {
  it('DENIES a grep whose token prjct already has judgment about, and names the lookup', async () => {
    remember('decision', 'The daemon socket path is fixed; never derive it per call.')
    remember('gotcha', 'A stale daemon serves old code — restart it before trusting output.')

    const reason = denyReasonOf(await grep('daemon'))

    expect(reason).not.toBeNull()
    expect(reason).toContain('prjct search "daemon"')
    // It must justify the block with what grep cannot reach, not scold.
    expect(reason).toMatch(/not in any file|no grep/i)
  })

  it('never blocks the same token twice — the retry after the lookup must pass', async () => {
    remember('decision', 'Retention runs in apply mode on every sync.')
    remember('gotcha', 'Retention idle penalty starts later for declared entries.')

    expect(denyReasonOf(await grep('retention'))).not.toBeNull()
    expect(denyReasonOf(await grep('retention'))).toBeNull()
  })

  it('stays silent when the project has no judgment about the token', async () => {
    remember('decision', 'Something entirely unrelated to the search term.')
    expect(denyReasonOf(await grep('unrelatedtoken'))).toBeNull()
  })

  it('ignores non-judgment memory — telemetry must never block a tool call', async () => {
    remember('context', 'daemon restarted at 12:00')
    remember('context', 'daemon restarted at 13:00')
    expect(denyReasonOf(await grep('daemon'))).toBeNull()
  })

  it('is disableable with enforce.knowledgeFirst: false', async () => {
    remember('decision', 'The embeddings leg is a local hashing embedder.')
    remember('gotcha', 'Embeddings backfill only runs in the Stop hook.')
    await fs.writeFile(
      path.join(fixture.dir, '.prjct', 'prjct.config.json'),
      JSON.stringify({
        projectId: fixture.projectId,
        dataPath: fixture.root,
        enforce: { knowledgeFirst: false },
      })
    )
    expect(denyReasonOf(await grep('embeddings'))).toBeNull()
  })
})
