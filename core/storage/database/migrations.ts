/**
 * SQLite schema migrations for the per-project database.
 *
 * Append-only — never edit a past migration's `up` block (existing
 * databases will be out of sync). New schema changes go in a new
 * migration with the next sequential version number.
 */

import { memoryFingerprint } from '../../memory/content-fingerprint'
import type { Migration } from '../../types/storage/extended'
import { INITIAL_SCHEMA_SQL } from './initial-schema.sql'
import type { SqliteDatabase } from './sqlite-compat'

function stripLiteralFrictionEvidence(content: string): string {
  const lines = content.split('\n')
  if (!/^\[[^\]]+\]\s+Lesson:/i.test(lines[0] ?? '')) return content
  const cleaned = lines
    .filter((line) => !/^Evidence:\s*/i.test(line.trim()))
    .join('\n')
    .trim()
  return cleaned || content
}

function scrubFrictionEventData(raw: string): string | null {
  try {
    const data = JSON.parse(raw) as { content?: unknown }
    if (typeof data.content !== 'string') return null
    const cleaned = stripLiteralFrictionEvidence(data.content)
    if (cleaned === data.content) return null
    return JSON.stringify({ ...data, content: cleaned })
  } catch {
    return null
  }
}

export const migrations: Migration[] = [
  {
    version: 1,
    name: 'initial-schema',
    up: (db: SqliteDatabase) => {
      db.run(INITIAL_SCHEMA_SQL)
    },
  },
  {
    version: 2,
    name: 'archives-table',
    up: (db: SqliteDatabase) => {
      db.run(`
        -- =======================================================================
        -- Archives: Stale data moved out of active storage (PRJ-267)
        -- =======================================================================
        CREATE TABLE archives (
          id            TEXT PRIMARY KEY,
          entity_type   TEXT NOT NULL,
          entity_id     TEXT NOT NULL,
          entity_data   TEXT NOT NULL,
          summary       TEXT,
          archived_at   TEXT NOT NULL,
          reason        TEXT NOT NULL
        );

        CREATE INDEX idx_archives_entity_type ON archives(entity_type);
        CREATE INDEX idx_archives_archived_at ON archives(archived_at);
        CREATE INDEX idx_archives_entity_id ON archives(entity_id);
      `)
    },
  },
  {
    version: 3,
    name: 'workflow-rules-table',
    up: (db: SqliteDatabase) => {
      db.run(`
        -- =======================================================================
        -- Workflow Rules: hooks, gates, and custom steps (Phase 2)
        -- =======================================================================
        CREATE TABLE workflow_rules (
          id          INTEGER PRIMARY KEY AUTOINCREMENT,
          type        TEXT NOT NULL,
          command     TEXT NOT NULL,
          position    TEXT NOT NULL,
          action      TEXT NOT NULL,
          description TEXT,
          enabled     INTEGER NOT NULL DEFAULT 1,
          timeout_ms  INTEGER NOT NULL DEFAULT 60000,
          created_at  TEXT NOT NULL,
          sort_order  INTEGER NOT NULL DEFAULT 0
        );

        CREATE INDEX idx_workflow_rules_command ON workflow_rules(command);
      `)
    },
  },
  {
    version: 4,
    name: 'custom-workflows-table',
    up: (db: SqliteDatabase) => {
      db.run(`
        -- =======================================================================
        -- Custom Workflows: User-defined workflows with agentic auto-config
        -- =======================================================================
        CREATE TABLE custom_workflows (
          id          INTEGER PRIMARY KEY AUTOINCREMENT,
          name        TEXT UNIQUE NOT NULL,
          description TEXT,
          created_at  TEXT NOT NULL,
          updated_at  TEXT NOT NULL,
          is_builtin  INTEGER NOT NULL DEFAULT 0,
          enabled     INTEGER NOT NULL DEFAULT 1,
          metadata    TEXT
        );

        CREATE INDEX idx_custom_workflows_name ON custom_workflows(name);
        CREATE INDEX idx_custom_workflows_enabled ON custom_workflows(enabled);

        -- Seed built-in workflows (task, done, ship, sync)
        INSERT INTO custom_workflows (name, description, is_builtin, enabled, created_at, updated_at)
        VALUES
          ('task', 'Start a work cycle', 1, 1, datetime('now'), datetime('now')),
          ('done', 'Complete current task/subtask', 1, 1, datetime('now'), datetime('now')),
          ('ship', 'Ship feature with version bump and PR', 1, 1, datetime('now'), datetime('now')),
          ('sync', 'Analyze project and regenerate context', 1, 1, datetime('now'), datetime('now'));
      `)
    },
  },
  {
    version: 5,
    name: 'llm-analysis-table',
    up: (db: SqliteDatabase) => {
      db.run(`
        -- =======================================================================
        -- LLM Analysis: Structured findings from hybrid sync pipeline
        -- Pipeline: CLI (collect) → LLM (analyze) → CLI (store)
        -- =======================================================================
        CREATE TABLE llm_analysis (
          id            INTEGER PRIMARY KEY AUTOINCREMENT,
          commit_hash   TEXT,
          status        TEXT NOT NULL DEFAULT 'active',
          analysis      TEXT NOT NULL,
          analyzed_at   TEXT NOT NULL,
          superseded_at TEXT
        );

        CREATE INDEX idx_llm_analysis_status ON llm_analysis(status);
        CREATE INDEX idx_llm_analysis_commit ON llm_analysis(commit_hash);
      `)
    },
  },
  {
    version: 6,
    name: 'context-feedback-table',
    up: (db: SqliteDatabase) => {
      db.run(`
        -- =======================================================================
        -- Context Feedback: RL loop for file suggestion improvement
        -- Records suggested vs actual files per task for scoring boosts
        -- =======================================================================
        CREATE TABLE context_feedback (
          id              INTEGER PRIMARY KEY AUTOINCREMENT,
          task_id         TEXT NOT NULL,
          keywords        TEXT NOT NULL,
          suggested_files TEXT NOT NULL,
          actual_files    TEXT,
          precision       REAL,
          recall          REAL,
          created_at      TEXT NOT NULL,
          completed_at    TEXT
        );

        CREATE INDEX idx_cf_task ON context_feedback(task_id);
      `)
    },
  },
  {
    version: 7,
    name: 'sessions-table',
    up: (db: SqliteDatabase) => {
      db.run(`
        -- =======================================================================
        -- Sessions: Task lifecycle tracking (replaces current.json + archive/)
        -- =======================================================================
        CREATE TABLE sessions (
          id            TEXT PRIMARY KEY,
          project_id    TEXT NOT NULL,
          task          TEXT NOT NULL,
          status        TEXT NOT NULL,
          started_at    TEXT NOT NULL,
          paused_at     TEXT,
          completed_at  TEXT,
          duration      INTEGER NOT NULL DEFAULT 0,
          metrics       TEXT NOT NULL DEFAULT '{}',
          timeline      TEXT NOT NULL DEFAULT '[]'
        );

        CREATE INDEX idx_sessions_project ON sessions(project_id);
        CREATE INDEX idx_sessions_status ON sessions(status);
        CREATE INDEX idx_sessions_completed ON sessions(completed_at);
      `)
    },
  },
  {
    version: 8,
    name: 'task-token-tracking',
    up: (db: SqliteDatabase) => {
      db.run(`
        -- =======================================================================
        -- Token usage tracking per task (input + output)
        -- =======================================================================
        ALTER TABLE tasks ADD COLUMN tokens_in INTEGER DEFAULT 0;
        ALTER TABLE tasks ADD COLUMN tokens_out INTEGER DEFAULT 0;
      `)
    },
  },
  {
    version: 9,
    name: 'context-health-tables',
    up: (db: SqliteDatabase) => {
      db.run(`
        -- =======================================================================
        -- Context Zone Events: Track zone transitions for health analytics
        -- =======================================================================
        CREATE TABLE context_zone_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          project_id TEXT NOT NULL,
          session_id TEXT,
          zone_from TEXT NOT NULL,
          zone_to TEXT NOT NULL,
          usage_percent REAL NOT NULL,
          action TEXT,
          timestamp TEXT NOT NULL
        );

        CREATE INDEX idx_cze_project ON context_zone_events(project_id);

        -- =======================================================================
        -- Context Compactions: Track compaction events
        -- =======================================================================
        CREATE TABLE context_compactions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          project_id TEXT NOT NULL,
          format TEXT NOT NULL DEFAULT 'standard',
          original_turns INTEGER NOT NULL,
          files_count INTEGER NOT NULL DEFAULT 0,
          timestamp TEXT NOT NULL
        );

        CREATE INDEX idx_cc_project ON context_compactions(project_id);
      `)
    },
  },
  {
    version: 10,
    name: 'fts5-memories',
    up: (db: SqliteDatabase) => {
      db.run(`
        -- =======================================================================
        -- Memories: Tagged, searchable memory store (replaces memories.json)
        -- =======================================================================
        CREATE TABLE IF NOT EXISTS memories (
          id              TEXT PRIMARY KEY,
          project_id      TEXT NOT NULL,
          title           TEXT NOT NULL,
          content         TEXT NOT NULL,
          tags            TEXT,
          topic_key       TEXT,
          content_hash    TEXT,
          user_triggered  INTEGER NOT NULL DEFAULT 0,
          revision_count  INTEGER NOT NULL DEFAULT 1,
          confidence      TEXT,
          observation_count INTEGER DEFAULT 0,
          created_at      TEXT NOT NULL,
          updated_at      TEXT NOT NULL,
          deleted_at      TEXT
        );

        CREATE INDEX IF NOT EXISTS idx_memories_project ON memories(project_id);
        CREATE INDEX IF NOT EXISTS idx_memories_topic ON memories(topic_key);
        CREATE INDEX IF NOT EXISTS idx_memories_hash ON memories(content_hash);
        CREATE INDEX IF NOT EXISTS idx_memories_deleted ON memories(deleted_at);

        -- FTS5 virtual table for full-text search with BM25 ranking
        CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
          title, content, tags,
          content='memories', content_rowid='rowid'
        );

        -- Triggers to keep FTS index in sync
        CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
          INSERT INTO memories_fts(rowid, title, content, tags)
          VALUES (NEW.rowid, NEW.title, NEW.content, NEW.tags);
        END;

        CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
          INSERT INTO memories_fts(memories_fts, rowid, title, content, tags)
          VALUES ('delete', OLD.rowid, OLD.title, OLD.content, OLD.tags);
        END;

        CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
          INSERT INTO memories_fts(memories_fts, rowid, title, content, tags)
          VALUES ('delete', OLD.rowid, OLD.title, OLD.content, OLD.tags);
          INSERT INTO memories_fts(rowid, title, content, tags)
          VALUES (NEW.rowid, NEW.title, NEW.content, NEW.tags);
        END;
      `)

      // Migrate existing memories from kv_store (memories.json → SQLite)
      try {
        const row = db.prepare("SELECT data FROM kv_store WHERE key = 'memory:memories'").get() as {
          data: string
        } | null
        if (row) {
          const legacy = JSON.parse(row.data) as {
            memories?: Array<{
              id: string
              title: string
              content: string
              tags?: string[]
              userTriggered?: boolean
              createdAt: string
              updatedAt: string
              confidence?: string
              observationCount?: number
            }>
          }
          if (legacy.memories && legacy.memories.length > 0) {
            const insert = db.prepare(`
              INSERT OR IGNORE INTO memories
                (id, project_id, title, content, tags, content_hash, user_triggered, confidence, observation_count, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `)
            for (const m of legacy.memories) {
              insert.run(
                m.id,
                '_migrated',
                m.title,
                m.content,
                (m.tags || []).join(','),
                null,
                m.userTriggered ? 1 : 0,
                m.confidence ?? null,
                m.observationCount ?? 0,
                m.createdAt,
                m.updatedAt
              )
            }
          }
        }
      } catch {
        // Migration is best-effort — old data may not exist
      }
    },
  },
  {
    version: 11,
    name: 'agent-sessions',
    up: (db: SqliteDatabase) => {
      db.run(`
        -- =======================================================================
        -- Agent Sessions: Track AI agent work sessions across compactions
        -- =======================================================================
        CREATE TABLE IF NOT EXISTS agent_sessions (
          id          TEXT PRIMARY KEY,
          project_id  TEXT NOT NULL,
          directory   TEXT,
          task_id     TEXT,
          goal        TEXT,
          started_at  TEXT NOT NULL,
          ended_at    TEXT,
          summary     TEXT,
          files_touched TEXT,
          created_at  TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_agent_sessions_project ON agent_sessions(project_id);
        CREATE INDEX IF NOT EXISTS idx_agent_sessions_task ON agent_sessions(task_id);

        -- =======================================================================
        -- User Prompts: Capture what the user asked (intent tracking)
        -- =======================================================================
        CREATE TABLE IF NOT EXISTS user_prompts (
          id          TEXT PRIMARY KEY,
          project_id  TEXT NOT NULL,
          session_id  TEXT,
          content     TEXT NOT NULL,
          created_at  TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_user_prompts_project ON user_prompts(project_id);
        CREATE INDEX IF NOT EXISTS idx_user_prompts_session ON user_prompts(session_id);
      `)

      // Add session_id column to memories (links observations to agent sessions)
      try {
        db.run('ALTER TABLE memories ADD COLUMN session_id TEXT')
      } catch {
        // Column may already exist
      }
    },
  },
  {
    version: 12,
    name: 'task-body-and-comments',
    up: (db: SqliteDatabase) => {
      // Add body column for markdown descriptions on queue tasks
      try {
        db.run('ALTER TABLE queue_tasks ADD COLUMN body TEXT')
      } catch {
        // Column may already exist
      }

      db.run(`
        CREATE TABLE IF NOT EXISTS queue_task_comments (
          id          TEXT PRIMARY KEY,
          task_id     TEXT NOT NULL,
          author      TEXT NOT NULL DEFAULT 'user',
          content     TEXT NOT NULL,
          created_at  TEXT NOT NULL,
          updated_at  TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_qtc_task_id ON queue_task_comments(task_id);
      `)
    },
  },
  {
    version: 13,
    name: 'workflow-rules-v2',
    up: (db: SqliteDatabase) => {
      // v2 workflow engine: conditional rules, parallel hooks, gate caching.
      try {
        db.run('ALTER TABLE workflow_rules ADD COLUMN when_expr TEXT')
      } catch {
        // Column may already exist
      }
      try {
        db.run('ALTER TABLE workflow_rules ADD COLUMN parallel INTEGER NOT NULL DEFAULT 1')
      } catch {
        // Column may already exist
      }

      db.run(`
        CREATE TABLE IF NOT EXISTS workflow_rule_cache (
          rule_id       INTEGER NOT NULL,
          context_hash  TEXT NOT NULL,
          ran_at        TEXT NOT NULL,
          ttl_ms        INTEGER NOT NULL DEFAULT 3600000,
          PRIMARY KEY (rule_id, context_hash)
        );

        CREATE INDEX IF NOT EXISTS idx_wrc_rule ON workflow_rule_cache(rule_id);
      `)
    },
  },
  {
    version: 14,
    name: 'workflow-rules-trust-source',
    up: (db: SqliteDatabase) => {
      // `trust_source` tags where a rule came from. `local` (default) runs
      // without prompting — the user wrote it themselves. `imported` means
      // it came from a shared template and the engine should refuse to run
      // its shell action until the user explicitly approves. No behavioral
      // change in alpha.4 (every existing rule is local) — the column just
      // buys forward-compat for template importing in a later release.
      try {
        db.run("ALTER TABLE workflow_rules ADD COLUMN trust_source TEXT NOT NULL DEFAULT 'local'")
      } catch {
        // Column may already exist
      }
    },
  },
  {
    version: 15,
    name: 'disable-orphan-workflow-rules',
    up: (db: SqliteDatabase) => {
      // v1.x users could attach hooks to any command verb. v2 narrowed
      // HookCommand to ['task', 'done', 'ship', 'sync'] but the rows
      // keyed on the other verbs live on in this table — the engine
      // never fires them, yet `prjct workflow list` still surfaces them.
      //
      // Disable them (enabled=0) rather than delete: the user can still
      // see them with `--include-disabled`, rename to a v2 equivalent,
      // and re-enable. Idempotent.
      const orphanHookCommands = [
        'pause',
        'resume',
        'reopen',
        'next',
        'dash',
        'bug',
        'idea',
        'linear',
        'jira',
        'tokens',
        'velocity',
        'plan',
      ]
      const list = orphanHookCommands.map((v) => `'${v}'`).join(',')
      db.run(`UPDATE workflow_rules SET enabled = 0 WHERE command IN (${list}) AND enabled = 1`)
    },
  },
  {
    version: 16,
    name: 'specs-and-task-linkage',
    up: (db: SqliteDatabase) => {
      // SDD: specs are first-class entities. A spec captures Goal /
      // Acceptance Criteria / Scope / Out-of-scope / Risks before
      // implementation starts. `prjct work --spec <id>` links a work cycle
      // to its spec; `prjct ship` reads the linked spec's acceptance
      // criteria as a gate.
      //
      // The structured fields live in `content` as JSON (validated by
      // Zod at the service layer); top-level columns expose what we
      // query on (status, title, timestamps, shipped_pr).
      db.run(`
        CREATE TABLE IF NOT EXISTS specs (
          id              TEXT PRIMARY KEY,
          title           TEXT NOT NULL,
          status          TEXT NOT NULL DEFAULT 'draft',
          content         TEXT NOT NULL,
          tags            TEXT,
          created_at      TEXT NOT NULL,
          updated_at      TEXT NOT NULL,
          shipped_at      TEXT,
          shipped_pr      INTEGER,
          archived_at     TEXT
        );

        CREATE INDEX IF NOT EXISTS idx_specs_status ON specs(status);
        CREATE INDEX IF NOT EXISTS idx_specs_created ON specs(created_at);
      `)

      // Link tasks → specs. Nullable: tasks without a spec keep working.
      try {
        db.run('ALTER TABLE tasks ADD COLUMN linked_spec_id TEXT')
        db.run('CREATE INDEX IF NOT EXISTS idx_tasks_spec ON tasks(linked_spec_id)')
      } catch {
        // Column may already exist (re-run safety)
      }
    },
  },
  {
    version: 17,
    name: 'sync-engine-wire-format',
    up: (db: SqliteDatabase) => {
      // Phase 1.5 (B5): extend the events table with the wire-format
      // columns prjct-cloud expects. All additions are nullable / have
      // safe defaults so pre-1.5 events keep deserializing — applyEvent
      // tolerates NULL for these fields.
      //
      // Columns (all ALTER ADD, idempotent on rerun):
      //   server_event_id   — monotonic id assigned by prjct-cloud after
      //                       push. NULL until synced. Used as pull cursor.
      //   entity_type       — canonical entity (tasks, ideas, memories,
      //                       …); empty for legacy rows.
      //   entity_id         — id of the entity referenced; empty for legacy.
      //   event_type        — 'upsert' | 'delete'; empty for legacy.
      //   device_id         — UUIDv4 of the device emitting this event.
      //   origin_device_id  — UUIDv4 of the first creator's device.
      //   content_hash      — sha256(payload). Idempotency key for
      //                       applyEvent + last-write-wins desempata.
      //   revision_count    — per-entity revision counter, increments on
      //                       every update. Defaults to 1.
      const columns: Array<[string, string]> = [
        ['server_event_id', 'INTEGER'],
        ['entity_type', 'TEXT'],
        ['entity_id', 'TEXT'],
        ['event_type', 'TEXT'],
        ['device_id', 'TEXT'],
        ['origin_device_id', 'TEXT'],
        ['content_hash', 'TEXT'],
        ['revision_count', 'INTEGER NOT NULL DEFAULT 1'],
      ]
      for (const [name, decl] of columns) {
        try {
          db.run(`ALTER TABLE events ADD COLUMN ${name} ${decl}`)
        } catch {
          // Column may already exist (re-run safety)
        }
      }
      try {
        db.run('CREATE INDEX IF NOT EXISTS idx_events_server_id ON events(server_event_id)')
        db.run('CREATE INDEX IF NOT EXISTS idx_events_entity ON events(entity_type, entity_id)')
        db.run('CREATE INDEX IF NOT EXISTS idx_events_device ON events(device_id)')
      } catch {
        // Index may already exist
      }

      // Phase 1.5 (B3): durable, concurrency-safe pending queue. Replaces
      // sync/pending.json. Append + clear are transactional — WS apply
      // and CLI publish can race without losing events.
      //
      // Each row holds a serialized SyncEvent (JSON) plus the entity
      // metadata so we can dedupe by (entity_type, entity_id) when the
      // server confirms a partial batch.
      db.run(`
        CREATE TABLE IF NOT EXISTS sync_pending (
          id              INTEGER PRIMARY KEY AUTOINCREMENT,
          project_id      TEXT NOT NULL,
          entity_type     TEXT,
          entity_id       TEXT,
          event_type      TEXT,
          content_hash    TEXT,
          payload         TEXT NOT NULL,
          enqueued_at     TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_sync_pending_project ON sync_pending(project_id);
        CREATE INDEX IF NOT EXISTS idx_sync_pending_entity ON sync_pending(entity_type, entity_id);
      `)

      // Phase 1.5 (B4): sync_cursors per (user_id, device_id, project_id).
      // Replaces last-sync.json. Pull uses last_event_id (server's
      // monotonic id), not timestamp — so clock skew between devices no
      // longer skips events.
      //
      // last_event_id is the highest server_event_id we have applied
      // locally for THIS tuple. user_id may be NULL for projects shipped
      // before the user authenticated (cleaned up at first auth).
      db.run(`
        CREATE TABLE IF NOT EXISTS sync_cursors (
          user_id         TEXT,
          device_id       TEXT NOT NULL,
          project_id      TEXT NOT NULL,
          last_event_id   INTEGER NOT NULL DEFAULT 0,
          updated_at      TEXT NOT NULL,
          PRIMARY KEY (user_id, device_id, project_id)
        );

        CREATE INDEX IF NOT EXISTS idx_sync_cursors_project ON sync_cursors(project_id);
      `)
    },
  },
  {
    version: 18,
    name: 'specs-shipped-sha',
    up: (db: SqliteDatabase) => {
      // Phase 1.6 (B-DRIFT-ANCHOR): ship() captures the git HEAD sha at
      // ship time. `prjct spec inventory` uses this as the diff base for
      // drift detection — diffing against shipped_at timestamp via
      // `git log --since` is fragile under rebases / squash-merges.
      //
      // Nullable: existing shipped specs predate this migration and
      // simply report drift=unknown until manually re-shipped.
      try {
        db.run('ALTER TABLE specs ADD COLUMN shipped_sha TEXT')
      } catch {
        // Column may already exist (re-run safety)
      }
    },
  },
  {
    version: 19,
    name: 'sync-applied-hashes',
    up: (db: SqliteDatabase) => {
      // Phase 1.6 (B2): persist content_hash per applied entity so
      // applyEvent can short-circuit no-op events instead of re-running
      // the handler upsert. Side table (not a column on entity tables)
      // so we don't have to migrate every entity schema and can evict
      // independently of business state if cleanup is ever needed.
      //
      // PRIMARY KEY guarantees one row per (entity_type, entity_id) —
      // recordApplied does an UPSERT, not an INSERT.
      db.run(`
        CREATE TABLE IF NOT EXISTS sync_applied_hashes (
          entity_type     TEXT NOT NULL,
          entity_id       TEXT NOT NULL,
          content_hash    TEXT NOT NULL,
          applied_at      TEXT NOT NULL,
          PRIMARY KEY (entity_type, entity_id)
        );
      `)
    },
  },
  {
    version: 20,
    name: 'events-type-timestamp-index',
    up: (db: SqliteDatabase) => {
      // Memory recall + memory-service do `WHERE type LIKE 'remember.%'`
      // (or 'memory.%') and `ORDER BY id DESC` on the events table. Without
      // a compound index, SQLite scans the whole table for every recall.
      // With (type, timestamp DESC) the planner can do an index-only range
      // scan + skip the sort entirely.
      db.run('CREATE INDEX IF NOT EXISTS idx_events_type_ts ON events(type, timestamp DESC)')
    },
  },
  {
    version: 21,
    name: 'memories-type-and-fts-backfill',
    up: (db: SqliteDatabase) => {
      // Migration 10 created `memories` + `memories_fts` (FTS5 BM25), but
      // nothing ever wrote to it — memory entries live in the `events`
      // table with type LIKE 'remember.%'. Result: the FTS index is dark
      // and the UserPromptSubmit hook falls back to keyword substring
      // matching over a recency window (the "17th-entry miss").
      //
      // Two-part fix: (1) extend `memories` so it can carry every field a
      // MemoryEntry needs (type, provenance), (2) backfill from events so
      // the FTS index is non-empty on first sync after upgrade. The
      // trigger memories_ai keeps memories_fts in sync as new rows land.
      try {
        db.run('ALTER TABLE memories ADD COLUMN type TEXT')
      } catch {
        // already added
      }
      try {
        db.run('ALTER TABLE memories ADD COLUMN provenance TEXT')
      } catch {
        // already added
      }

      // Backfill from events. NOT EXISTS keeps it idempotent across re-runs.
      // We strip the 'remember.' prefix off `events.type` for the memory
      // type. Tags + content come out of the JSON event payload.
      db.run(`
        INSERT INTO memories
          (id, project_id, title, content, tags, type, provenance, user_triggered,
           created_at, updated_at)
        SELECT
          'mem_' || e.id,
          '_backfill',
          substr(coalesce(json_extract(e.data, '$.content'), ''), 1, 80),
          coalesce(json_extract(e.data, '$.content'), ''),
          coalesce(json_extract(e.data, '$.tags'), '{}'),
          substr(e.type, length('remember.') + 1),
          coalesce(json_extract(e.data, '$.provenance'), 'declared'),
          0,
          e.timestamp,
          e.timestamp
        FROM events e
        WHERE e.type LIKE 'remember.%'
          AND NOT EXISTS (SELECT 1 FROM memories m WHERE m.id = 'mem_' || e.id)
      `)
    },
  },
  {
    version: 22,
    name: 'memory-embeddings-store',
    up: (db: SqliteDatabase) => {
      // Optional semantic-search layer (phase 3). One row per embedded
      // memory entry; the vector is a packed Float32 BLOB. Off by default —
      // populated only when the project opts into an embeddings provider
      // (`config.embeddings`). `model` + `dims` are stored so a model change
      // can invalidate stale vectors. Keyed by the same `mem_<id>` the rest
      // of the memory layer uses.
      db.run(`
        CREATE TABLE IF NOT EXISTS memory_embeddings (
          memory_id   TEXT PRIMARY KEY,
          vector      BLOB NOT NULL,
          model       TEXT NOT NULL,
          dims        INTEGER NOT NULL,
          created_at  TEXT NOT NULL
        )
      `)
    },
  },
  {
    version: 23,
    name: 'memory-usefulness-ledger',
    up: (db: SqliteDatabase) => {
      // Reinforcement ledger: prjct gets smarter with use by tracking which
      // memory entries actually prove useful. A row accumulates a decayed
      // `score` from real usage signals — `ref_count` (a later entry cited
      // this one: load-bearing knowledge) and `fetch_count` (it was pulled by
      // id on purpose). `last_used_at` drives time-decay at read time, so
      // knowledge that stops being used fades from the ranking boost on its
      // own. Recall blends this score so proven-useful entries surface first.
      // Keyed by the same `mem_<id>` as the rest of the memory layer.
      db.run(`
        CREATE TABLE IF NOT EXISTS memory_usefulness (
          memory_id    TEXT PRIMARY KEY,
          score        REAL NOT NULL DEFAULT 0,
          ref_count    INTEGER NOT NULL DEFAULT 0,
          fetch_count  INTEGER NOT NULL DEFAULT 0,
          last_used_at TEXT NOT NULL
        )
      `)
    },
  },
  {
    version: 24,
    name: 'memory-surface-log',
    up: (db: SqliteDatabase) => {
      // Ship-success attribution: which memory entries were SURFACED during a
      // task. `context memory` records the entries it shows here, keyed by the
      // active task; when that task reaches a successful `prjct ship`, every
      // surfaced entry gets a strong usefulness boost — "knowledge that fed
      // work which actually shipped." Rows are deleted once credited, so this
      // stays a small, transient working set. (memory_id, task_id) is unique
      // so a memory is recorded at most once per task.
      db.run(`
        CREATE TABLE IF NOT EXISTS memory_surface_log (
          memory_id   TEXT NOT NULL,
          task_id     TEXT NOT NULL,
          created_at  TEXT NOT NULL,
          PRIMARY KEY (memory_id, task_id)
        )
      `)
    },
  },
  {
    version: 25,
    name: 'memory-dedup-content-hash',
    up: (db: SqliteDatabase) => {
      // Backfill `memories.content_hash` and purge historical verbatim
      // duplicates from BOTH memory tables.
      //
      // Until now nothing populated `memories.content_hash`, and a
      // friction-detector key bug (a 64-char hash compared against a 12-char
      // stored key — they never matched) re-recorded the same user-pushback
      // every session, leaving 5-9 identical copies per signal. Those dups
      // dilute `searchFts` (reads `memories`) and the vault index (reads
      // `events`), and waste slots in the fixed-size recall-injection budget.
      //
      // Going forward `projectMemory.remember()` dedups on `content_hash`
      // before writing; this migration heals what already landed and seeds the
      // hash on every existing row so that guard recognizes them. Idempotent —
      // safe to re-run (NULL backfill only, keep-earliest is deterministic).
      const numOf = (id: string): number => Number(String(id).replace(/^mem[_-]/i, '')) || 0

      // Parts 1+2 operate on the `memories` table, which is retired in a later
      // migration. Guard so re-running this migration after that drop is a
      // no-op (the events dedup in part 3 is what matters going forward).
      try {
        // 1) Backfill content_hash wherever it's missing.
        const memAll = db.prepare('SELECT id, content, content_hash FROM memories').all() as Array<{
          id: string
          content: string
          content_hash: string | null
        }>
        const setHash = db.prepare('UPDATE memories SET content_hash = ? WHERE id = ?')
        for (const r of memAll) {
          if (!r.content_hash) setHash.run(memoryFingerprint(r.content ?? ''), r.id)
        }

        // 2) Soft-delete duplicate `memories` rows: keep the earliest (smallest
        //    mem_<id>) per (type, content_hash); mark the rest deleted so
        //    searchFts — which filters `deleted_at IS NULL` — stops returning
        //    them. Soft, not hard: the row stays resolvable by id.
        const memLive = db
          .prepare('SELECT id, type, content_hash FROM memories WHERE deleted_at IS NULL')
          .all() as Array<{ id: string; type: string | null; content_hash: string | null }>
        const canonicalMem = new Map<string, number>() // group key -> min numeric id
        for (const r2 of memLive) {
          if (!r2.content_hash) continue
          const k = `${r2.type ?? ''}::${r2.content_hash}`
          const n = numOf(r2.id)
          const cur = canonicalMem.get(k)
          if (cur === undefined || n < cur) canonicalMem.set(k, n)
        }
        const nowIso = new Date().toISOString()
        const softDelete = db.prepare('UPDATE memories SET deleted_at = ? WHERE id = ?')
        for (const r3 of memLive) {
          if (!r3.content_hash) continue
          const k = `${r3.type ?? ''}::${r3.content_hash}`
          if (canonicalMem.get(k) !== numOf(r3.id)) softDelete.run(nowIso, r3.id)
        }
      } catch {
        // `memories` table retired — skip the legacy mirror dedup.
      }

      // 3) Hard-delete duplicate remember-events: keep the earliest per
      //    (type, normalized content). `events` feeds recall() and the vault
      //    index (allEntriesForIndex), neither of which dedups non-keyed
      //    entries — so the dup rows (and the vault files they spawn) only
      //    disappear when the rows do. These are verbatim duplicate signals
      //    with no audit value. ORDER BY id ASC ⇒ first seen = earliest = kept.
      const evRows = db
        .prepare(
          `SELECT id, type, json_extract(data, '$.content') AS content
             FROM events WHERE type LIKE 'memory.remember.%' ORDER BY id ASC`
        )
        .all() as Array<{ id: number; type: string; content: string | null }>
      const seenEv = new Set<string>()
      const delEv = db.prepare('DELETE FROM events WHERE id = ?')
      for (const r4 of evRows) {
        if (r4.content == null) continue
        const k = `${r4.type}::${memoryFingerprint(r4.content)}`
        if (seenEv.has(k)) {
          delEv.run(r4.id)
          continue
        }
        seenEv.add(k)
      }
    },
  },
  {
    version: 26,
    name: 'events-type-id-index',
    up: (db: SqliteDatabase) => {
      // Recall is `… WHERE type LIKE 'memory.remember.%' ORDER BY id DESC`
      // (project-memory.ts recall + allEntriesForIndex) and fires on every
      // UserPromptSubmit hook. Migration 20 added (type, timestamp DESC)
      // INTENDING to serve that ORDER BY — but the sort column is `id`, not
      // `timestamp`, so the planner used the index only for the type range and
      // then ran a separate filesort on `id` every time. This index sorts by
      // the actual ORDER BY column, collapsing the filesort into an ordered
      // index scan. Additive; the old index can stay for timestamp-range use.
      db.run('CREATE INDEX IF NOT EXISTS idx_events_type_id ON events(type, id DESC)')
    },
  },
  {
    version: 27,
    name: 'events-file-tag-column',
    up: (db: SqliteDatabase) => {
      // `recallForFile` (the `prjct guard` / pre-edit anticipation lookup)
      // used to overfetch 500 recall rows and filter by the `file` tag in JS.
      // A virtual generated column exposes the tag to SQL so a partial index
      // covers exactly the file-tagged remember rows — for most projects a
      // few dozen rows instead of a 500-row JSON.parse sweep per lookup.
      // VIRTUAL (not STORED) is required for ALTER TABLE; the CASE guard
      // keeps json_extract off non-remember rows and malformed data.
      db.run(`
        ALTER TABLE events ADD COLUMN file_tag TEXT GENERATED ALWAYS AS (
          CASE
            WHEN type LIKE 'memory.remember.%' AND json_valid(data)
            THEN json_extract(data, '$.tags.file')
          END
        ) VIRTUAL
      `)
      db.run(
        'CREATE INDEX IF NOT EXISTS idx_events_file_tag ON events(file_tag) WHERE file_tag IS NOT NULL'
      )
    },
  },
  {
    version: 28,
    name: 'embedding-norms',
    up: (db: SqliteDatabase) => {
      // semanticSearch divides every cosine score by the row vector's L2
      // norm, which it used to recompute from the unpacked BLOB on every
      // query. Store the norm once at write time instead; the query loop
      // becomes a dot product + one multiply. Backfill computes norms for
      // existing vectors (Float32 little-endian BLOBs) so the column is
      // immediately authoritative.
      db.run('ALTER TABLE memory_embeddings ADD COLUMN norm REAL')
      const rows = db.prepare('SELECT memory_id, vector FROM memory_embeddings').all() as Array<{
        memory_id: string
        vector: Uint8Array
      }>
      const setNorm = db.prepare('UPDATE memory_embeddings SET norm = ? WHERE memory_id = ?')
      for (const r of rows) {
        // Copy for 4-byte alignment — SQLite BLOBs may arrive unaligned.
        const copy = Uint8Array.from(r.vector)
        const v = new Float32Array(copy.buffer, 0, Math.floor(copy.byteLength / 4))
        const sum = v.reduce((total, value) => total + value * value, 0)
        setNorm.run(Math.sqrt(sum), r.memory_id)
      }
    },
  },
  {
    version: 29,
    name: 'fts5-prefix-indexes',
    up: (db: SqliteDatabase) => {
      // searchFts matches every keyword as a PREFIX query (`"kw"*` — see
      // project-memory.ts searchFts), but the FTS table from migration 10
      // had no prefix indexes, so each prefix term scanned the full-term
      // index. FTS5 prefix indexes can only be declared at CREATE time →
      // drop + recreate with prefix='2 3 4' and rebuild from the content
      // table. Trigger bodies identical to migration 10.
      db.run(`
        DROP TRIGGER IF EXISTS memories_ai;
        DROP TRIGGER IF EXISTS memories_ad;
        DROP TRIGGER IF EXISTS memories_au;
        DROP TABLE IF EXISTS memories_fts;

        CREATE VIRTUAL TABLE memories_fts USING fts5(
          title, content, tags,
          content='memories', content_rowid='rowid',
          prefix='2 3 4'
        );

        CREATE TRIGGER memories_ai AFTER INSERT ON memories BEGIN
          INSERT INTO memories_fts(rowid, title, content, tags)
          VALUES (NEW.rowid, NEW.title, NEW.content, NEW.tags);
        END;

        CREATE TRIGGER memories_ad AFTER DELETE ON memories BEGIN
          INSERT INTO memories_fts(memories_fts, rowid, title, content, tags)
          VALUES ('delete', OLD.rowid, OLD.title, OLD.content, OLD.tags);
        END;

        CREATE TRIGGER memories_au AFTER UPDATE ON memories BEGIN
          INSERT INTO memories_fts(memories_fts, rowid, title, content, tags)
          VALUES ('delete', OLD.rowid, OLD.title, OLD.content, OLD.tags);
          INSERT INTO memories_fts(rowid, title, content, tags)
          VALUES (NEW.rowid, NEW.title, NEW.content, NEW.tags);
        END;

        INSERT INTO memories_fts(memories_fts) VALUES ('rebuild');
      `)
    },
  },
  {
    version: 30,
    name: 'perf-samples-table',
    up: (db: SqliteDatabase) => {
      db.run(`
        CREATE TABLE IF NOT EXISTS perf_samples (
          id        INTEGER PRIMARY KEY AUTOINCREMENT,
          metric    TEXT NOT NULL,
          value     REAL,
          unit      TEXT,
          data      TEXT NOT NULL,
          timestamp TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_perf_samples_metric ON perf_samples(metric);
        CREATE INDEX IF NOT EXISTS idx_perf_samples_timestamp ON perf_samples(timestamp);
        CREATE INDEX IF NOT EXISTS idx_perf_samples_metric_timestamp ON perf_samples(metric, timestamp DESC);
      `)
    },
  },
  {
    version: 31,
    name: 'per-file-code-indexes',
    up: (db: SqliteDatabase) => {
      db.run(`
        CREATE TABLE IF NOT EXISTS bm25_documents (
          path       TEXT PRIMARY KEY,
          tokens     TEXT NOT NULL,
          length     INTEGER NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS bm25_terms (
          token TEXT NOT NULL,
          path  TEXT NOT NULL,
          tf    INTEGER NOT NULL,
          PRIMARY KEY (token, path)
        );

        CREATE INDEX IF NOT EXISTS idx_bm25_terms_path ON bm25_terms(path);

        CREATE TABLE IF NOT EXISTS import_graph_edges (
          from_path  TEXT NOT NULL,
          to_path    TEXT NOT NULL,
          sort_order INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (from_path, to_path)
        );

        CREATE INDEX IF NOT EXISTS idx_import_graph_edges_to ON import_graph_edges(to_path);
      `)
    },
  },
  {
    version: 32,
    name: 'import-graph-edge-sort-order',
    up: (db: SqliteDatabase) => {
      try {
        db.run('ALTER TABLE import_graph_edges ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0')
      } catch {
        // Column may already exist from migration 31 on fresh databases.
      }
    },
  },
  {
    version: 33,
    name: 'task-pipeline-state',
    up: (db: SqliteDatabase) => {
      db.run(`
        CREATE TABLE IF NOT EXISTS task_pipeline_state (
          project_id           TEXT NOT NULL,
          task_id              TEXT NOT NULL,
          workspace_id         TEXT NOT NULL,
          classification       TEXT NOT NULL,
          station              TEXT NOT NULL,
          requires_spec        INTEGER NOT NULL DEFAULT 0,
          requires_tests_first INTEGER NOT NULL DEFAULT 0,
          reason               TEXT NOT NULL,
          linked_spec_id       TEXT,
          created_at           TEXT NOT NULL,
          updated_at           TEXT NOT NULL,
          PRIMARY KEY (project_id, task_id, workspace_id)
        );

        CREATE INDEX IF NOT EXISTS idx_task_pipeline_state_workspace
          ON task_pipeline_state(project_id, workspace_id, updated_at);
      `)
    },
  },
  {
    version: 34,
    name: 'retrieval-eval-labels',
    up: (db: SqliteDatabase) => {
      try {
        db.run('ALTER TABLE memory_surface_log ADD COLUMN query_text TEXT')
      } catch {
        // Column may already exist.
      }
      try {
        db.run('ALTER TABLE memory_surface_log ADD COLUMN surface TEXT')
      } catch {
        // Column may already exist.
      }
      db.run(`
        CREATE TABLE IF NOT EXISTS retrieval_eval_labels (
          id             INTEGER PRIMARY KEY AUTOINCREMENT,
          query_text     TEXT NOT NULL,
          positive_id    TEXT NOT NULL,
          source         TEXT NOT NULL,
          source_task_id TEXT NOT NULL DEFAULT '',
          created_at     TEXT NOT NULL,
          metadata       TEXT NOT NULL DEFAULT '{}'
        )
      `)
      db.run(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_retrieval_eval_labels_unique
          ON retrieval_eval_labels(source, source_task_id, positive_id, query_text)
      `)
      db.run(`
        CREATE INDEX IF NOT EXISTS idx_retrieval_eval_labels_created
          ON retrieval_eval_labels(created_at)
      `)
    },
  },
  {
    version: 35,
    name: 'scrub-literal-friction-evidence',
    up: (db: SqliteDatabase) => {
      const eventRows = db
        .prepare(
          `SELECT id, data FROM events
           WHERE type = 'memory.remember.improvement-signal'
             AND json_valid(data)
             AND json_extract(data, '$.tags.source') = 'friction-detector'
             AND json_extract(data, '$.content') LIKE '%Evidence:%'`
        )
        .all() as Array<{ id: number; data: string }>
      const updateEvent = db.prepare('UPDATE events SET data = ? WHERE id = ?')
      for (const row of eventRows) {
        const cleaned = scrubFrictionEventData(row.data)
        if (cleaned) updateEvent.run(cleaned, row.id)
      }

      // The `memories` mirror is retired in a later migration; guard so a
      // re-run after that drop is a no-op (the events scrub above is what feeds
      // the single-source memory_entries projection).
      try {
        const memoryRows = db
          .prepare(
            `SELECT id, content FROM memories
             WHERE type = 'improvement-signal'
               AND json_extract(tags, '$.source') = 'friction-detector'
               AND content LIKE '%Evidence:%'`
          )
          .all() as Array<{ id: string; content: string }>
        const updateMemory = db.prepare(
          'UPDATE memories SET content = ?, content_hash = ?, updated_at = ? WHERE id = ?'
        )
        const now = new Date().toISOString()
        for (const row2 of memoryRows) {
          const cleaned = stripLiteralFrictionEvidence(row2.content)
          if (cleaned !== row2.content)
            updateMemory.run(cleaned, memoryFingerprint(cleaned), now, row2.id)
        }
      } catch {
        // `memories` table retired — events scrub already covers the source.
      }
    },
  },
  {
    version: 36,
    name: 'sync-applied-hashes-created-at',
    up: (db: SqliteDatabase) => {
      // Per-record origin timestamp on the generic sync side table.
      //
      // `applied_at` already records when THIS machine ingested the event
      // (== synced_at). What was missing is `created_at`: the ORIGIN
      // creation time, authored on whichever machine first produced the
      // entity. Storing both here — instead of a column on every entity
      // table — keeps the created_at/synced_at distinction in one place,
      // applies uniformly to all synced entity types, and avoids churning
      // each business schema.
      //
      // Nullable + backfilled to applied_at: rows that predate this
      // migration have no recorded origin, so their best available
      // approximation is the time we applied them. New rows get the real
      // origin from the wire payload (sync-manager.applyEvent).
      try {
        db.run('ALTER TABLE sync_applied_hashes ADD COLUMN created_at TEXT')
        db.run('UPDATE sync_applied_hashes SET created_at = applied_at WHERE created_at IS NULL')
      } catch {
        // Column may already exist (re-run safety).
      }
    },
  },
  {
    version: 37,
    name: 'schema-v2-tables',
    up: (db: SqliteDatabase) => {
      // Schema v2 — additive foundation for the whole-system relational
      // redesign (prjct = LLM data plane). Creates the normalized tables that
      // later phases backfill → dual-write → cut over to, retiring the JSON
      // blobs. PURELY ADDITIVE: no existing table/column changes, no reads or
      // writes are flipped here, so this is a no-op for current behavior. All
      // timestamps are INTEGER epoch-ms (sortable, no string parse). Parents
      // are created before children; FKs reference existing tables (tasks,
      // specs, llm_analysis, ideas, shipped_features, context_feedback,
      // subtasks) and the new ones below.
      db.run(`
        -- ===== Domain 1: Knowledge (authored memory) =====
        CREATE TABLE IF NOT EXISTS memory_entries (
          id             TEXT PRIMARY KEY,
          project_id     TEXT NOT NULL,
          type           TEXT NOT NULL,
          title          TEXT,
          content        TEXT NOT NULL,
          file           TEXT,
          subject        TEXT,
          provenance     TEXT NOT NULL,
          confidence     REAL,
          content_hash   TEXT NOT NULL,
          topic_key      TEXT,
          user_triggered INTEGER NOT NULL DEFAULT 0,
          revision_count INTEGER NOT NULL DEFAULT 0,
          created_at     INTEGER NOT NULL,
          updated_at     INTEGER NOT NULL,
          deleted_at     INTEGER
        );
        CREATE INDEX IF NOT EXISTS ix_mem_recall ON memory_entries(project_id, type, created_at DESC) WHERE deleted_at IS NULL;
        CREATE INDEX IF NOT EXISTS ix_mem_file ON memory_entries(file) WHERE file IS NOT NULL;
        CREATE INDEX IF NOT EXISTS ix_mem_topic ON memory_entries(topic_key);
        CREATE UNIQUE INDEX IF NOT EXISTS ux_mem_hash ON memory_entries(project_id, content_hash);

        CREATE TABLE IF NOT EXISTS memory_entry_tags (
          entry_id   TEXT NOT NULL REFERENCES memory_entries(id) ON DELETE CASCADE,
          key        TEXT NOT NULL,
          value      TEXT NOT NULL,
          is_machine INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (entry_id, key, value)
        );
        CREATE INDEX IF NOT EXISTS ix_tag_lookup ON memory_entry_tags(key, value) WHERE is_machine = 0;

        CREATE TABLE IF NOT EXISTS memory_links (
          from_entry_id TEXT NOT NULL REFERENCES memory_entries(id) ON DELETE CASCADE,
          to_entry_id   TEXT NOT NULL REFERENCES memory_entries(id) ON DELETE CASCADE,
          relation      TEXT NOT NULL,
          PRIMARY KEY (from_entry_id, to_entry_id, relation)
        );

        -- ===== Domain 2: Synthesis (llm_analysis children) =====
        CREATE TABLE IF NOT EXISTS analysis_finding (
          id          TEXT PRIMARY KEY,
          analysis_id TEXT NOT NULL,
          kind        TEXT NOT NULL,
          title       TEXT NOT NULL,
          detail      TEXT,
          severity    TEXT,
          sort_order  INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS ix_finding ON analysis_finding(analysis_id, kind, sort_order);
        CREATE TABLE IF NOT EXISTS analysis_convention (id TEXT PRIMARY KEY, analysis_id TEXT NOT NULL, rule TEXT, sort_order INTEGER);
        CREATE TABLE IF NOT EXISTS analysis_stack_item (id TEXT PRIMARY KEY, analysis_id TEXT NOT NULL, kind TEXT, name TEXT);
        CREATE TABLE IF NOT EXISTS analysis_command (id TEXT PRIMARY KEY, analysis_id TEXT NOT NULL, name TEXT, command TEXT, purpose TEXT);
        CREATE TABLE IF NOT EXISTS analysis_domain (id TEXT PRIMARY KEY, analysis_id TEXT NOT NULL, name TEXT, paths TEXT);

        -- ===== Domain 3: Specs (children) =====
        CREATE TABLE IF NOT EXISTS spec_acceptance_criterion (id TEXT PRIMARY KEY, spec_id TEXT NOT NULL REFERENCES specs(id) ON DELETE CASCADE, text TEXT, met INTEGER DEFAULT 0, sort_order INTEGER);
        CREATE TABLE IF NOT EXISTS spec_scope (id TEXT PRIMARY KEY, spec_id TEXT NOT NULL REFERENCES specs(id) ON DELETE CASCADE, kind TEXT, item TEXT, sort_order INTEGER);
        CREATE TABLE IF NOT EXISTS spec_risk (id TEXT PRIMARY KEY, spec_id TEXT NOT NULL REFERENCES specs(id) ON DELETE CASCADE, risk TEXT, mitigation TEXT, sort_order INTEGER);
        CREATE TABLE IF NOT EXISTS spec_test_step (id TEXT PRIMARY KEY, spec_id TEXT NOT NULL REFERENCES specs(id) ON DELETE CASCADE, text TEXT, sort_order INTEGER);
        CREATE TABLE IF NOT EXISTS spec_review (id TEXT PRIMARY KEY, spec_id TEXT NOT NULL REFERENCES specs(id) ON DELETE CASCADE, lens TEXT, verdict TEXT, notes TEXT, created_at INTEGER);
        CREATE TABLE IF NOT EXISTS spec_selected_reviewer (spec_id TEXT NOT NULL REFERENCES specs(id) ON DELETE CASCADE, lens TEXT, PRIMARY KEY (spec_id, lens));
        CREATE TABLE IF NOT EXISTS spec_linked_task (spec_id TEXT NOT NULL REFERENCES specs(id) ON DELETE CASCADE, task_id TEXT NOT NULL, PRIMARY KEY (spec_id, task_id));
        CREATE TABLE IF NOT EXISTS spec_tag (spec_id TEXT NOT NULL REFERENCES specs(id) ON DELETE CASCADE, key TEXT, value TEXT, PRIMARY KEY (spec_id, key, value));

        -- ===== Domain 4: Telemetry =====
        CREATE TABLE IF NOT EXISTS agent_runs (
          id            TEXT PRIMARY KEY,
          project_id    TEXT NOT NULL,
          parent_run_id TEXT REFERENCES agent_runs(id),
          work_cycle_id TEXT,
          linked_spec_id TEXT,
          runtime       TEXT,
          model_id      TEXT,
          cli_version   TEXT,
          role          TEXT,
          agent_type    TEXT,
          status        TEXT,
          turns         INTEGER,
          started_at    INTEGER,
          ended_at      INTEGER,
          device_id     TEXT,
          created_at    INTEGER
        );
        CREATE INDEX IF NOT EXISTS ix_runs_cycle ON agent_runs(work_cycle_id);
        CREATE INDEX IF NOT EXISTS ix_runs_parent ON agent_runs(parent_run_id);

        CREATE TABLE IF NOT EXISTS token_usage (
          id               TEXT PRIMARY KEY,
          agent_run_id     TEXT REFERENCES agent_runs(id) ON DELETE CASCADE,
          work_cycle_id    TEXT,
          event_key        TEXT NOT NULL,
          source           TEXT NOT NULL,
          is_estimated     INTEGER NOT NULL DEFAULT 0,
          input_tokens     INTEGER NOT NULL,
          output_tokens    INTEGER NOT NULL,
          cache_read_tokens  INTEGER DEFAULT 0,
          cache_write_tokens INTEGER DEFAULT 0,
          model_id         TEXT,
          measured_at      INTEGER,
          created_at       INTEGER,
          CHECK (input_tokens BETWEEN 0 AND 10000000 AND output_tokens BETWEEN 0 AND 10000000)
        );
        CREATE UNIQUE INDEX IF NOT EXISTS ux_token_event ON token_usage(event_key);
        CREATE INDEX IF NOT EXISTS ix_token_cycle ON token_usage(work_cycle_id);

        CREATE TABLE IF NOT EXISTS agent_artifact (
          agent_run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
          path TEXT NOT NULL,
          op   TEXT NOT NULL,
          count INTEGER,
          PRIMARY KEY (agent_run_id, path, op)
        );

        -- ===== Domain 5/6: task/ship/idea children =====
        CREATE TABLE IF NOT EXISTS subtask_dependency (subtask_id TEXT NOT NULL, depends_on TEXT NOT NULL, PRIMARY KEY (subtask_id, depends_on));
        CREATE TABLE IF NOT EXISTS task_tag (task_id TEXT NOT NULL, key TEXT, value TEXT, PRIMARY KEY (task_id, key, value));
        CREATE TABLE IF NOT EXISTS shipped_feature_tag (feature_id TEXT NOT NULL, key TEXT, value TEXT, PRIMARY KEY (feature_id, key, value));
        CREATE TABLE IF NOT EXISTS idea_tag (idea_id TEXT NOT NULL, key TEXT, value TEXT, PRIMARY KEY (idea_id, key, value));

        -- ===== Domain 9/10: observability + RL =====
        CREATE TABLE IF NOT EXISTS entity_timeline (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, entity_type TEXT, entity_id TEXT, event TEXT, at INTEGER, detail TEXT);
        CREATE INDEX IF NOT EXISTS ix_timeline_entity ON entity_timeline(entity_type, entity_id);
        CREATE TABLE IF NOT EXISTS context_feedback_keyword (feedback_id TEXT NOT NULL, keyword TEXT NOT NULL, PRIMARY KEY (feedback_id, keyword));
        CREATE TABLE IF NOT EXISTS context_feedback_file (feedback_id TEXT NOT NULL, role TEXT NOT NULL, path TEXT NOT NULL, PRIMARY KEY (feedback_id, role, path));

        -- ===== Domain 11: crew + team =====
        CREATE TABLE IF NOT EXISTS crew_runs (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, spec_id TEXT, task_id TEXT, implementer_summary TEXT, reviewer_notes TEXT, verdict TEXT, started_at INTEGER, ended_at INTEGER, created_at INTEGER);
        CREATE TABLE IF NOT EXISTS crew_run_file (run_id TEXT NOT NULL REFERENCES crew_runs(id) ON DELETE CASCADE, path TEXT NOT NULL, op TEXT NOT NULL, PRIMARY KEY (run_id, path, op));
        CREATE TABLE IF NOT EXISTS team_enrollment (project_id TEXT PRIMARY KEY, min_version TEXT, enrolled_at INTEGER, enrolled_by TEXT);

        -- ===== Domain 13: workflows, gates & execution =====
        CREATE TABLE IF NOT EXISTS workflows (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, name TEXT, description TEXT, is_builtin INTEGER, enabled INTEGER, created_at INTEGER, updated_at INTEGER);
        CREATE UNIQUE INDEX IF NOT EXISTS ux_workflows_name ON workflows(project_id, name);
        CREATE TABLE IF NOT EXISTS workflow_config (workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE, key TEXT, value TEXT, PRIMARY KEY (workflow_id, key));
        CREATE TABLE IF NOT EXISTS workflow_rule_condition (rule_id TEXT NOT NULL, kind TEXT, op TEXT, key TEXT, value TEXT, PRIMARY KEY (rule_id, kind, key, value));
        CREATE TABLE IF NOT EXISTS workflow_runs (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, workflow_id TEXT, command TEXT, work_cycle_id TEXT, status TEXT NOT NULL, iteration INTEGER NOT NULL DEFAULT 0, max_iterations INTEGER, started_at INTEGER, ended_at INTEGER);
        CREATE INDEX IF NOT EXISTS ix_wfruns_cycle ON workflow_runs(work_cycle_id);
        CREATE TABLE IF NOT EXISTS workflow_run_step (id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE, rule_id TEXT, seq INTEGER, status TEXT, attempt INTEGER NOT NULL DEFAULT 1, exit_code INTEGER, output TEXT, started_at INTEGER, ended_at INTEGER);
        CREATE TABLE IF NOT EXISTS gate_evaluation (id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE, rule_id TEXT, passed INTEGER NOT NULL, reason TEXT, evaluated_at INTEGER);
      `)
    },
  },
  {
    version: 38,
    name: 'schema-v2-memory-backfill',
    up: (db: SqliteDatabase) => {
      // C1 backfill: populate memory_entries + memory_entry_tags from the
      // existing `memories` mirror so the v2 tables hold the full history (new
      // entries are dual-written live by projectMemory.remember). Pure copy —
      // `memories` stays the source of truth until the read path is cut over.
      // INSERT OR IGNORE skips rows already present / unique-hash collisions.
      try {
        db.run(`
          INSERT OR IGNORE INTO memory_entries
            (id, project_id, type, title, content, file, subject, provenance,
             content_hash, user_triggered, revision_count, created_at, updated_at)
          SELECT
            id, project_id, type,
            COALESCE(title, substr(content, 1, 80)),
            content,
            json_extract(tags, '$.file'),
            json_extract(tags, '$.subject'),
            COALESCE(provenance, 'declared'),
            content_hash,
            COALESCE(user_triggered, 0),
            0,
            CAST(strftime('%s', created_at) AS INTEGER) * 1000,
            CAST(strftime('%s', COALESCE(updated_at, created_at)) AS INTEGER) * 1000
          FROM memories
          WHERE deleted_at IS NULL
            AND content IS NOT NULL
            AND content_hash IS NOT NULL
            AND created_at IS NOT NULL
        `)
      } catch {
        // Best-effort backfill — live dual-write keeps new entries consistent.
      }
      try {
        db.run(`
          INSERT OR IGNORE INTO memory_entry_tags (entry_id, key, value, is_machine)
          SELECT me.id, je.key, je.value,
            CASE WHEN je.key IN (
              'source','session','window_days','window-days','touches','occurrences',
              'phrase','slug','hash','content-hash','content_hash','key','kind',
              'spec-id','spec_id','from','origin','event','task-count','task_count',
              'context-schema','context_schema','synthesis','commit'
            ) THEN 1 ELSE 0 END
          FROM memories m
          JOIN memory_entries me ON me.id = m.id
          JOIN json_each(m.tags) je
          WHERE m.tags IS NOT NULL
            AND json_valid(m.tags)
            AND substr(trim(m.tags), 1, 1) = '{'
            AND je.value IS NOT NULL
        `)
      } catch {
        // Tags are CSV in some legacy rows (not JSON) — those skip cleanly.
      }
    },
  },
  {
    version: 39,
    name: 'schema-v2-events-backfill',
    up: (db: SqliteDatabase) => {
      // Completeness backfill from the AUTHORITATIVE `events` log (the `memories`
      // mirror used by migration 38 can lag events). Makes memory_entries and
      // token_usage complete so the read-path flip never drops rows. INSERT OR
      // IGNORE: latest-first ordering means the newest row per key wins and older
      // duplicates / CHECK-violating corrupt counts skip cleanly. Rows already
      // inserted by migration 38 (same `mem_<id>` PK) are skipped. project_id is
      // read via subquery (one DB == one project); synthetic 'evt_<id>' hash
      // keeps the NOT NULL + unique(project_id, content_hash) constraints happy
      // for completeness-only rows.
      try {
        db.run(`
          INSERT OR IGNORE INTO memory_entries
            (id, project_id, type, title, content, file, subject, provenance,
             content_hash, user_triggered, revision_count, created_at, updated_at)
          SELECT
            'mem_' || e.id,
            (SELECT project_id FROM memories WHERE project_id IS NOT NULL LIMIT 1),
            substr(e.type, length('memory.remember.') + 1),
            substr(json_extract(e.data, '$.content'), 1, 80),
            json_extract(e.data, '$.content'),
            json_extract(e.data, '$.tags.file'),
            json_extract(e.data, '$.tags.subject'),
            COALESCE(json_extract(e.data, '$.provenance'), 'declared'),
            'evt_' || e.id,
            0, 0,
            CAST(strftime('%s', e.timestamp) AS INTEGER) * 1000,
            CAST(strftime('%s', e.timestamp) AS INTEGER) * 1000
          FROM events e
          WHERE e.type >= 'memory.remember.' AND e.type < 'memory.remember/'
            AND json_valid(e.data)
            AND json_extract(e.data, '$.content') IS NOT NULL
            AND (SELECT project_id FROM memories WHERE project_id IS NOT NULL LIMIT 1) IS NOT NULL
          ORDER BY e.id DESC
        `)
      } catch {
        // Best-effort — dual-write keeps new entries consistent.
      }
      // Token usage history from task_tokens events (latest per cycle via DESC).
      try {
        db.run(`
          INSERT OR IGNORE INTO token_usage
            (id, work_cycle_id, event_key, source, is_estimated, input_tokens,
             output_tokens, model_id, measured_at, created_at)
          SELECT
            COALESCE(e.task_id, json_extract(e.data, '$.taskId')) || ':migrated',
            COALESCE(e.task_id, json_extract(e.data, '$.taskId')),
            COALESCE(e.task_id, json_extract(e.data, '$.taskId')) || ':migrated',
            'migrated',
            COALESCE(json_extract(e.data, '$.isEstimated'), 0),
            json_extract(e.data, '$.tokensIn'),
            json_extract(e.data, '$.tokensOut'),
            json_extract(e.data, '$.model'),
            CAST(strftime('%s', e.timestamp) AS INTEGER) * 1000,
            CAST(strftime('%s', e.timestamp) AS INTEGER) * 1000
          FROM events e
          WHERE e.type = 'memory.task_tokens'
            AND json_valid(e.data)
            AND json_extract(e.data, '$.tokensIn') IS NOT NULL
            AND COALESCE(e.task_id, json_extract(e.data, '$.taskId')) IS NOT NULL
          ORDER BY e.id DESC
        `)
      } catch {
        // Best-effort — live dual-write covers new token reports.
      }
    },
  },
  {
    version: 40,
    name: 'schema-v2-memory-entries-trigger',
    up: (db: SqliteDatabase) => {
      // C1 read-flip prerequisite: a trigger that mirrors EVERY memory.remember.*
      // event into memory_entries + memory_entry_tags. This makes the v2 tables
      // the single, always-complete projection of the events log — no matter
      // which path wrote the event (remember(), sync apply, session-cleanup, or
      // a raw appendEvent in tests). With this in place recall can read typed
      // rows with exact parity to the events-based path. INSERT OR IGNORE keeps
      // it inert for rows already backfilled (same mem_<id> PK) and never aborts
      // the originating events insert. project_id is informational (one DB ==
      // one project; recall doesn't filter on it); content_hash is event-unique
      // ('evt_<id>') so each remember event maps 1:1 (matches current recall,
      // which is deduped upstream by remember()'s own guard).
      db.run(`
        CREATE TRIGGER IF NOT EXISTS memory_entries_from_events
        AFTER INSERT ON events
        WHEN NEW.type >= 'memory.remember.' AND NEW.type < 'memory.remember/'
          AND json_valid(NEW.data)
          AND json_extract(NEW.data, '$.content') IS NOT NULL
        BEGIN
          INSERT OR IGNORE INTO memory_entries
            (id, project_id, type, title, content, file, subject, provenance,
             content_hash, user_triggered, revision_count, created_at, updated_at)
          VALUES (
            'mem_' || NEW.id,
            COALESCE((SELECT project_id FROM memories WHERE project_id IS NOT NULL LIMIT 1), 'local'),
            substr(NEW.type, length('memory.remember.') + 1),
            substr(json_extract(NEW.data, '$.content'), 1, 80),
            json_extract(NEW.data, '$.content'),
            json_extract(NEW.data, '$.tags.file'),
            json_extract(NEW.data, '$.tags.subject'),
            COALESCE(json_extract(NEW.data, '$.provenance'), 'declared'),
            'evt_' || NEW.id,
            0, 0,
            CAST(strftime('%s', NEW.timestamp) AS INTEGER) * 1000,
            CAST(strftime('%s', NEW.timestamp) AS INTEGER) * 1000
          );
          INSERT OR IGNORE INTO memory_entry_tags (entry_id, key, value, is_machine)
          SELECT 'mem_' || NEW.id, je.key, je.value,
            CASE WHEN je.key IN (
              'source','session','window_days','window-days','touches','occurrences',
              'phrase','slug','hash','content-hash','content_hash','key','kind',
              'spec-id','spec_id','from','origin','event','task-count','task_count',
              'context-schema','context_schema','synthesis','commit'
            ) THEN 1 ELSE 0 END
          FROM json_each(COALESCE(json_extract(NEW.data, '$.tags'), '{}')) je
          WHERE je.value IS NOT NULL AND je.type != 'object' AND je.type != 'array';
        END;
      `)
    },
  },
  {
    version: 41,
    name: 'schema-v2-memory-entries-correctness',
    up: (db: SqliteDatabase) => {
      // Correctness fix for the v2 memory projection (audit F1–F5): the three
      // population mechanisms (mig 38/39/40) disagreed on hashing, project_id,
      // timestamp precision/source, and the dedup index was type-blind. This
      // rebuilds memory_entries from the AUTHORITATIVE events log in JS — real
      // content fingerprint, real project_id, ms-precision created_at preferring
      // the authored time, full tags — ungated (fixes events-only installs),
      // then installs a corrected trigger for future writes.
      const MACHINE_KEYS = new Set([
        'source',
        'session',
        'window_days',
        'window-days',
        'touches',
        'occurrences',
        'phrase',
        'slug',
        'hash',
        'content-hash',
        'content_hash',
        'key',
        'kind',
        'spec-id',
        'spec_id',
        'from',
        'origin',
        'event',
        'task-count',
        'task_count',
        'context-schema',
        'context_schema',
        'synthesis',
        'commit',
      ])

      // 1. Tear down the old projection + trigger + type-blind unique index.
      try {
        db.run('DROP TRIGGER IF EXISTS memory_entries_from_events')
      } catch {}
      try {
        db.run('DELETE FROM memory_entry_tags')
      } catch {}
      try {
        db.run('DELETE FROM memory_entries')
      } catch {}
      try {
        db.run('DROP INDEX IF EXISTS ux_mem_hash')
      } catch {}
      try {
        db.run(
          'CREATE UNIQUE INDEX IF NOT EXISTS ux_mem_hash ON memory_entries(project_id, content_hash, type)'
        )
      } catch {}

      // 2. Rebuild from events (data.tags is always an object for remember rows).
      const fallbackPid = (() => {
        try {
          const row = db
            .prepare('SELECT project_id FROM memories WHERE project_id IS NOT NULL LIMIT 1')
            .get() as { project_id?: string } | undefined
          return row?.project_id ?? 'local'
        } catch {
          return 'local'
        }
      })()

      const rows = (() => {
        try {
          return db
            .prepare(
              "SELECT id, type, data, timestamp FROM events WHERE type >= 'memory.remember.' AND type < 'memory.remember/' ORDER BY id ASC"
            )
            .all() as Array<{ id: number; type: string; data: string; timestamp: string }>
        } catch {
          return []
        }
      })()

      const insEntry = db.prepare(
        `INSERT OR IGNORE INTO memory_entries
           (id, project_id, type, title, content, file, subject, provenance,
            content_hash, user_triggered, revision_count, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?)`
      )
      const insTag = db.prepare(
        'INSERT OR IGNORE INTO memory_entry_tags (entry_id, key, value, is_machine) VALUES (?, ?, ?, ?)'
      )

      for (const row of rows) {
        const data = (() => {
          try {
            return JSON.parse(row.data) as {
              content?: unknown
              tags?: unknown
              provenance?: unknown
              content_hash?: unknown
              project_id?: unknown
              created_at?: unknown
            }
          } catch {
            return null
          }
        })()
        if (!data) continue
        const content = data.content
        if (typeof content !== 'string' || !content) continue
        const id = `mem_${row.id}`
        const type = String(row.type).slice('memory.remember.'.length)
        const tags =
          data.tags && typeof data.tags === 'object' && !Array.isArray(data.tags)
            ? (data.tags as Record<string, unknown>)
            : {}
        const hash =
          typeof data.content_hash === 'string' ? data.content_hash : memoryFingerprint(content)
        const pid = typeof data.project_id === 'string' ? data.project_id : fallbackPid
        const createdAt =
          (typeof data.created_at === 'string' ? Date.parse(data.created_at) : NaN) ||
          Date.parse(row.timestamp) ||
          0
        try {
          insEntry.run(
            id,
            pid,
            type,
            content.split('\n')[0].slice(0, 80),
            content,
            typeof tags.file === 'string' ? tags.file : null,
            typeof tags.subject === 'string' ? tags.subject : null,
            typeof data.provenance === 'string' ? data.provenance : 'declared',
            hash,
            createdAt,
            createdAt
          )
          for (const [k, v] of Object.entries(tags)) {
            if (v == null) continue
            insTag.run(id, k, String(v), MACHINE_KEYS.has(k) ? 1 : 0)
          }
        } catch {
          // skip a malformed row, keep rebuilding
        }
      }

      // 3. Corrected trigger for future writes: real content_hash/project_id
      // from the event payload, ms-precision created_at preferring the authored
      // time (julianday so sub-second survives), graceful fallbacks.
      db.run(`
        CREATE TRIGGER IF NOT EXISTS memory_entries_from_events
        AFTER INSERT ON events
        WHEN NEW.type >= 'memory.remember.' AND NEW.type < 'memory.remember/'
          AND json_valid(NEW.data)
          AND json_extract(NEW.data, '$.content') IS NOT NULL
        BEGIN
          INSERT OR IGNORE INTO memory_entries
            (id, project_id, type, title, content, file, subject, provenance,
             content_hash, user_triggered, revision_count, created_at, updated_at)
          VALUES (
            'mem_' || NEW.id,
            COALESCE(json_extract(NEW.data, '$.project_id'),
                     (SELECT project_id FROM memories WHERE project_id IS NOT NULL LIMIT 1),
                     'local'),
            substr(NEW.type, length('memory.remember.') + 1),
            substr(json_extract(NEW.data, '$.content'), 1, 80),
            json_extract(NEW.data, '$.content'),
            json_extract(NEW.data, '$.tags.file'),
            json_extract(NEW.data, '$.tags.subject'),
            COALESCE(json_extract(NEW.data, '$.provenance'), 'declared'),
            COALESCE(json_extract(NEW.data, '$.content_hash'), 'evt_' || NEW.id),
            0, 0,
            CAST(ROUND((julianday(COALESCE(json_extract(NEW.data, '$.created_at'), NEW.timestamp)) - 2440587.5) * 86400000) AS INTEGER),
            CAST(ROUND((julianday(COALESCE(json_extract(NEW.data, '$.created_at'), NEW.timestamp)) - 2440587.5) * 86400000) AS INTEGER)
          );
          INSERT OR IGNORE INTO memory_entry_tags (entry_id, key, value, is_machine)
          SELECT 'mem_' || NEW.id, je.key, je.value,
            CASE WHEN je.key IN (
              'source','session','window_days','window-days','touches','occurrences',
              'phrase','slug','hash','content-hash','content_hash','key','kind',
              'spec-id','spec_id','from','origin','event','task-count','task_count',
              'context-schema','context_schema','synthesis','commit'
            ) THEN 1 ELSE 0 END
          FROM json_each(COALESCE(json_extract(NEW.data, '$.tags'), '{}')) je
          WHERE je.value IS NOT NULL AND je.type != 'object' AND je.type != 'array';
        END;
      `)
    },
  },
  {
    version: 42,
    name: 'schema-v2-memory-entries-fts',
    up: (db: SqliteDatabase) => {
      // FTS over the single-source memory_entries (replaces memories_fts). C1
      // search cutover: `prjct search` / searchFts reads this. External-content
      // FTS5 over memory_entries(content, title); kept in sync by triggers on
      // memory_entries so EVERY writer (incl. the session-cleanup direct append
      // that had no FTS row before) is searchable. deleted_at is filtered in the
      // query, not the index.
      try {
        db.run(
          "CREATE VIRTUAL TABLE IF NOT EXISTS memory_entries_fts USING fts5(content, title, content='memory_entries', content_rowid='rowid')"
        )
        db.run(`
          CREATE TRIGGER IF NOT EXISTS memory_entries_fts_ai AFTER INSERT ON memory_entries BEGIN
            INSERT INTO memory_entries_fts(rowid, content, title) VALUES (new.rowid, new.content, new.title);
          END;
        `)
        db.run(`
          CREATE TRIGGER IF NOT EXISTS memory_entries_fts_ad AFTER DELETE ON memory_entries BEGIN
            INSERT INTO memory_entries_fts(memory_entries_fts, rowid, content, title) VALUES('delete', old.rowid, old.content, old.title);
          END;
        `)
        db.run(`
          CREATE TRIGGER IF NOT EXISTS memory_entries_fts_au AFTER UPDATE ON memory_entries BEGIN
            INSERT INTO memory_entries_fts(memory_entries_fts, rowid, content, title) VALUES('delete', old.rowid, old.content, old.title);
            INSERT INTO memory_entries_fts(rowid, content, title) VALUES (new.rowid, new.content, new.title);
          END;
        `)
        // Backfill the index from existing rows.
        db.run("INSERT INTO memory_entries_fts(memory_entries_fts) VALUES('rebuild')")
      } catch {
        // FTS5 unavailable or already built — search degrades to recall; non-fatal.
      }
    },
  },
  {
    version: 43,
    name: 'schema-v2-token-usage-description',
    up: (db: SqliteDatabase) => {
      // C2 single-source: token_usage carries the work-cycle description so the
      // cost report no longer needs to read the memory.task_tokens events for it.
      try {
        db.run('ALTER TABLE token_usage ADD COLUMN description TEXT')
      } catch {
        // Column already exists (re-run safety).
      }
    },
  },
  {
    version: 44,
    name: 'schema-v2-drop-unused-tables',
    up: (db: SqliteDatabase) => {
      // Remove the forward-schema tables migration 37 created that have no
      // writer/reader (dead schema). Keeping only what's actually wired:
      // memory_entries(+tags,+fts), analysis_* (5 child tables, read by
      // getActiveRelational), spec_review + spec_selected_reviewer (the gate),
      // token_usage, and workflow_runs/run_step/gate_evaluation (read by
      // `prjct workflow runs`). Everything else is dropped rather than shipped
      // half-built. FK-children are dropped before their parents.
      const drops = [
        // spec children superseded by the content aggregate (gate keeps review + selected_reviewer)
        'DROP TABLE IF EXISTS spec_acceptance_criterion',
        'DROP TABLE IF EXISTS spec_scope',
        'DROP TABLE IF EXISTS spec_risk',
        'DROP TABLE IF EXISTS spec_test_step',
        'DROP TABLE IF EXISTS spec_linked_task',
        'DROP TABLE IF EXISTS spec_tag',
        // telemetry tables with no writer (agent_sessions still serves)
        'DROP TABLE IF EXISTS agent_artifact',
        'DROP TABLE IF EXISTS agent_runs',
        // entity tag/timeline projections never wired
        'DROP TABLE IF EXISTS subtask_dependency',
        'DROP TABLE IF EXISTS task_tag',
        'DROP TABLE IF EXISTS shipped_feature_tag',
        'DROP TABLE IF EXISTS idea_tag',
        'DROP TABLE IF EXISTS entity_timeline',
        'DROP TABLE IF EXISTS context_feedback_keyword',
        'DROP TABLE IF EXISTS context_feedback_file',
        // crew/team still live in kv_store
        'DROP TABLE IF EXISTS crew_run_file',
        'DROP TABLE IF EXISTS crew_runs',
        'DROP TABLE IF EXISTS team_enrollment',
        // workflows superseded by custom_workflows + workflow_rules
        'DROP TABLE IF EXISTS workflow_config',
        'DROP TABLE IF EXISTS workflow_rule_condition',
        'DROP TABLE IF EXISTS workflows',
        // memory graph never wired
        'DROP TABLE IF EXISTS memory_links',
      ]
      for (const stmt of drops) {
        try {
          db.run(stmt)
        } catch {
          // Best-effort — table may not exist on partial chains.
        }
      }
    },
  },
  {
    version: 45,
    name: 'schema-v2-retire-memories-table',
    up: (db: SqliteDatabase) => {
      // Retire the `memories` mirror for good: nothing writes or reads it now
      // (single source = memory_entries + its FTS). First recreate the
      // memory_entries trigger WITHOUT the `memories` project_id subquery (else
      // dropping memories would break every remember-event insert), then drop
      // memories, its FTS, and its sync triggers.
      try {
        db.run('DROP TRIGGER IF EXISTS memory_entries_from_events')
        db.run(`
          CREATE TRIGGER IF NOT EXISTS memory_entries_from_events
          AFTER INSERT ON events
          WHEN NEW.type >= 'memory.remember.' AND NEW.type < 'memory.remember/'
            AND json_valid(NEW.data)
            AND json_extract(NEW.data, '$.content') IS NOT NULL
          BEGIN
            INSERT OR IGNORE INTO memory_entries
              (id, project_id, type, title, content, file, subject, provenance,
               content_hash, user_triggered, revision_count, created_at, updated_at)
            VALUES (
              'mem_' || NEW.id,
              COALESCE(json_extract(NEW.data, '$.project_id'), 'local'),
              substr(NEW.type, length('memory.remember.') + 1),
              substr(json_extract(NEW.data, '$.content'), 1, 80),
              json_extract(NEW.data, '$.content'),
              json_extract(NEW.data, '$.tags.file'),
              json_extract(NEW.data, '$.tags.subject'),
              COALESCE(json_extract(NEW.data, '$.provenance'), 'declared'),
              COALESCE(json_extract(NEW.data, '$.content_hash'), 'evt_' || NEW.id),
              0, 0,
              CAST(ROUND((julianday(COALESCE(json_extract(NEW.data, '$.created_at'), NEW.timestamp)) - 2440587.5) * 86400000) AS INTEGER),
              CAST(ROUND((julianday(COALESCE(json_extract(NEW.data, '$.created_at'), NEW.timestamp)) - 2440587.5) * 86400000) AS INTEGER)
            );
            INSERT OR IGNORE INTO memory_entry_tags (entry_id, key, value, is_machine)
            SELECT 'mem_' || NEW.id, je.key, je.value,
              CASE WHEN je.key IN (
                'source','session','window_days','window-days','touches','occurrences',
                'phrase','slug','hash','content-hash','content_hash','key','kind',
                'spec-id','spec_id','from','origin','event','task-count','task_count',
                'context-schema','context_schema','synthesis','commit'
              ) THEN 1 ELSE 0 END
            FROM json_each(COALESCE(json_extract(NEW.data, '$.tags'), '{}')) je
            WHERE je.value IS NOT NULL AND je.type != 'object' AND je.type != 'array';
          END;
        `)
      } catch {
        // If recreation fails, keep the existing trigger (don't break inserts).
      }
      for (const stmt of [
        'DROP TRIGGER IF EXISTS memories_ai',
        'DROP TRIGGER IF EXISTS memories_ad',
        'DROP TRIGGER IF EXISTS memories_au',
        'DROP TABLE IF EXISTS memories_fts',
        'DROP TABLE IF EXISTS memories',
      ]) {
        try {
          db.run(stmt)
        } catch {
          // Best-effort teardown.
        }
      }
    },
  },
  {
    version: 46,
    name: 'schema-v2-memory-entries-recapture-and-timestamp-fixes',
    up: (db: SqliteDatabase) => {
      // Line-by-line audit findings, three related bugs in the C1 rebuild
      // (migrations 40/41/45), fixed together:
      //
      // 1. ux_mem_hash was a plain UNIQUE(project_id, content_hash, type) index
      //    with no `deleted_at` awareness. forget() soft-deletes (sets
      //    deleted_at) but leaves the row's (hash, type) slot occupied, so a
      //    later remember() of the identical content passes the dedup guard
      //    (which correctly checks deleted_at IS NULL) but the trigger's
      //    INSERT OR IGNORE then silently collides with the tombstoned row and
      //    drops the recapture — permanently, with no error. Fix: make the
      //    index partial (WHERE deleted_at IS NULL) so a tombstoned row never
      //    blocks a new live row with the same hash/type.
      // 2. The trigger computed created_at/updated_at via julianday(...) with
      //    no validity guard; memory_entries.created_at is NOT NULL and the
      //    insert is INSERT OR IGNORE, so a non-ISO8601 timestamp (e.g. a
      //    legacy-imported event) makes julianday() return NULL, the NOT NULL
      //    violation is silently swallowed, and the memory is never created —
      //    invisible with no error. Fix: COALESCE the computed ms value to
      //    "now" so the insert always has a valid timestamp.
      // 3. Repair any row already corrupted by this: migration 41's one-time
      //    JS backfill defaulted unparseable timestamps to epoch 0 (buried at
      //    the bottom of every recency-ordered recall, effectively
      //    unreachable) instead of a usable fallback.
      try {
        db.run('DROP INDEX IF EXISTS ux_mem_hash')
        db.run(
          `CREATE UNIQUE INDEX IF NOT EXISTS ux_mem_hash
           ON memory_entries(project_id, content_hash, type)
           WHERE deleted_at IS NULL`
        )
      } catch {
        // Best-effort — an existing non-partial index still prevents true dupes.
      }

      try {
        db.run(`
          UPDATE memory_entries
          SET created_at = COALESCE(
                (SELECT CAST(ROUND((julianday(e.timestamp) - 2440587.5) * 86400000) AS INTEGER)
                 FROM events e WHERE 'mem_' || e.id = memory_entries.id),
                CAST(unixepoch() AS INTEGER) * 1000
              ),
              updated_at = COALESCE(
                (SELECT CAST(ROUND((julianday(e.timestamp) - 2440587.5) * 86400000) AS INTEGER)
                 FROM events e WHERE 'mem_' || e.id = memory_entries.id),
                CAST(unixepoch() AS INTEGER) * 1000
              )
          WHERE created_at <= 0
        `)
      } catch {
        // Best-effort repair — a rare edge case, never blocks migration.
      }

      try {
        db.run('DROP TRIGGER IF EXISTS memory_entries_from_events')
        db.run(`
          CREATE TRIGGER IF NOT EXISTS memory_entries_from_events
          AFTER INSERT ON events
          WHEN NEW.type >= 'memory.remember.' AND NEW.type < 'memory.remember/'
            AND json_valid(NEW.data)
            AND json_extract(NEW.data, '$.content') IS NOT NULL
          BEGIN
            INSERT OR IGNORE INTO memory_entries
              (id, project_id, type, title, content, file, subject, provenance,
               content_hash, user_triggered, revision_count, created_at, updated_at)
            VALUES (
              'mem_' || NEW.id,
              COALESCE(json_extract(NEW.data, '$.project_id'), 'local'),
              substr(NEW.type, length('memory.remember.') + 1),
              substr(json_extract(NEW.data, '$.content'), 1, 80),
              json_extract(NEW.data, '$.content'),
              json_extract(NEW.data, '$.tags.file'),
              json_extract(NEW.data, '$.tags.subject'),
              COALESCE(json_extract(NEW.data, '$.provenance'), 'declared'),
              COALESCE(json_extract(NEW.data, '$.content_hash'), 'evt_' || NEW.id),
              0, 0,
              COALESCE(
                CAST(ROUND((julianday(COALESCE(json_extract(NEW.data, '$.created_at'), NEW.timestamp)) - 2440587.5) * 86400000) AS INTEGER),
                CAST(unixepoch() AS INTEGER) * 1000
              ),
              COALESCE(
                CAST(ROUND((julianday(COALESCE(json_extract(NEW.data, '$.created_at'), NEW.timestamp)) - 2440587.5) * 86400000) AS INTEGER),
                CAST(unixepoch() AS INTEGER) * 1000
              )
            );
            INSERT OR IGNORE INTO memory_entry_tags (entry_id, key, value, is_machine)
            SELECT 'mem_' || NEW.id, je.key, je.value,
              CASE WHEN je.key IN (
                'source','session','window_days','window-days','touches','occurrences',
                'phrase','slug','hash','content-hash','content_hash','key','kind',
                'spec-id','spec_id','from','origin','event','task-count','task_count',
                'context-schema','context_schema','synthesis','commit'
              ) THEN 1 ELSE 0 END
            FROM json_each(COALESCE(json_extract(NEW.data, '$.tags'), '{}')) je
            WHERE je.value IS NOT NULL AND je.type != 'object' AND je.type != 'array';
          END;
        `)
      } catch {
        // If recreation fails, keep the existing trigger (don't break inserts).
      }
    },
  },
  {
    version: 47,
    name: 'schema-v2-missing-indexes',
    up: (db: SqliteDatabase) => {
      // Line-by-line/efficiency audit: these child tables were queried by
      // WHERE/JOIN predicates with no supporting index since their creation
      // (migration 37), so every read did a full table scan — growing
      // unbounded since none of these tables prune old rows.
      for (const stmt of [
        // getActiveRelational (llm-analysis-storage.ts) queries all four by
        // analysis_id; only analysis_finding had ix_finding.
        'CREATE INDEX IF NOT EXISTS ix_analysis_convention ON analysis_convention(analysis_id)',
        'CREATE INDEX IF NOT EXISTS ix_analysis_stack_item ON analysis_stack_item(analysis_id)',
        'CREATE INDEX IF NOT EXISTS ix_analysis_command ON analysis_command(analysis_id)',
        'CREATE INDEX IF NOT EXISTS ix_analysis_domain ON analysis_domain(analysis_id)',
        // measuredCyclesFromTokenUsage (work-cost-service.ts) filters + orders
        // by measured_at, run 3x per publishWorkCostSnapshots call; only
        // event_key (unique) and work_cycle_id were indexed.
        'CREATE INDEX IF NOT EXISTS ix_token_measured ON token_usage(measured_at DESC)',
        // getRecentWorkflowRuns (run-recorder.ts) counts steps/gates per run_id;
        // neither child table had an index on its FK.
        'CREATE INDEX IF NOT EXISTS ix_run_step_run ON workflow_run_step(run_id)',
        'CREATE INDEX IF NOT EXISTS ix_gate_eval_run ON gate_evaluation(run_id)',
      ]) {
        try {
          db.run(stmt)
        } catch {
          // Best-effort — a missing index degrades to a scan, never breaks reads.
        }
      }
    },
  },
  {
    version: 48,
    name: 'schema-v2-drop-dangling-agent-runs-fk',
    up: (db: SqliteDatabase) => {
      // token_usage.agent_run_id REFERENCES agent_runs(id), but agent_runs was
      // dropped in migration 44 (never wired to a writer/reader) — a dangling
      // FK to a nonexistent table. Currently inert (PRAGMA foreign_keys is
      // never enabled in this codebase), but every INSERT into token_usage
      // (i.e. every recordTaskTokenUsage call) would silently start failing
      // its typed dual-write the moment FK enforcement is ever turned on.
      // agent_run_id has zero writers/readers in the codebase (grep-verified),
      // so this rebuilds token_usage without it rather than keeping a dead
      // dangling-FK column. SQLite can't ALTER TABLE DROP COLUMN a column
      // that's part of a foreign key, so this is the standard rebuild:
      // create-copy-drop-rename. Deliberately NOT wrapped in try/catch: the
      // migration runner already wraps migration.up(db) in its own
      // transaction (database.ts runImmediate) — letting any statement here
      // throw means the whole rebuild rolls back atomically and the migration
      // stays pending for retry, instead of risking a caught-and-swallowed
      // failure mid-rebuild silently leaving token_usage empty or dropped.
      db.run(`
        CREATE TABLE token_usage_v48 (
          id               TEXT PRIMARY KEY,
          work_cycle_id    TEXT,
          event_key        TEXT NOT NULL,
          source           TEXT NOT NULL,
          is_estimated     INTEGER NOT NULL DEFAULT 0,
          input_tokens     INTEGER NOT NULL,
          output_tokens    INTEGER NOT NULL,
          cache_read_tokens  INTEGER DEFAULT 0,
          cache_write_tokens INTEGER DEFAULT 0,
          model_id         TEXT,
          description      TEXT,
          measured_at      INTEGER,
          created_at       INTEGER,
          CHECK (input_tokens BETWEEN 0 AND 10000000 AND output_tokens BETWEEN 0 AND 10000000)
        )
      `)
      db.run(`
        INSERT INTO token_usage_v48
          (id, work_cycle_id, event_key, source, is_estimated, input_tokens,
           output_tokens, cache_read_tokens, cache_write_tokens, model_id,
           description, measured_at, created_at)
        SELECT id, work_cycle_id, event_key, source, is_estimated, input_tokens,
               output_tokens, cache_read_tokens, cache_write_tokens, model_id,
               description, measured_at, created_at
        FROM token_usage
      `)
      db.run('DROP TABLE token_usage')
      db.run('ALTER TABLE token_usage_v48 RENAME TO token_usage')
      db.run('CREATE UNIQUE INDEX IF NOT EXISTS ux_token_event ON token_usage(event_key)')
      db.run('CREATE INDEX IF NOT EXISTS ix_token_cycle ON token_usage(work_cycle_id)')
      db.run('CREATE INDEX IF NOT EXISTS ix_token_measured ON token_usage(measured_at DESC)')
    },
  },
  {
    version: 49,
    name: 'drop-dead-workflow-rule-cache',
    up: (db: SqliteDatabase) => {
      // `workflow_rule_cache` (created migration-era pre-Schema-v2) has zero
      // readers and zero writers in the codebase — grep-verified, distinctive
      // name so no false positives. The Schema v2 plan flagged it as dead
      // schema to drop; a table with no code path is structural cruft, not a
      // design. Its child index goes with it automatically on DROP TABLE.
      db.run('DROP TABLE IF EXISTS workflow_rule_cache')
    },
  },
  {
    version: 50,
    name: 'drop-legacy-json-migration-tables',
    up: (db: SqliteDatabase) => {
      // `memory` (singular, pre-SQLite KV) and `analysis` (pre-LLM heuristic)
      // were written ONLY by the legacy JSON→SQLite migrator (`migrate-json`,
      // retired in this change) and read by NOTHING — grep-verified zero
      // SELECT anywhere. With their sole writer gone they are pure dead schema.
      // Not to be confused with `memory_entries`/`llm_analysis`, the live v2
      // tables that superseded them.
      db.run('DROP TABLE IF EXISTS memory')
      db.run('DROP TABLE IF EXISTS analysis')
    },
  },
  {
    version: 51,
    name: 'shipped-features-typed-store',
    up: (db: SqliteDatabase) => {
      // Schema v2 C5: ships lived in the `kv_store['shipped']` JSON blob (read
      // + rewritten whole on every ship), while the typed `shipped_features`
      // table — already READ by recall (project-memory) and reporting
      // (product) — was never written, so those surfaces silently returned
      // empty. This migration makes the typed table the single store.
      //
      // Root-cause for the observed 33k-row / 41-real-ship blob: `addShipped`
      // minted a fresh id every call and the sync pull re-applied each ship, so
      // the same ship accreted ~800×. A UNIQUE natural-key index makes the
      // write idempotent (INSERT OR IGNORE) and dedups the backfill.
      db.run(
        'CREATE UNIQUE INDEX IF NOT EXISTS ux_shipped_natural ON shipped_features(name, version, shipped_at)'
      )
      const blob = db.prepare("SELECT data FROM kv_store WHERE key = 'shipped'").get() as
        | { data?: string }
        | undefined
      if (blob?.data) {
        const ships = (() => {
          try {
            const parsed = JSON.parse(blob.data) as { shipped?: unknown }
            return Array.isArray(parsed?.shipped)
              ? (parsed.shipped as Array<Record<string, unknown>>)
              : []
          } catch {
            return []
          }
        })()
        const insert = db.prepare(
          `INSERT OR IGNORE INTO shipped_features
             (id, name, shipped_at, version, description, type, duration, data)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
        for (const s of ships) {
          const id = s.id as string | undefined
          const name = s.name as string | undefined
          const shippedAt = s.shippedAt as string | undefined
          if (!id || !name || !shippedAt) continue
          insert.run(
            id,
            name,
            shippedAt,
            (s.version as string) ?? '',
            (s.description as string) ?? null,
            (s.type as string) ?? null,
            (s.duration as string) ?? null,
            JSON.stringify(s)
          )
        }
      }
      // Retire the legacy blob — the typed table is now the source of truth.
      db.run("DELETE FROM kv_store WHERE key = 'shipped'")
    },
  },
  {
    version: 52,
    name: 'metrics-typed-store',
    up: (db: SqliteDatabase) => {
      // Schema v2: sync metrics lived in the `kv_store['metrics']` JSON blob
      // while the typed `metrics_daily` table — already SUMmed by `prjct
      // product` for the value score — was never written, so those stats read
      // 0 forever. This makes the typed tables the single store:
      //   - metrics_daily       daily rows (existing table; now the only store)
      //   - metrics_agent_usage per-agent counters (agentUsage[] normalized)
      // Derivable totals (totalTokensSaved/syncCount/averages/firstSync) become
      // SQL aggregates; `watchTriggers` had zero readers and is dropped.
      db.run(
        `CREATE TABLE IF NOT EXISTS metrics_agent_usage (
           agent_name   TEXT PRIMARY KEY,
           usage_count  INTEGER NOT NULL DEFAULT 0,
           tokens_saved INTEGER NOT NULL DEFAULT 0
         )`
      )
      const blob = db.prepare("SELECT data FROM kv_store WHERE key = 'metrics'").get() as
        | { data?: string }
        | undefined
      if (blob?.data) {
        const parsed = (() => {
          try {
            return JSON.parse(blob.data) as {
              dailyStats?: Array<Record<string, unknown>>
              agentUsage?: Array<Record<string, unknown>>
              totalTokensSaved?: number
              syncCount?: number
              totalSyncDuration?: number
              avgCompressionRate?: number
              firstSync?: string
            }
          } catch {
            return {}
          }
        })()
        const daily = Array.isArray(parsed.dailyStats) ? parsed.dailyStats : []
        const insertDay = db.prepare(
          `INSERT OR IGNORE INTO metrics_daily
             (date, tokens_saved, syncs, avg_compression_rate, total_duration)
           VALUES (?, ?, ?, ?, ?)`
        )
        const [dailyTokens, dailySyncs, dailyDuration] = daily.reduce<[number, number, number]>(
          (totals, d) => {
            const date = d.date as string | undefined
            if (!date) return totals
            const tokens = Number(d.tokensSaved) || 0
            const syncs = Number(d.syncs) || 0
            const duration = Number(d.totalDuration) || 0
            insertDay.run(date, tokens, syncs, Number(d.avgCompressionRate) || 0, duration)
            return [totals[0] + tokens, totals[1] + syncs, totals[2] + duration]
          },
          [0, 0, 0]
        )
        // The blob kept RUNNING totals but trimmed dailyStats to 90 days, so
        // lifetime totals can exceed the daily sum. Preserve the difference in
        // one synthetic "pre-history" row dated at firstSync (or epoch) so SQL
        // aggregates still reproduce the true lifetime numbers.
        const remTokens = Math.max(0, (Number(parsed.totalTokensSaved) || 0) - dailyTokens)
        const remSyncs = Math.max(0, (Number(parsed.syncCount) || 0) - dailySyncs)
        const remDuration = Math.max(0, (Number(parsed.totalSyncDuration) || 0) - dailyDuration)
        if (remTokens > 0 || remSyncs > 0) {
          const preDate = (parsed.firstSync || '1970-01-01T00:00:00.000Z').split('T')[0]
          insertDay.run(
            preDate,
            remTokens,
            remSyncs,
            Number(parsed.avgCompressionRate) || 0,
            remDuration
          )
        }
        const agents = Array.isArray(parsed.agentUsage) ? parsed.agentUsage : []
        const insertAgent = db.prepare(
          `INSERT OR IGNORE INTO metrics_agent_usage (agent_name, usage_count, tokens_saved)
           VALUES (?, ?, ?)`
        )
        for (const a of agents) {
          const name = a.agentName as string | undefined
          if (!name) continue
          insertAgent.run(name, Number(a.usageCount) || 0, Number(a.tokensSaved) || 0)
        }
      }
      db.run("DELETE FROM kv_store WHERE key = 'metrics'")
    },
  },
  {
    version: 53,
    name: 'queue-typed-store',
    up: (db: SqliteDatabase) => {
      // Schema v2: the GTD queue lived in the `kv_store['queue']` JSON blob —
      // parsed WHOLE on every prompt (hooks/prompt.ts reads active tasks per
      // UserPromptSubmit; the blob measured 1.08MB on the reference project)
      // and rewritten whole on every mutation — while the typed `queue_tasks`
      // table sat empty. This makes the typed table the single store.
      // Columns for QueueTask fields the original table lacked:
      for (const col of ['body TEXT', 'agent TEXT', 'group_name TEXT', 'group_id TEXT']) {
        try {
          db.run(`ALTER TABLE queue_tasks ADD COLUMN ${col}`)
        } catch {
          /* column already exists */
        }
      }
      db.run(
        'CREATE INDEX IF NOT EXISTS ix_queue_section ON queue_tasks(section, completed, created_at)'
      )
      const blob = db.prepare("SELECT data FROM kv_store WHERE key = 'queue'").get() as
        | { data?: string }
        | undefined
      if (blob?.data) {
        const tasks = (() => {
          try {
            const parsed = JSON.parse(blob.data) as { tasks?: unknown }
            return Array.isArray(parsed?.tasks)
              ? (parsed.tasks as Array<Record<string, unknown>>)
              : []
          } catch {
            return []
          }
        })()
        const insert = db.prepare(
          `INSERT OR IGNORE INTO queue_tasks
             (id, description, type, priority, section, created_at, completed, completed_at,
              feature_id, feature_name, body, agent, group_name, group_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        for (const t of tasks) {
          const id = t.id as string | undefined
          const description = t.description as string | undefined
          // Deliberate: skip empty-description rows. On the reference project
          // 6,046 of 6,105 blob entries were EMPTY tasks accreted by the sync
          // handler's `description || ''` (now guarded at the handler) — junk
          // no consumer can use; only the real tasks migrate.
          if (!id || !description) continue
          insert.run(
            id,
            description,
            (t.type as string) ?? null,
            (t.priority as string) ?? null,
            (t.section as string) ?? 'backlog',
            (t.createdAt as string) ?? '1970-01-01T00:00:00.000Z',
            t.completed ? 1 : 0,
            (t.completedAt as string) ?? null,
            (t.featureId as string) ?? null,
            (t.originFeature as string) ?? null,
            (t.body as string) ?? null,
            (t.agent as string) ?? null,
            (t.groupName as string) ?? null,
            (t.groupId as string) ?? null
          )
        }
      }
      db.run("DELETE FROM kv_store WHERE key = 'queue'")
    },
  },
  {
    version: 54,
    name: 'velocity-restored-and-dev-evolution',
    up: (db: SqliteDatabase) => {
      // Velocity's write path had been amputated (saveMetrics had zero
      // callers; readers always got defaults). Restored: sprints are now
      // COMPUTED from the typed tables (tasks.completed_at +
      // shipped_features.shipped_at) and persisted into the existing
      // `velocity_sprints` table on every sync. The kv blob only ever held
      // defaults — retire it.
      db.run("DELETE FROM kv_store WHERE key = 'velocity'")

      // Developer evolution: weekly typed snapshots of what the agent has
      // learned about the developer (preference/friction/knowledge counts +
      // delivery numbers) with a generated one-line summary. Evolution =
      // SELECT over snapshots ordered by week. Granular facts stay in
      // memory_entries; this is the queryable rollup.
      db.run(
        `CREATE TABLE IF NOT EXISTS developer_profile_snapshots (
           week               INTEGER PRIMARY KEY,  -- epoch-week (one snapshot per ISO week)
           captured_at        TEXT NOT NULL,
           preferences        INTEGER NOT NULL DEFAULT 0,  -- feedback-type entries (lifetime)
           frictions          INTEGER NOT NULL DEFAULT 0,  -- improvement-signals (lifetime)
           decisions_7d       INTEGER NOT NULL DEFAULT 0,
           gotchas_7d         INTEGER NOT NULL DEFAULT 0,
           learnings_7d       INTEGER NOT NULL DEFAULT 0,
           tasks_completed_7d INTEGER NOT NULL DEFAULT 0,
           ships_7d           INTEGER NOT NULL DEFAULT 0,
           velocity_avg       REAL NOT NULL DEFAULT 0,
           summary            TEXT NOT NULL
         )`
      )
    },
  },
  {
    version: 55,
    name: 'ideas-typed-store-and-orphan-cleanup',
    up: (db: SqliteDatabase) => {
      // Schema v2: ideas lived in the `kv_store['ideas']` blob while the
      // typed `ideas` table sat empty. Backfill (INSERT OR IGNORE on the id
      // PK) and retire the key. Extended fields ride the cold columns.
      const blob = db.prepare("SELECT data FROM kv_store WHERE key = 'ideas'").get() as
        | { data?: string }
        | undefined
      if (blob?.data) {
        const ideas = (() => {
          try {
            const parsed = JSON.parse(blob.data) as { ideas?: unknown }
            return Array.isArray(parsed?.ideas)
              ? (parsed.ideas as Array<Record<string, unknown>>)
              : []
          } catch {
            return []
          }
        })()
        const insert = db.prepare(
          `INSERT OR IGNORE INTO ideas
             (id, text, status, priority, tags, added_at, converted_to, details, data)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        for (const i of ideas) {
          const id = i.id as string | undefined
          const text = i.text as string | undefined
          if (!id || !text) continue
          const extras: Record<string, unknown> = {}
          for (const k of ['painPoints', 'solutions', 'filesAffected', 'impactEffort']) {
            if (i[k] !== undefined) extras[k] = i[k]
          }
          insert.run(
            id,
            text,
            (i.status as string) ?? 'pending',
            (i.priority as string) ?? 'medium',
            Array.isArray(i.tags) && i.tags.length ? JSON.stringify(i.tags) : null,
            (i.addedAt as string) ?? '1970-01-01T00:00:00.000Z',
            (i.convertedTo as string) ?? null,
            (i.details as string) ?? null,
            Object.keys(extras).length ? JSON.stringify(extras) : null
          )
        }
      }
      db.run("DELETE FROM kv_store WHERE key = 'ideas'")

      // Orphan kv keys with zero readers (grep-verified):
      //  - 'memory:patterns'          — exists in real DBs, zero code refs
      //  - 'analysis:derived-rules:*' — write-only rows nobody reads; sweep
      //    the accumulated ones (one per repo-path hash).
      db.run("DELETE FROM kv_store WHERE key = 'memory:patterns'")
      db.run("DELETE FROM kv_store WHERE key LIKE 'analysis:derived-rules:%'")
    },
  },
  {
    version: 56,
    name: 'task-history-typed',
    up: (db: SqliteDatabase) => {
      // Schema v2 (C4, history slice): completed-task history lived as a
      // FIFO-capped list inside the `kv_store['state']` blob. History reads
      // now come from the typed `tasks` table (completion writes it via
      // mirrorHistoryEntry). Backfill the blob's entries, then strip
      // `taskHistory` from the blob — the live state machine
      // (currentTask/pausedTasks/activeTasks) stays there for now.
      const blob = db.prepare("SELECT data FROM kv_store WHERE key = 'state'").get() as
        | { data?: string }
        | undefined
      if (!blob?.data) return
      const state = (() => {
        try {
          return JSON.parse(blob.data) as Record<string, unknown>
        } catch {
          return null
        }
      })()
      if (!state) return
      const history = Array.isArray(state.taskHistory)
        ? (state.taskHistory as Array<Record<string, unknown>>)
        : []
      const insert = db.prepare(
        `INSERT OR IGNORE INTO tasks
           (id, description, type, status, branch, linear_id, pr_url, started_at, completed_at, tokens_in, tokens_out, data)
         VALUES (?, ?, ?, 'completed', ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      for (const h of history) {
        const taskId = h.taskId as string | undefined
        const title = h.title as string | undefined
        if (!taskId || !title) continue
        insert.run(
          taskId,
          title,
          (h.classification as string) ?? 'improvement',
          h.branchName === 'unknown' ? null : ((h.branchName as string) ?? null),
          (h.linearId as string) ?? null,
          (h.prUrl as string) ?? null,
          (h.startedAt as string) ?? '1970-01-01T00:00:00.000Z',
          (h.completedAt as string) ?? '1970-01-01T00:00:00.000Z',
          Number(h.tokensIn) || 0,
          Number(h.tokensOut) || 0,
          JSON.stringify({
            title,
            outcome: h.outcome,
            subtaskCount: h.subtaskCount ?? 0,
            subtaskSummaries: h.subtaskSummaries ?? [],
            feedback: h.feedback,
            harness: h.harness,
            linearUuid: h.linearUuid,
          })
        )
      }
      if (history.length > 0 || 'taskHistory' in state) {
        const { taskHistory: _dropped, ...rest } = state
        db.prepare("UPDATE kv_store SET data = ? WHERE key = 'state'").run(JSON.stringify(rest))
      }
    },
  },
  {
    version: 57,
    name: 'skill-registry',
    up: (db: SqliteDatabase) => {
      // Skill index ("index of paths, not summaries"): the catalog of
      // available agent skills (project + global roots), refreshed on sync.
      // Orchestrators resolve it once and pass EXACT SKILL.md paths to
      // subagents so the author's intent is never distorted by a digest.
      db.run(
        `CREATE TABLE IF NOT EXISTS skill_registry (
           name        TEXT PRIMARY KEY,
           description TEXT NOT NULL DEFAULT '',
           path        TEXT NOT NULL,
           scope       TEXT NOT NULL DEFAULT 'global',  -- project|global (project wins)
           indexed_at  INTEGER NOT NULL
         )`
      )
    },
  },
  {
    version: 58,
    name: 'cli-sessions-typed-and-dead-sessions-drop',
    up: (db: SqliteDatabase) => {
      // Schema v2: the CLI session tracker lived in kv_store['session-tracker']
      // — read-modify-written (whole command history included) up to 3x per
      // CLI command. Typed replacement: cli_sessions + append-only
      // cli_session_commands. The blob held only the CURRENT ~30-min session
      // (ephemeral); no backfill needed — retire the key.
      db.run(
        `CREATE TABLE IF NOT EXISTS cli_sessions (
           id            TEXT PRIMARY KEY,
           status        TEXT NOT NULL DEFAULT 'active',
           created_at    TEXT NOT NULL,
           last_activity TEXT NOT NULL
         )`
      )
      db.run(
        'CREATE INDEX IF NOT EXISTS ix_cli_sessions_active ON cli_sessions(status, last_activity DESC)'
      )
      db.run(
        `CREATE TABLE IF NOT EXISTS cli_session_commands (
           session_id  TEXT NOT NULL,
           command     TEXT NOT NULL,
           timestamp   TEXT NOT NULL,
           duration_ms INTEGER NOT NULL DEFAULT 0
         )`
      )
      db.run(
        'CREATE INDEX IF NOT EXISTS ix_cli_session_commands ON cli_session_commands(session_id, timestamp)'
      )
      db.run("DELETE FROM kv_store WHERE key = 'session-tracker'")

      // The v7-era `sessions` table (task-lifecycle sessions) has ZERO readers
      // and writers — grep-verified dead schema, superseded by the typed
      // `tasks` history. Drop it.
      db.run('DROP TABLE IF EXISTS sessions')
    },
  },
  {
    version: 59,
    name: 'work-graph',
    up: (db: SqliteDatabase) => {
      // The work graph (harness research 2026-07: beads + Task Master + BMAD
      // all converge on this organ): typed edges between work items, a
      // ready-frontier computed structurally instead of re-read from prose,
      // atomic claiming for multi-agent fan-out, and a persisted
      // complexity/decomposition record written at triage time.
      db.run(
        `CREATE TABLE IF NOT EXISTS work_dependencies (
           from_id    TEXT NOT NULL,
           to_id      TEXT NOT NULL,
           dep_type   TEXT NOT NULL DEFAULT 'blocks'
                      CHECK (dep_type IN ('blocks', 'parent', 'related', 'discovered-from')),
           created_at TEXT NOT NULL,
           PRIMARY KEY (from_id, to_id, dep_type)
         )`
      )
      db.run('CREATE INDEX IF NOT EXISTS ix_workdeps_to ON work_dependencies(to_id)')
      db.run(
        `CREATE TABLE IF NOT EXISTS task_complexity (
           task_id              TEXT PRIMARY KEY,
           score                INTEGER NOT NULL,
           recommended_subtasks INTEGER NOT NULL DEFAULT 0,
           expansion_prompt     TEXT,
           reasoning            TEXT,
           created_at           TEXT NOT NULL
         )`
      )
      try {
        db.run('ALTER TABLE queue_tasks ADD COLUMN claimed_by TEXT')
        db.run('ALTER TABLE queue_tasks ADD COLUMN claimed_at TEXT')
      } catch {
        /* re-run safety */
      }
    },
  },
  {
    version: 60,
    name: 'task-journal-and-briefs',
    up: (db: SqliteDatabase) => {
      // Tier 2 (harness research): the append-only per-task implementation
      // journal (Task Master's update-subtask — "what did the last agent
      // try") and the compiled context brief (BMAD's story-context — a
      // curated, persisted artifact instead of ad-hoc retrieval).
      db.run(
        `CREATE TABLE IF NOT EXISTS task_log (
           id         INTEGER PRIMARY KEY AUTOINCREMENT,
           task_id    TEXT NOT NULL,
           session_id TEXT,
           content    TEXT NOT NULL,
           created_at TEXT NOT NULL
         )`
      )
      db.run('CREATE INDEX IF NOT EXISTS ix_task_log ON task_log(task_id, id DESC)')
      db.run(
        `CREATE TABLE IF NOT EXISTS task_briefs (
           task_id    TEXT PRIMARY KEY,
           content    TEXT NOT NULL,
           created_at TEXT NOT NULL
         )`
      )
    },
  },
  {
    version: 61,
    name: 'task-handoffs',
    up: (db: SqliteDatabase) => {
      // Multi-agent realtime yield/accept bus: when one rig gets stuck,
      // `prjct switch <agent>` writes a durable handoff; the target pulls
      // via hooks or `prjct accept`. Who started + why yield live here.
      db.run(
        `CREATE TABLE IF NOT EXISTS task_handoffs (
           id               TEXT PRIMARY KEY,
           project_id       TEXT NOT NULL,
           task_id          TEXT NOT NULL,
           task_description TEXT NOT NULL,
           from_agent       TEXT NOT NULL,
           from_identity    TEXT,
           to_agent         TEXT NOT NULL,
           reason           TEXT NOT NULL,
           evidence         TEXT,
           status           TEXT NOT NULL DEFAULT 'pending'
                            CHECK (status IN ('pending', 'accepted', 'expired', 'cancelled')),
           workspace_id     TEXT,
           worktree_path    TEXT,
           branch           TEXT,
           created_at       TEXT NOT NULL,
           accepted_at      TEXT,
           accepted_by      TEXT,
           expires_at       TEXT
         )`
      )
      db.run(
        'CREATE INDEX IF NOT EXISTS ix_task_handoffs_pending ON task_handoffs(project_id, status, to_agent)'
      )
      db.run('CREATE INDEX IF NOT EXISTS ix_task_handoffs_task ON task_handoffs(task_id)')
    },
  },
  {
    version: 62,
    name: 'code-symbol-graph',
    up: (db: SqliteDatabase) => {
      // Structural symbol graph (CBM-inspired, file→symbol layer):
      // definitions + CALLS/DEFINES edges for work-scope, trace, detect_changes.
      db.run(`
        CREATE TABLE IF NOT EXISTS code_symbols (
          id         TEXT PRIMARY KEY,
          file       TEXT NOT NULL,
          kind       TEXT NOT NULL,
          name       TEXT NOT NULL,
          qname      TEXT,
          start_line INTEGER NOT NULL,
          end_line   INTEGER,
          exported   INTEGER NOT NULL DEFAULT 0
        )
      `)
      db.run('CREATE INDEX IF NOT EXISTS idx_code_symbols_name ON code_symbols(name)')
      db.run('CREATE INDEX IF NOT EXISTS idx_code_symbols_file ON code_symbols(file)')
      db.run(
        'CREATE INDEX IF NOT EXISTS idx_code_symbols_name_nocase ON code_symbols(name COLLATE NOCASE)'
      )
      db.run(`
        CREATE TABLE IF NOT EXISTS code_symbol_edges (
          src        TEXT NOT NULL,
          dst        TEXT NOT NULL,
          edge_type  TEXT NOT NULL,
          confidence REAL NOT NULL DEFAULT 1.0,
          PRIMARY KEY (src, dst, edge_type)
        )
      `)
      db.run('CREATE INDEX IF NOT EXISTS idx_code_symbol_edges_dst ON code_symbol_edges(dst)')
      db.run('CREATE INDEX IF NOT EXISTS idx_code_symbol_edges_src ON code_symbol_edges(src)')
    },
  },
  {
    version: 63,
    name: 'project-style-snapshots',
    up: (db: SqliteDatabase) => {
      // Project evolution substrate (symmetric to developer_profile_snapshots):
      // progressive house-style model recalculated on each sync — stack, patterns,
      // conventions, anti-patterns + extensible metrics bag for future measurement.
      db.run(
        `CREATE TABLE IF NOT EXISTS project_style_snapshots (
           id                  TEXT PRIMARY KEY,
           captured_at         TEXT NOT NULL,
           commit_hash         TEXT,
           source              TEXT NOT NULL DEFAULT 'sync-mechanical',
           pattern_count       INTEGER NOT NULL DEFAULT 0,
           anti_pattern_count  INTEGER NOT NULL DEFAULT 0,
           convention_count    INTEGER NOT NULL DEFAULT 0,
           framework_count     INTEGER NOT NULL DEFAULT 0,
           symbol_count        INTEGER NOT NULL DEFAULT 0,
           file_count          INTEGER NOT NULL DEFAULT 0,
           summary             TEXT NOT NULL,
           payload_json        TEXT NOT NULL,
           is_active           INTEGER NOT NULL DEFAULT 0
         )`
      )
      db.run(
        'CREATE INDEX IF NOT EXISTS ix_project_style_active ON project_style_snapshots(is_active, captured_at DESC)'
      )
      db.run(
        'CREATE INDEX IF NOT EXISTS ix_project_style_captured ON project_style_snapshots(captured_at DESC)'
      )
    },
  },
]

export const LATEST_SCHEMA_VERSION = migrations[migrations.length - 1]?.version ?? 0
