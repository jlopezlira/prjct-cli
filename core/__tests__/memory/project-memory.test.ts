/**
 * Project memory recall — latest-winner dedupe by (type, tags.key).
 *
 * Inspired by gstack's gstack-learnings-search "latest winner per
 * key+type" pattern. When the same key is asserted multiple times,
 * recall returns only the newest version. Entries without a key are
 * unaffected so the open-ended "remember any thought" use case still
 * accumulates.
 */

import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import pathManager from '../../infrastructure/path-manager'
import type { MemoryEntry } from '../../memory/entries'
import { deriveTitle, formatMemoryMd, linkifyMemRefs } from '../../memory/format'
import { projectMemory } from '../../memory/project-memory'
import prjctDb from '../../storage/database'

/**
 * Write a memory entry directly via the SQLite layer, bypassing the
 * configManager.getProjectId() round-trip (which requires a fully
 * initialized .prjct/ directory). Mirrors the schema written by
 * memoryService.log: events.type = `memory.remember.<type>`, data is
 * the JSON payload.
 */
async function writeMemoryEntry(args: {
  type: string
  content: string
  tags?: Record<string, string>
}): Promise<void> {
  prjctDb.appendEvent(fixture.projectId, `memory.remember.${args.type}`, {
    content: args.content,
    tags: args.tags ?? {},
    provenance: 'declared',
  })
}

const fixture: {
  tmpRoot: string
  projectId: string
} = {
  tmpRoot: '',
  projectId: '',
}

const originalGetGlobalProjectPath = pathManager.getGlobalProjectPath.bind(pathManager)
const originalGetStoragePath = pathManager.getStoragePath.bind(pathManager)
const originalGetFilePath = pathManager.getFilePath.bind(pathManager)

