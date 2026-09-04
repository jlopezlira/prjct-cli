# Where prjct stores data — and what to commit

A common misconception is that prjct keeps "all project data in a local
`.prjct/` directory." prjct separates a stable repo locator from globally
managed project settings and SQLite state. Mutable policy never belongs in the
client worktree.

## Quickly find your project's `.prjct/` directory

The `.prjct/` directory lives in the **root of your project repo** — it is
created by `prjct init` (or automatically on the first `prjct` command in a git
repo). It is **`.gitignore`d**, which is the usual reason it seems "hidden": it
never shows up in `git status`. Locate it with one of these:

```bash
# From the project root (most common):
ls -la .prjct/
cat .prjct/prjct.config.json          # projectId + dataPath only

# From any subdirectory of the repo — resolve the repo root first:
ls -la "$(git rev-parse --show-toplevel)/.prjct/"
cat "$(git rev-parse --show-toplevel)/.prjct/prjct.config.json"

# Confirm it exists / is initialized (doesn't print the path, just the status):
prjct doctor                           # → "✓ prjct config   initialized"

# Prove why it's invisible to git status:
git check-ignore -v .prjct             # shows the .gitignore rule that hides it
```

Programmatically, the path is always `<repoRoot>/.prjct/` and the config file is
`<repoRoot>/.prjct/prjct.config.json`. In code, prjct resolves it via
`pathManager.getLocalConfigPath(projectPath)` →
`path.join(projectPath, '.prjct', 'prjct.config.json')` (no env var, no global
lookup — it is strictly relative to the project directory).

Reading `prjct.config.json` gives you the stable `projectId` locator. Effective
settings come from `~/.prjct-cli/projects/<projectId>/config.json`.

---

## The three tiers

| Tier | Location | Contents | In git? |
|---|---|---|---|
| **Locator** | `<repo>/.prjct/prjct.config.json` | `projectId`, `dataPath` only | Optional immutable pointer |
| **Project settings** | `~/.prjct-cli/projects/<projectId>/config.json` | persona, modes, budgets, cloud, QA, gauntlet | **No** — prjct-managed |
| **State (source of truth)** | `~/.prjct-cli/projects/<projectId>/prjct.db` | Tasks, memory, events, metrics, analysis — everything | **No** — per-device, never in the repo |

State (SQLite) is the source of truth, and agents read it through tools
(`prjct search` / `context memory` / `guard` / MCP `prjct_*`), not files.
There is no generated markdown export — prjct is the LLM data plane, not a
human-facing document generator; humans consume the data through cloud.

## How to find each path

Resolution lives in `core/infrastructure/path-manager.ts`.

1. **Locator:** `<repo>/.prjct/prjct.config.json`
   (`getLocalConfigPath` → `path.join(projectPath, '.prjct', 'prjct.config.json')`).
2. **Settings:** `~/.prjct-cli/projects/<projectId>/config.json`.
3. **Database:** `~/.prjct-cli/projects/<projectId>/prjct.db`
   (`getGlobalProjectPath` → `<globalBase>/projects/<projectId>`). The global base
   is `~/.prjct-cli` unless **`PRJCT_CLI_HOME`** overrides it.

`PRJCT_CLI_HOME` relocates the **entire** global store (DB + config + sync
metadata) — used for tests, sandboxes, or keeping state off the home volume.

## Why not "everything in `.prjct/`"?

Putting all state in a repo-local directory was the pre-v1.24.1 model and caused
real problems: huge gitignored blobs, JSON corruption under concurrent access,
no cross-repo memory, and merge conflicts on machine-specific data. SQLite as the
single source of truth fixed concurrency and durability.

## Team collaboration & version control

**Optional commit:** `.prjct/prjct.config.json`. It is an immutable locator only;
committing it lets every clone resolve to the same logical project. Changing a
mode, persona, QA command, or budget never rewrites this file.

**Never commit (and prjct never puts in the repo):**

- project **state** — it lives only in per-device SQLite under `~/.prjct-cli`;
- `.prjct-state.md` — generated, user-specific session state (gitignored);
- cloud-sync credentials (`~/.prjct-cli/config/auth.json`).

**So how do teammates share knowledge?** Not through git. prjct's coordination
point is **optional cloud sync**: `prjct login`, then `prjct sync` pushes/pulls
events to the backend (`api.prjct.app`) using monotonic event IDs (not
timestamps), so multiple devices/teammates converge without shared local state
and without git ever carrying project state. Solo users can ignore sync entirely
and stay fully offline — the local SQLite is complete on its own.

## Source references

| Concern | File |
|---|---|
| Global base, project path, config path, `PRJCT_CLI_HOME` | `core/infrastructure/path-manager.ts` |
| What's gitignored | `.gitignore` |
| Cloud sync client + auth | `core/sync/` |
