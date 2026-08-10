/**
 * `prjct memory export|import` — git-shareable project memory.
 *
 * Zero-server team onboarding: `export` writes the project's active memory
 * (typed entries + tags) as chunked JSONL under `.prjct/memory-export/` so it
 * can be COMMITTED; a teammate clones and runs `import`, which replays the
 * entries through the normal event path (audit trail + triggers intact) with
 * content-hash dedup — re-importing is a no-op, and local knowledge is never
 * overwritten. Complements cloud sync; requires no account.
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import { prjctDb } from '../storage/database'
import type { MdOption } from '../types/cli'
import type { CommandResult } from '../types/commands'
import { fileExists } from '../utils/file-helper'
import out from '../utils/output'
import { PrjctCommandsBase } from './base'
import { requireProject } from './guards'

const EXPORT_DIR = path.join('.prjct', 'memory-export')
const CHUNK_SIZE = 500

interface ExportedEntry {
  id: string
  type: string
  title: string | null
  content: string
  provenance: string
  content_hash: string
  topic_key: string | null
  created_at: number
  tags: Record<string, string>
}

interface EntryRow {
  id: string
  type: string
  title: string | null
  content: string
  provenance: string
  content_hash: string
  topic_key: string | null
  created_at: number
}

export class MemoryExportCommands extends PrjctCommandsBase {
  /** Router: `prjct memory export|import|index|close|forget|dream`. */
  async memory(
    input: string | null = null,
    projectPath: string = process.cwd(),
    options: MdOption & { force?: boolean; dryRun?: boolean; reason?: string } = {}
  ): Promise<CommandResult> {
    const parts = (input ?? '').trim().split(/\s+/).filter(Boolean)
    const sub = parts[0] || ''
    if (sub === 'export') return this.export(projectPath, options)
    if (sub === 'import') return this.import(projectPath, options)
    if (sub === 'index') return this.index(projectPath, options)
    if (sub === 'close') {
      const { PrimitiveCommands } = await import('./primitives')
      return new PrimitiveCommands().close(parts[1] ?? null, projectPath, options)
    }
    if (sub === 'forget') {
      const { PrimitiveCommands } = await import('./primitives')
      return new PrimitiveCommands().forget(parts[1] ?? null, projectPath, options)
    }
    if (sub === 'dream') {
      const { CeremonyCommands } = await import('./ceremonies')
      return new CeremonyCommands().dream(null, projectPath, options)
    }
    const msg =
      'Usage: prjct memory export|import|index|close <id>|forget <id>|dream — shareable export, L0 index, lifecycle, or auto-dream consolidation.'
    if (options.md) console.log(`> ${msg}`)
    else out.info(msg)
    return { success: false, error: 'unknown memory subcommand' }
  }

  /** Show / rebuild the L0 compact memory index. */
  private async index(projectPath: string, options: MdOption): Promise<CommandResult> {
    const proj = await requireProject(projectPath)
    if (!proj.ok) return proj.result
    const { buildAndStoreMemoryL0Index, loadMemoryL0Index } = await import(
      '../services/memory-index'
    )
    const stamp =
      buildAndStoreMemoryL0Index({ projectId: proj.value, source: 'manual' }) ??
      loadMemoryL0Index(proj.value)
    if (!stamp) {
      const msg = 'No memory index available (empty vault).'
      if (options.md) console.log(`> ${msg}`)
      else out.info(msg)
      return { success: false, error: msg }
    }
    console.log(stamp.markdown)
    return { success: true, live: stamp.live, builtAt: stamp.builtAt }
  }

  private async export(projectPath: string, options: MdOption): Promise<CommandResult> {
    const proj = await requireProject(projectPath)
    if (!proj.ok) return proj.result
    const projectId = proj.value

    const rows = prjctDb.query<EntryRow>(
      projectId,
      `SELECT id, type, title, content, provenance, content_hash, topic_key, created_at
       FROM memory_entries WHERE deleted_at IS NULL ORDER BY created_at ASC`
    )
    const entries: ExportedEntry[] = rows.map((r) => {
      // User tags plus the topic/key identity tags: 'key' is machine-classified
      // by the trigger, but dropping it breaks topic lineage on the importing
      // machine (future captures would not supersede the imported revision).
      const tagRows = prjctDb.query<{ key: string; value: string }>(
        projectId,
        "SELECT key, value FROM memory_entry_tags WHERE entry_id = ? AND (is_machine = 0 OR key IN ('topic', 'key'))",
        r.id
      )
      const tags: Record<string, string> = {}
      for (const t of tagRows) tags[t.key] = t.value
      return { ...r, tags }
    })

    const dir = path.join(projectPath, EXPORT_DIR)
    // Regenerate atomically-ish: clear prior chunks so removals don't linger.
    await fs.rm(dir, { recursive: true, force: true })
    await fs.mkdir(dir, { recursive: true })

    const chunks = Array.from({ length: Math.ceil(entries.length / CHUNK_SIZE) }, (_, index) =>
      entries.slice(index * CHUNK_SIZE, (index + 1) * CHUNK_SIZE)
    )
    for (const [index, chunk] of chunks.entries()) {
      await fs.writeFile(
        path.join(dir, `chunk-${String(index + 1).padStart(3, '0')}.jsonl`),
        `${chunk.map((e) => JSON.stringify(e)).join('\n')}\n`
      )
    }
    await fs.writeFile(
      path.join(dir, 'manifest.json'),
      `${JSON.stringify({ version: 1, entries: entries.length, chunks: chunks.length, exportedAt: new Date().toISOString() }, null, 2)}\n`
    )

    const msg = `exported ${entries.length} memories → ${EXPORT_DIR}/ (${chunks.length} chunk${chunks.length === 1 ? '' : 's'}). Commit it; teammates run \`prjct memory import\` after clone.`
    if (options.md) console.log(`✓ ${msg}`)
    else out.done(msg)
    return { success: true, exported: entries.length }
  }

  private async import(projectPath: string, options: MdOption): Promise<CommandResult> {
    const proj = await requireProject(projectPath)
    if (!proj.ok) return proj.result
    const projectId = proj.value

    const dir = path.join(projectPath, EXPORT_DIR)
    if (!(await fileExists(path.join(dir, 'manifest.json')))) {
      const msg = `no export found at ${EXPORT_DIR}/ — nothing to import.`
      if (options.md) console.log(`> ${msg}`)
      else out.info(msg)
      return { success: false, error: 'no export found' }
    }

    const imported: ExportedEntry[] = []
    const skipped: ExportedEntry[] = []
    const files = (await fs.readdir(dir)).filter((f) => f.endsWith('.jsonl')).sort()
    for (const file of files) {
      const lines = (await fs.readFile(path.join(dir, file), 'utf-8')).split('\n').filter(Boolean)
      for (const line of lines) {
        const e: ExportedEntry | null = (() => {
          try {
            return JSON.parse(line)
          } catch {
            return null
          }
        })()
        if (!e) continue // one corrupt line must not sink the import
        if (!e.type || !e.content || !e.content_hash) continue
        // Dedup BEFORE writing — TYPE-AWARE and active-only, matching the
        // ux_mem_hash index (project, hash, type): the same content under two
        // types is legal, and a hash-only check silently dropped the second.
        const dup = prjctDb.get<{ id: string }>(
          projectId,
          'SELECT id FROM memory_entries WHERE content_hash = ? AND type = ? AND deleted_at IS NULL LIMIT 1',
          e.content_hash,
          e.type
        )
        if (dup) {
          skipped.push(e)
          continue
        }
        // Origin time: tolerate a missing/garbage created_at on a hand-edited
        // line (one bad line must not sink the import) — fall back to now.
        const createdMs = Number(e.created_at)
        const createdIso = Number.isFinite(createdMs)
          ? new Date(createdMs).toISOString()
          : new Date().toISOString()
        // Replay through the normal event path — the memory_entries trigger
        // populates the typed row + tags; created_at preserves origin time.
        prjctDb.appendEvent(projectId, `memory.remember.${e.type}`, {
          content: e.content,
          tags: e.tags ?? {},
          provenance: e.provenance || 'declared',
          content_hash: e.content_hash,
          project_id: projectId,
          created_at: createdIso,
        })
        // Topic lineage survives the machine hop: stamp the typed topic_key
        // (the event replay bypasses remember(), which normally does this).
        if (e.topic_key) {
          prjctDb.run(
            projectId,
            `UPDATE memory_entries SET topic_key = ?
             WHERE project_id = ? AND type = ? AND content_hash = ? AND deleted_at IS NULL`,
            e.topic_key,
            projectId,
            e.type,
            e.content_hash
          )
        }
        imported.push(e)
      }
    }

    const msg = `imported ${imported.length} memories (${skipped.length} already present) from ${EXPORT_DIR}/.`
    if (options.md) console.log(`✓ ${msg}`)
    else out.done(msg)
    return { success: true, imported: imported.length, skipped: skipped.length }
  }
}