beforeEach(async () => {
  fixture.tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'prjct-memory-test-'))
  fixture.projectId = `test-mem-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

  pathManager.getGlobalProjectPath = (id: string) => path.join(fixture.tmpRoot, id)
  pathManager.getStoragePath = (id: string, filename: string) =>
    path.join(fixture.tmpRoot, id, 'storage', filename)
  pathManager.getFilePath = (id: string, layer: string, filename: string) =>
    path.join(fixture.tmpRoot, id, layer, filename)
})

afterEach(async () => {
  pathManager.getGlobalProjectPath = originalGetGlobalProjectPath
  pathManager.getStoragePath = originalGetStoragePath
  pathManager.getFilePath = originalGetFilePath
  await fs.rm(fixture.tmpRoot, { recursive: true, force: true }).catch(() => {})
})

describe('projectMemory.recall — dedupeByKey', () => {
  it('returns all entries when none have a key tag', async () => {
    await writeMemoryEntry({
      type: 'decision',
      content: 'use Bun runtime',
      tags: {},
    })
    await writeMemoryEntry({
      type: 'decision',
      content: 'use SQLite WAL mode',
      tags: {},
    })

    const entries = projectMemory.recall(fixture.projectId, { types: ['decision'] })
    expect(entries.length).toBe(2)
  })

  it('keeps only the newest entry per (type, key) when keys collide', async () => {
    await writeMemoryEntry({
      type: 'decision',
      content: 'first version: use npm',
      tags: { key: 'package-manager' },
    })
    // Force a later timestamp by waiting >1ms (events.timestamp has ms precision).
    await new Promise((r) => setTimeout(r, 5))
    await writeMemoryEntry({
      type: 'decision',
      content: 'updated: use bun',
      tags: { key: 'package-manager' },
    })

    const entries = projectMemory.recall(fixture.projectId, { types: ['decision'] })
    expect(entries.length).toBe(1)
    expect(entries[0].content).toBe('updated: use bun')
  })

  it('does not collapse same key across different types', async () => {
    await writeMemoryEntry({
      type: 'decision',
      content: 'decided to retry',
      tags: { key: 'retry-strategy' },
    })
    await writeMemoryEntry({
      type: 'gotcha',
      content: 'retry can deadlock',
      tags: { key: 'retry-strategy' },
    })

    const entries = projectMemory.recall(fixture.projectId, { types: ['decision', 'gotcha'] })
    expect(entries.length).toBe(2)
  })

  it('preserves entries without keys alongside deduped keyed ones', async () => {
    await writeMemoryEntry({
      type: 'learning',
      content: 'no-key learning A',
      tags: {},
    })
    await writeMemoryEntry({
      type: 'learning',
      content: 'old version',
      tags: { key: 'core-insight' },
    })
    await new Promise((r) => setTimeout(r, 5))
    await writeMemoryEntry({
      type: 'learning',
      content: 'new version',
      tags: { key: 'core-insight' },
    })
    await writeMemoryEntry({
      type: 'learning',
      content: 'no-key learning B',
      tags: {},
    })

    const entries = projectMemory.recall(fixture.projectId, { types: ['learning'] })
    expect(entries.length).toBe(3)
    const contents = entries.map((e) => e.content).sort()
    expect(contents).toContain('no-key learning A')
    expect(contents).toContain('no-key learning B')
    expect(contents).toContain('new version')
    expect(contents).not.toContain('old version')
  })

  it('returns full history when dedupeByKey is explicitly disabled', async () => {
    await writeMemoryEntry({
      type: 'decision',
      content: 'v1',
      tags: { key: 'router' },
    })
    await new Promise((r) => setTimeout(r, 5))
    await writeMemoryEntry({
      type: 'decision',
      content: 'v2',
      tags: { key: 'router' },
    })

    const entries = projectMemory.recall(fixture.projectId, {
      types: ['decision'],
      dedupeByKey: false,
    })
    expect(entries.length).toBe(2)
    expect(entries[0].content).toBe('v2')
    expect(entries[1].content).toBe('v1')
  })
})

describe('projectMemory.getById — resolve an opaque mem_N reference', () => {
  it('resolves a mem_<id> (and bare numeric) to the full entry', async () => {
    await writeMemoryEntry({
      type: 'decision',
      content: 'pick Bun over Node',
      tags: { topic: 'rt' },
    })
    const [e] = projectMemory.recall(fixture.projectId, { types: ['decision'] })
    expect(e.id).toMatch(/^mem_\d+$/)

    const byMem = projectMemory.getById(fixture.projectId, e.id)
    expect(byMem).not.toBeNull()
    expect(byMem?.content).toBe('pick Bun over Node')
    expect(byMem?.type).toBe('decision')
    expect(byMem?.tags).toEqual({ topic: 'rt' })

    // Bare numeric and mem- variants resolve the same row.
    const bare = projectMemory.getById(fixture.projectId, e.id.replace('mem_', ''))
    expect(bare?.id).toBe(e.id)
    expect(projectMemory.getById(fixture.projectId, e.id.replace('_', '-'))?.id).toBe(e.id)
  })

  it('returns null for a non-existent / malformed id (no throw)', () => {
    expect(projectMemory.getById(fixture.projectId, 'mem_999999')).toBeNull()
    expect(projectMemory.getById(fixture.projectId, 'not-an-id')).toBeNull()
    expect(projectMemory.getById(fixture.projectId, '')).toBeNull()
  })
})

describe('formatMemoryMd — vault makes every mem_N navigable (mem_3233)', () => {
  const mk = (over: Partial<MemoryEntry> & { id: string }): MemoryEntry => ({
    type: 'decision',
    content: '',
    tags: {},
    rememberedAt: '2026-05-18T00:00:00.000Z',
    provenance: 'declared',
    ...over,
  })

  it('CLI mode (no opts) is plain — no anchor, no wikilink', () => {
    const out = formatMemoryMd([
      mk({ id: 'mem_3247', content: 'fixed via resolves=mem_3135', tags: { pr: '355' } }),
    ])
    expect(out).toContain('[mem_3247 · decision]')
    expect(out).not.toContain('^mem-3247') // no Obsidian block anchor in terminal
    expect(out).not.toContain('[[') // no wikilink in terminal
    expect(out).toContain('resolves=mem_3135') // stays plain text for grep
  })

  it('vault mode: every entry gets a ^mem-N block anchor', () => {
    const out = formatMemoryMd([mk({ id: 'mem_3247', content: 'x' })], { vault: true })
    // Anchor must be the LAST token on the bullet (Obsidian block-ref rule).
    const line = out.split('\n').find((l) => l.includes('mem_3247'))
    expect(line?.endsWith(' ^mem-3247')).toBe(true)
  })

  it('vault mode: cross-ref with KNOWN type → typed wikilink to its file', () => {
    const idTypeIndex = new Map([['mem_3135', 'gotcha']])
    const out = formatMemoryMd(
      [mk({ id: 'mem_3247', content: 'done', tags: { resolves: 'mem_3135' } })],
      { vault: true, idTypeIndex }
    )
    expect(out).toContain('resolves=[[gotcha#^mem-3135|mem_3135]]')
  })

  it('vault mode: UNKNOWN id → muted code, not a fake dangling node', () => {
    // Supersedes the old mem_3233 "bare [[mem_N]] clickable" rule: at
    // graph scale that produced the orphan-dot dust the user reported.
    // A deleted id is not knowledge — render it as honest muted text.
    const out = formatMemoryMd([mk({ id: 'mem_3247', content: 'see mem_999 for context' })], {
      vault: true,
      idTypeIndex: new Map(),
    })
    expect(out).toContain('see `mem_999` for context')
    expect(out).not.toContain('[[mem_999]]')
  })

  it('vault mode: inline content mentions are linkified too, not just the meta tail', () => {
    const idTypeIndex = new Map([['mem_2895', 'feedback']])
    const out = formatMemoryMd([mk({ id: 'mem_3247', content: 'supersedes mem_2895 entirely' })], {
      vault: true,
      idTypeIndex,
    })
    expect(out).toContain('supersedes [[feedback#^mem-2895|mem_2895]] entirely')
  })

  it('regression lock: vault syntax never leaks into the CLI/terminal path', () => {
    const entries = [mk({ id: 'mem_3247', content: 'refs mem_1', tags: { relates: 'mem_2' } })]
    const cli = formatMemoryMd(entries)
    expect(cli).not.toMatch(/\^mem-|\[\[/)
  })

  describe('boundary:"llm" — data/instruction boundary for hook + MCP output', () => {
    it('wraps each entry in <user_content> tags carrying id + type', () => {
      const out = formatMemoryMd(
        [mk({ id: 'mem_42', type: 'learning', content: 'memoize the regex pool' })],
        { boundary: 'llm' }
      )
      expect(out).toContain('<user_content id="mem_42" type="learning">')
      expect(out).toContain('</user_content>')
      // The actual row stays between the tags
      const between = out.slice(
        out.indexOf('<user_content'),
        out.indexOf('</user_content>') + '</user_content>'.length
      )
      expect(between).toContain('memoize the regex pool')
    })

    it('escapes markdown control chars in tag values so attackers cannot inject wikilinks', () => {
      const out = formatMemoryMd(
        [
          mk({
            id: 'mem_99',
            content: 'innocent body',
            tags: { resolves: '[[../escape]]', label: '`code`' },
          }),
        ],
        { boundary: 'llm' }
      )
      // The raw `[[` and `` ` `` from tag values must NOT survive into output.
      // (Backslash-escaped forms are fine — they render as literal characters.)
      expect(out).not.toMatch(/(?:^|[^\\])\[\[\.\.\/escape\]\]/)
      expect(out).not.toMatch(/(?:^|[^\\])`code`/)
      // Escaped forms must be present
      expect(out).toContain('\\[\\[')
      expect(out).toContain('\\`code\\`')
    })

    it('does NOT wrap when boundary is omitted (CLI/vault paths stay byte-stable)', () => {
      const entry = mk({ id: 'mem_1', content: 'plain' })
      expect(formatMemoryMd([entry])).not.toContain('<user_content')
      expect(formatMemoryMd([entry], { vault: true })).not.toContain('<user_content')
    })
  })
})

describe('deriveTitle — deterministic, legible, no DB keys', () => {
  const mk = (over: Partial<MemoryEntry> & { id: string }): MemoryEntry => ({
    type: 'decision',
    content: '',
    tags: {},
    rememberedAt: '2026-05-17T00:00:00.000Z',
    provenance: 'declared',
    ...over,
  })

  it('cuts at the first strong clause boundary', () => {
    const t = deriveTitle(
      mk({ id: 'mem_3247', content: 'Triage-before-spec enforced in skill body: root cause was…' })
    )
    expect(t).toBe('Triage-before-spec enforced in skill body')
  })

  it('strips a leading mem ref / wikilink so the title starts on the statement', () => {
    const t = deriveTitle(
      mk({
        id: 'mem_3264',
        content: '[[feedback#^mem-3233|mem_3233]] opaque pointers FIXED. detail',
      })
    )
    expect(t).toBe('opaque pointers FIXED')
  })

  it('appends (PR #N) from the pr tag when not already present', () => {
    const t = deriveTitle(
      mk({ id: 'mem_1', content: 'Release debounce job added to CI', tags: { pr: '351' } })
    )
    expect(t).toBe('Release debounce job added to CI (PR #351)')
  })

  it('truncates long titles on a word boundary with an ellipsis', () => {
    const t = deriveTitle(mk({ id: 'mem_1', content: `${'a'.repeat(40)} ${'b'.repeat(40)}` }))
    expect(t.length).toBeLessThanOrEqual(74)
    expect(t.endsWith('…')).toBe(true)
  })

  it('falls back to "<type> <id>" when content yields no usable title', () => {
    expect(deriveTitle(mk({ id: 'mem_9', type: 'gotcha', content: '...' }))).toBe('gotcha mem_9')
  })

  it('is pure: same entry → same title', () => {
    const e = mk({ id: 'mem_5', content: 'Stable title here. body' })
    expect(deriveTitle(e)).toBe(deriveTitle(e))
  })
})

describe('linkifyMemRefs — slug-targeted links (graph-visible) + legible labels', () => {
  it('per-entry type → links the note BASENAME [[slug|title]] (graph draws it)', () => {
    // The v2.23.3 regression: [[mem_N|title]] resolved only via alias,
    // invisible to Obsidian's graph. Must target the real slug.
    const out = linkifyMemRefs('resolves=mem_3135', {
      idTypeIndex: new Map([['mem_3135', 'gotcha']]),
      idTitleIndex: new Map([['mem_3135', 'CHANGELOG Unreleased stranding']]),
      idSlugIndex: new Map([['mem_3135', 'changelog-unreleased-stranding']]),
      perEntryTypes: new Set(['gotcha']),
    })
    expect(out).toBe('resolves=[[changelog-unreleased-stranding|CHANGELOG Unreleased stranding]]')
    expect(out).not.toContain('[[mem_3135') // never alias-only
  })

  it('aggregated type (no slug) → block-anchor link with legible label', () => {
    const out = linkifyMemRefs('see mem_42', {
      idTypeIndex: new Map([['mem_42', 'inbox']]),
      idTitleIndex: new Map([['mem_42', 'upgrade noise item']]),
      perEntryTypes: new Set(['decision']),
    })
    expect(out).toBe('see [[inbox#^mem-42|upgrade noise item]]')
  })

  it('unknown id with no title → muted `mem_N` code (no fake node)', () => {
    expect(linkifyMemRefs('ref mem_999', { idTypeIndex: new Map() })).toBe('ref `mem_999`')
  })

  it('author-written [[mem_N]] is normalized through the same resolver', () => {
    // deleted id → muted code, NOT the broken [[`mem_N`]]
    expect(linkifyMemRefs('violates [[mem_2620]]', { idTypeIndex: new Map() })).toBe(
      'violates `mem_2620`'
    )
    // known per-entry id → slug link, graph-visible
    expect(
      linkifyMemRefs('see [[mem_42]]', {
        idTypeIndex: new Map([['mem_42', 'gotcha']]),
        idTitleIndex: new Map([['mem_42', 'busy_timeout CAS retry']]),
        idSlugIndex: new Map([['mem_42', 'busy-timeout-cas-retry']]),
        perEntryTypes: new Set(['gotcha']),
      })
    ).toBe('see [[busy-timeout-cas-retry|busy_timeout CAS retry]]')
  })

  it('backward compatible: no idTitleIndex → legacy mem_N label', () => {
    const out = linkifyMemRefs('resolves=mem_3135', {
      idTypeIndex: new Map([['mem_3135', 'gotcha']]),
    })
    expect(out).toBe('resolves=[[gotcha#^mem-3135|mem_3135]]')
  })
})

describe('projectMemory.searchFts — BM25 relevance over recency', () => {
  // Migration 21 backfills `memories` from `events`. To make the FTS5
  // index hit, we have to write into `memories` directly here; the
  // production path is `projectMemory.remember()` which dual-writes.
  function writeMemoryRow(args: {
    id: string
    type: string
    content: string
    tags?: Record<string, string>
    createdAt?: string
  }): void {
    const now = args.createdAt ?? new Date().toISOString()
    const tags = args.tags ?? {}
    // Single-source: seed memory_entries (the table recall/searchFts read).
    // The FTS trigger (migration 42) indexes it; tags go to the child table.
    const createdMs = Date.parse(now) || Date.now()
    prjctDb.run(
      fixture.projectId,
      `INSERT OR REPLACE INTO memory_entries
         (id, project_id, type, title, content, file, subject, provenance,
          content_hash, user_triggered, revision_count, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'declared', ?, 0, 0, ?, ?)`,
      args.id,
      fixture.projectId,
      args.type,
      args.content.slice(0, 80),
      args.content,
      typeof tags.file === 'string' ? tags.file : null,
      typeof tags.subject === 'string' ? tags.subject : null,
      `hash_${args.id}`,
      createdMs,
      createdMs
    )
    prjctDb.run(fixture.projectId, 'DELETE FROM memory_entry_tags WHERE entry_id = ?', args.id)
    for (const [k, v] of Object.entries(tags)) {
      prjctDb.run(
        fixture.projectId,
        'INSERT OR IGNORE INTO memory_entry_tags (entry_id, key, value, is_machine) VALUES (?, ?, ?, 0)',
        args.id,
        k,
        String(v)
      )
    }
  }

  it('returns the topically-relevant entry even when it is older than recency-window misses', () => {
    // 20 unrelated newer entries, then the relevant one. Without FTS,
    // the recency window of 16 would never see the OAuth memory.
    for (const i of Array.from({ length: 20 }, (_, index) => index)) {
      writeMemoryRow({
        id: `mem_noise_${i}`,
        type: 'fact',
        content: `unrelated chatter number ${i}`,
        createdAt: `2026-01-01T00:00:${String(i).padStart(2, '0')}Z`,
      })
    }
    writeMemoryRow({
      id: 'mem_oauth',
      type: 'decision',
      content: 'we chose OAuth with refresh-token rotation for the auth flow',
      tags: { domain: 'auth' },
      createdAt: '2025-12-15T00:00:00Z', // older than the noise
    })

    const hits = projectMemory.searchFts(fixture.projectId, ['oauth'], 4)
    expect(hits.length).toBeGreaterThan(0)
    expect(hits.some((e) => e.id === 'mem_oauth')).toBe(true)
  })

  it('returns an empty array for keywords with zero matches (graceful miss)', () => {
    writeMemoryRow({
      id: 'mem_a',
      type: 'fact',
      content: 'totally unrelated topic',
    })
    const hits = projectMemory.searchFts(fixture.projectId, ['nonexistentkeyword'], 4)
    expect(hits).toEqual([])
  })

  it('returns an empty array when keywords is empty (no MATCH built)', () => {
    expect(projectMemory.searchFts(fixture.projectId, [], 4)).toEqual([])
  })

  it('sanitizes FTS5 reserved tokens so a literal OR in the prompt does not blow up', () => {
    writeMemoryRow({
      id: 'mem_stripe',
      type: 'decision',
      content: 'we chose Stripe for billing',
    })
    // 'OR' is an FTS5 reserved operator; sanitization should strip it.
    const hits = projectMemory.searchFts(fixture.projectId, ['stripe', 'OR', 'billing'], 4)
    expect(hits.some((e) => e.id === 'mem_stripe')).toBe(true)
  })
})

describe('projectMemory.countByType / recallByType — hot-path exact-type queries', () => {
  it('countByType returns the true count, uncapped', async () => {
    for (const i of Array.from({ length: 7 }, (_, index) => index)) {
      await writeMemoryEntry({ type: 'inbox', content: `inbox item ${i}` })
    }
    await writeMemoryEntry({ type: 'decision', content: 'not an inbox item' })
    expect(projectMemory.countByType(fixture.projectId, 'inbox')).toBe(7)
    expect(projectMemory.countByType(fixture.projectId, 'decision')).toBe(1)
  })

  it('countByType returns 0 for a type with no entries', () => {
    expect(projectMemory.countByType(fixture.projectId, 'nonexistent-type')).toBe(0)
  })

  it('recallByType returns only the exact type, newest-first, within limit', async () => {
    await writeMemoryEntry({ type: 'improvement-signal', content: 'signal one' })
    await writeMemoryEntry({ type: 'decision', content: 'a decision in between' })
    await writeMemoryEntry({ type: 'improvement-signal', content: 'signal two' })
    await writeMemoryEntry({ type: 'improvement-signal', content: 'signal three' })

    const got = projectMemory.recallByType(fixture.projectId, 'improvement-signal', 2)
    expect(got.length).toBe(2)
    expect(got.every((e) => e.type === 'improvement-signal')).toBe(true)
    // Newest-first (id DESC): signal three before signal two.
    expect(got[0].content).toBe('signal three')
    expect(got[1].content).toBe('signal two')
  })

  it('recallByType returns [] for limit 0', () => {
    expect(projectMemory.recallByType(fixture.projectId, 'improvement-signal', 0)).toEqual([])
  })
})

describe('projectMemory.forget', () => {
  function writeMemoryRow(args: { id: string; type: string; content: string }): void {
    // Single-source: seed memory_entries (the table searchFts/recall read).
    const createdMs = Date.now()
    prjctDb.run(
      fixture.projectId,
      `INSERT OR REPLACE INTO memory_entries
         (id, project_id, type, title, content, provenance, content_hash,
          user_triggered, revision_count, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'declared', ?, 0, 0, ?, ?)`,
      args.id,
      fixture.projectId,
      args.type,
      args.content.slice(0, 80),
      args.content,
      `hash_${args.id}`,
      createdMs,
      createdMs
    )
  }

  it('removes a remembered entry from recall', async () => {
    await writeMemoryEntry({ type: 'decision', content: 'forget me please' })
    const before = projectMemory.recall(fixture.projectId, { types: ['decision'] })
    const target = before.find((e) => e.content === 'forget me please')
    expect(target).toBeDefined()

    const ok = projectMemory.forget(fixture.projectId, target!.id)
    expect(ok).toBe(true)

    const after = projectMemory.recall(fixture.projectId, { types: ['decision'] })
    expect(after.some((e) => e.id === target!.id)).toBe(false)
  })

  it('soft-deletes the FTS mirror so searchFts stops returning it', () => {
    writeMemoryRow({ id: 'mem_4242', type: 'fact', content: 'forgettable unique token zorptak' })
    expect(projectMemory.searchFts(fixture.projectId, ['zorptak'], 4).length).toBe(1)
    // No event row backs this mirror-only row, but forget still cleans the
    // mirror and reports success (it removed the entry from a read surface).
    expect(projectMemory.forget(fixture.projectId, 'mem_4242')).toBe(true)
    expect(projectMemory.searchFts(fixture.projectId, ['zorptak'], 4).length).toBe(0)
  })

  it('returns false for a non-existent id', () => {
    expect(projectMemory.forget(fixture.projectId, 'mem_999999')).toBe(false)
  })

  it('returns false for a malformed id', () => {
    expect(projectMemory.forget(fixture.projectId, 'not-an-id')).toBe(false)
  })
})

describe('projectMemory.recallForFile — anticipation (pre-edit)', () => {
  it('surfaces a gotcha tagged against the exact repo-relative file', async () => {
    await writeMemoryEntry({
      type: 'gotcha',
      content: 'stale daemon caches old hook code; stop it before testing',
      tags: { file: 'core/daemon/daemon.ts' },
    })
    const hits = projectMemory.recallForFile(fixture.projectId, 'core/daemon/daemon.ts')
    expect(hits.length).toBe(1)
    expect(hits[0]?.type).toBe('gotcha')
  })

  it('matches an absolute editor path by basename/suffix against the stored file tag', async () => {
    await writeMemoryEntry({
      type: 'gotcha',
      content: 'params metadata must use [..] not <..> or registry treats it as required',
      tags: { file: 'core/commands/embeddings.ts' },
    })
    const hits = projectMemory.recallForFile(
      fixture.projectId,
      '/Users/JJ/Apps/prjct-cli/core/commands/embeddings.ts'
    )
    expect(hits.length).toBe(1)
  })

  it('includes recurring-bug pattern entries, not just gotchas', async () => {
    await writeMemoryEntry({
      type: 'learning',
      content: 'friction-detector compared 64-char hash vs 12-char key — never matched',
      tags: { file: 'core/services/friction-detector.ts', pattern: 'recurring-bug' },
    })
    const hits = projectMemory.recallForFile(
      fixture.projectId,
      'core/services/friction-detector.ts'
    )
    expect(hits.length).toBe(1)
    expect(hits[0]?.tags?.pattern).toBe('recurring-bug')
  })

  it('excludes plain decisions/learnings about the file (strict, no noise)', async () => {
    await writeMemoryEntry({
      type: 'decision',
      content: 'we keep the dispatcher registry as the single source of truth',
      tags: { file: 'core/hooks/registry.ts' },
    })
    const hits = projectMemory.recallForFile(fixture.projectId, 'core/hooks/registry.ts')
    expect(hits).toEqual([])
  })

  it('returns an empty array when no memory targets the file', () => {
    expect(projectMemory.recallForFile(fixture.projectId, 'core/some/untouched-file.ts')).toEqual(
      []
    )
  })

  it('returns an empty array for an empty file path', () => {
    expect(projectMemory.recallForFile(fixture.projectId, '')).toEqual([])
  })

  it('caps results at the requested limit', async () => {
    for (const i of Array.from({ length: 5 }, (_, index) => index)) {
      await writeMemoryEntry({
        type: 'gotcha',
        content: `trap number ${i} on the hot file`,
        tags: { file: 'core/hot.ts' },
      })
    }
    expect(projectMemory.recallForFile(fixture.projectId, 'core/hot.ts', 2).length).toBe(2)
  })

  it('includes file-history context by default but excludes it with preventiveOnly', async () => {
    await writeMemoryEntry({
      type: 'context',
      content: 'file changed during the auth refactor',
      tags: { files: 'core/authz.ts' },
    })
    // Default (pull `prjct guard`): history surfaces.
    const withHistory = projectMemory.recallForFile(fixture.projectId, 'core/authz.ts')
    expect(withHistory.some((e) => e.type === 'context')).toBe(true)
    // preventiveOnly (pre-edit push): traps only, no history.
    const trapsOnly = projectMemory.recallForFile(fixture.projectId, 'core/authz.ts', 3, {
      preventiveOnly: true,
    })
    expect(trapsOnly).toEqual([])
  })
})

describe('predictive risk briefing — recallRisksForFiles (planning-time)', () => {
  it('concentrates preventive memory for the likely files, dedups, and excludes history', async () => {
    await writeMemoryEntry({
      type: 'gotcha',
      content: 'auth: the 2FA plugin must init before the session middleware',
      tags: { file: 'core/auth.ts' },
    })
    await writeMemoryEntry({
      type: 'anti-pattern',
      content: 'auth: do not read the token from the cookie directly',
      tags: { file: 'core/auth.ts' },
    })
    // History (context) is NOT risk — must be excluded from the briefing.
    await writeMemoryEntry({
      type: 'context',
      content: 'auth refactored last sprint',
      tags: { file: 'core/auth.ts' },
    })
    const { recallRisksForFiles } = await import('../../services/task-service')
    const risks = recallRisksForFiles(fixture.projectId, [
      { path: 'core/auth.ts', signals: [], reason: '' },
      { path: 'core/auth.ts', signals: [], reason: '' }, // duplicate file → no dup hits
    ])
    expect(risks.length).toBe(2) // the gotcha + the anti-pattern, deduped
    expect(risks.every((r) => r.file === 'core/auth.ts')).toBe(true)
    expect(risks.some((r) => r.title.length > 0)).toBe(true)
    // No history leaked in.
    expect(risks.some((r) => r.title.includes('refactored last sprint'))).toBe(false)
  })

  it('returns empty when the likely files have no preventive memory', () => {
    // recallRisksForFiles is imported lazily above; here just assert the clean
    // path: no traps recorded against an unrelated file → empty briefing.
    const { recallRisksForFiles } = require('../../services/task-service')
    expect(
      recallRisksForFiles(fixture.projectId, [
        { path: 'core/untouched.ts', signals: [], reason: '' },
      ])
    ).toEqual([])
  })
})

describe('projectMemory.remember — auto-infer tags.file for anticipation', () => {
  beforeEach(async () => {
    await fs.mkdir(path.join(fixture.tmpRoot, '.prjct'), { recursive: true })
    await fs.writeFile(
      path.join(fixture.tmpRoot, '.prjct', 'prjct.config.json'),
      JSON.stringify({ projectId: fixture.projectId })
    )
  })

  it('infers file from content path so recallForFile / risks work without explicit tags', async () => {
    await projectMemory.remember(fixture.tmpRoot, {
      type: 'gotcha',
      content:
        'MutationCache onError always fires with mutation onError — set meta.skipGlobalError in src/lib/api.ts',
      projectId: fixture.projectId,
      requireWrite: true,
    })
    const hits = projectMemory.recallForFile(fixture.projectId, 'src/lib/api.ts', 3, {
      preventiveOnly: true,
    })
    expect(hits.length).toBeGreaterThan(0)
    expect(hits.some((h) => h.type === 'gotcha' && h.content.includes('MutationCache'))).toBe(true)
    expect(hits[0]?.tags?.file).toBe('src/lib/api.ts')
    expect(hits[0]?.tags?.file_source).toBe('inferred')
  })

  it('does not override an explicit file tag', async () => {
    await projectMemory.remember(fixture.tmpRoot, {
      type: 'gotcha',
      content: 'mentions src/other.ts but explicit wins',
      tags: { file: 'src/explicit.ts' },
      projectId: fixture.projectId,
      requireWrite: true,
    })
    const hits = projectMemory.recallForFile(fixture.projectId, 'src/explicit.ts', 3, {
      preventiveOnly: true,
    })
    expect(hits.some((h) => h.tags?.file === 'src/explicit.ts')).toBe(true)
    expect(hits[0]?.tags?.file_source).toBeUndefined()
  })
})

describe('projectMemory.remember — topic-key UPSERT (write-side supersession)', () => {
  // remember() resolves the project from the path's config — give tmpRoot one.
  beforeEach(async () => {
    await fs.mkdir(path.join(fixture.tmpRoot, '.prjct'), { recursive: true })
    await fs.writeFile(
      path.join(fixture.tmpRoot, '.prjct', 'prjct.config.json'),
      JSON.stringify({ projectId: fixture.projectId })
    )
  })

  it('a re-capture with the same topic tag supersedes the old entry at the STORE level', async () => {
    await projectMemory.remember(fixture.tmpRoot, {
      type: 'decision',
      content: 'auth model v1: sessions in cookies',
      tags: { topic: 'architecture/auth-model' },
      projectId: fixture.projectId,
    })
    await new Promise((r) => setTimeout(r, 5))
    await projectMemory.remember(fixture.tmpRoot, {
      type: 'decision',
      content: 'auth model v2: JWT + refresh rotation',
      tags: { topic: 'architecture/auth-model' },
      projectId: fixture.projectId,
    })

    // Old version is soft-deleted in the store (not just hidden at read time).
    const active = prjctDb.query<{ content: string; topic_key: string; revision_count: number }>(
      fixture.projectId,
      "SELECT content, topic_key, revision_count FROM memory_entries WHERE type = 'decision' AND deleted_at IS NULL"
    )
    expect(active).toHaveLength(1)
    expect(active[0].content).toContain('v2')
    expect(active[0].topic_key).toBe('architecture/auth-model')
    expect(active[0].revision_count).toBe(1) // lineage: one prior version
    const superseded = prjctDb.get<{ c: number }>(
      fixture.projectId,
      "SELECT COUNT(*) AS c FROM memory_entries WHERE type = 'decision' AND deleted_at IS NOT NULL"
    )
    expect(superseded?.c).toBe(1)
  })

  it('different topics never supersede each other; untagged captures still accumulate', async () => {
    await projectMemory.remember(fixture.tmpRoot, {
      type: 'decision',
      content: 'topic A decision',
      tags: { topic: 'a' },
      projectId: fixture.projectId,
    })
    await projectMemory.remember(fixture.tmpRoot, {
      type: 'decision',
      content: 'topic B decision',
      tags: { topic: 'b' },
      projectId: fixture.projectId,
    })
    await projectMemory.remember(fixture.tmpRoot, {
      type: 'decision',
      content: 'untagged decision one',
      projectId: fixture.projectId,
    })
    await projectMemory.remember(fixture.tmpRoot, {
      type: 'decision',
      content: 'untagged decision two',
      projectId: fixture.projectId,
    })

    const active = prjctDb.get<{ c: number }>(
      fixture.projectId,
      "SELECT COUNT(*) AS c FROM memory_entries WHERE type = 'decision' AND deleted_at IS NULL"
    )
    expect(active?.c).toBe(4) // nothing superseded
  })

  it('legacy `key`-tagged entries are superseded by a new capture with the same key', async () => {
    // Legacy entry captured before topic_key existed (tag row only).
    await projectMemory.remember(fixture.tmpRoot, {
      type: 'gotcha',
      content: 'old trap description',
      tags: { key: 'daemon-restart' },
      projectId: fixture.projectId,
    })
    await new Promise((r) => setTimeout(r, 5))
    await projectMemory.remember(fixture.tmpRoot, {
      type: 'gotcha',
      content: 'updated trap description',
      tags: { key: 'daemon-restart' },
      projectId: fixture.projectId,
    })

    const active = prjctDb.query<{ content: string }>(
      fixture.projectId,
      "SELECT content FROM memory_entries WHERE type = 'gotcha' AND deleted_at IS NULL"
    )
    expect(active).toHaveLength(1)
    expect(active[0].content).toBe('updated trap description')
  })
})

describe('topic supersession — edge-case hardening (cleanup sweep)', () => {
  beforeEach(async () => {
    await fs.mkdir(path.join(fixture.tmpRoot, '.prjct'), { recursive: true })
    await fs.writeFile(
      path.join(fixture.tmpRoot, '.prjct', 'prjct.config.json'),
      JSON.stringify({ projectId: fixture.projectId })
    )
  })

  it('dedup-hit with a topic tag FOLDS the topic into the existing entry and supersedes others', async () => {
    // Older revision of the topic.
    await projectMemory.remember(fixture.tmpRoot, {
      type: 'decision',
      content: 'runtime: node',
      tags: { topic: 'runtime' },
      projectId: fixture.projectId,
    })
    // Untagged capture (no topic identity yet).
    await projectMemory.remember(fixture.tmpRoot, {
      type: 'decision',
      content: 'runtime: bun',
      projectId: fixture.projectId,
    })
    await new Promise((r) => setTimeout(r, 5))
    // Re-capture of the SAME content, now claiming the topic → dedup hits,
    // but the fold-in must stamp topic_key and supersede the 'node' revision.
    await projectMemory.remember(fixture.tmpRoot, {
      type: 'decision',
      content: 'runtime: bun',
      tags: { topic: 'runtime' },
      projectId: fixture.projectId,
    })

    const active = prjctDb.query<{ content: string; topic_key: string | null }>(
      fixture.projectId,
      "SELECT content, topic_key FROM memory_entries WHERE type = 'decision' AND deleted_at IS NULL"
    )
    expect(active).toHaveLength(1)
    expect(active[0].content).toBe('runtime: bun')
    expect(active[0].topic_key).toBe('runtime')
  })

  it('a failed event write must NOT tombstone the topic (supersession gated on eventId)', async () => {
    await projectMemory.remember(fixture.tmpRoot, {
      type: 'decision',
      content: 'the only active revision',
      tags: { topic: 'fragile' },
      projectId: fixture.projectId,
    })
    // Simulate the log failure path: call supersession the way remember()
    // GATES it — with no successful event, applyTopicSupersession is never
    // invoked. Assert the gate exists by verifying the entry survives a
    // remember() whose write path is broken (unwritable config → log fails).
    await projectMemory.remember('/nonexistent/path/xyz', {
      type: 'decision',
      content: 'new revision that never lands',
      tags: { topic: 'fragile' },
      projectId: fixture.projectId,
    })
    const active = prjctDb.get<{ c: number }>(
      fixture.projectId,
      "SELECT COUNT(*) AS c FROM memory_entries WHERE topic_key = 'fragile' AND deleted_at IS NULL"
    )
    expect(active?.c).toBe(1) // the old revision was NOT tombstoned
  })

  it('throws when a required remember event write fails', async () => {
    const appendSpy = spyOn(prjctDb, 'appendEvent').mockImplementation(() => {
      throw new Error('attempt to write a readonly database')
    })
    try {
      await expect(
        projectMemory.remember(fixture.tmpRoot, {
          type: 'decision',
          content: 'required memory must not report success',
          projectId: fixture.projectId,
          requireWrite: true,
        })
      ).rejects.toThrow('attempt to write a readonly database')
    } finally {
      appendSpy.mockRestore()
    }
  })
})
