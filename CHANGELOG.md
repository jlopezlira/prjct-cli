# Changelog

## [Unreleased]

## [3.79.0] - 2026-08-03

### Added
- optimize sync performance and remove dead code

### Fixed

- **Client `.prjct/` is config-only on every sync.** `CHECKPOINTS.md`, `team.json`, ghost dirs, and any other leftover are **migrated to project SQLite first** (checkpoints → `crew:checkpoints`, team → `team:enrollment`, text → remember ingest) then **deleted** from the customer worktree. The only allowed file is `prjct.config.json` — no more "left in place" legacy files.

## [3.78.1] - 2026-07-29

### Bug Fixes

- sync migrates then deletes all client .prjct junk (config-only) (#599)

## [3.78.0] - 2026-07-29

### Features

- steal g-ai v2.2 authority teeth — stamp, candidate hash, kill switch (#598)

## [3.77.0] - 2026-07-28

### Fixed

- **Plans and work data: SQLite only — never physical files.** Templates stopped *instructing* `.prjct/sessions/` writes in v2.19.7, but stale customized agents kept dumping `plan.md` / `impl.md` into client repos (not traceable). Every `prjct sync` now (1) **ingests** text from `.prjct/{sessions,audits,deploy}/` into project SQLite (`prjct remember` context, topic `worktree-ghost-ingest`) then **deletes** those dirs (no re-home onto disk), and (2) **force-refreshes** crew agent files / `CLAUDE.md` / `CREW.md` that still instruct disk writes (including `SESSION_ROOT` / `~/.prjct-cli/**/sessions/` hideouts). Durable surface: `prjct plan` / `prjct spec` / `prjct crew record-run` / `prjct remember` — project SQL only. Only hand-editable file under `.prjct/` is `prjct.config.json`.

## [3.76.1] - 2026-07-22

### Fixed

- login and cloud API defaults: `cli.prjct.app` → `prjct.app`, `cli-api.prjct.app` → `api.prjct.app` (with legacy apiUrl migration)

## [3.76.0] - 2026-07-21

### Features

- bind print-mode runs to work cycles (#595)

## [3.75.0] - 2026-07-21

### Features

- prjct body tools + guard prefix on edit/write (#594)

## [3.74.0] - 2026-07-21

### Features

- owned print-mode agent loop with root-scoped tools (#593)

## [3.73.0] - 2026-07-21

### Features

- multi-brain profiles for owned agent loop foundation (#592)

## [3.72.0] - 2026-07-19

### Added
- Build-loop anticipation: MCP risks, code defaults, ship compound, auto-infer file on remember

## [3.71.0] - 2026-07-19

### Added
- WS1 chokepoint superiority: close gaps vs gentle-ai typed process errors

## [3.70.2] - 2026-07-17

### Bug Fixes

- real upload error details (#588)
- surface real upload error (not fake unauthenticated)

## [3.70.1] - 2026-07-17

### Bug Fixes

- full graph upload — remove 400/900 caps (#587)
- ship full structural graph to cloud — no caps

## [3.70.0] - 2026-07-16

### Added
- OpenCode native MCP installer (`mcp.prjct`) + Pi skill surface on install/doctor

## [3.69.1] - 2026-07-17

### Bug Fixes

- upgrade installs only npm registry version (never monorepo/local)

## [3.69.0] - 2026-07-16

### Added
- fix agent contract: bin verbs + analysis-save JSON preferred across all surfaces

## [3.68.0] - 2026-07-16

### Added
- project style model dual evolution

## [3.67.0] - 2026-07-16

### Added
- project style model dual evolution

## [3.66.0] - 2026-07-16

### Added
- Native Grok host wire + plan ceremony

## [3.65.0] - 2026-07-16

### Added
- context density not session kill; production MCP only

## [3.64.0] - 2026-07-16

### Added
- implement signal quality substrate ws0 p

## [3.63.2] - 2026-07-16

### Bug Fixes

- 10min client timeout for ship/sync and long verbs (#575)

## [3.63.1] - 2026-07-15

### Bug Fixes

- resolve work-cycle entity_id from taskId (#574)

## [3.63.0] - 2026-07-15

### Features

- connect/disconnect + bulk cloud project modes (#573)

## [3.62.0] - 2026-07-14

### Features

- upload compact structural code graph to cloud 3D (#572)

## [3.61.0] - 2026-07-14

### Added
- clean comments readme align

## [3.60.0] - 2026-07-14

### Added
- Structural code symbol graph (CBM-inspired): symbols, trace, impact/hunks, architecture, dead code, per-project cache, Grep|Glob pre-search, CBM auto-fallback
- Harness repositioning — user-facing copy: 'AI Agile OS' → 'The agentic harness for AI coding agents'

## [3.59.1] - 2026-07-14

### Bug Fixes

- bench-ab interleaved A/B reps + confirm pass — kill phantom regressions (#567)

## [3.59.0] - 2026-07-14

### Added
- Tech debt trio: anti-basura capture, multi-install doctor, honest token breakdown
- Anti-basura capture gate (`isJunkCaptureContent`) + dream forgets junk inbox/tool dumps
- Doctor multi-install check; install surfaces parallel copies (`prjct update` consolidates)
- `sumTranscriptUsageDetailed` — cache_read max vs per-turn new input (honest work-cost)

## [3.58.0] - 2026-07-14

### Added
- Fix ship_* retention archive + context-pressure compact path

### Fixed
- Retention/dream: `ship_*` candidates archive via `shipped_features` delete (no more wouldArchive>0 while archived=0)
- Context pressure: warn (≥60%) is hard compact-path (land→prime); Claude statusline shows `→land` at ≥60% host context

## [3.57.0] - 2026-07-14

### Added
- Memory auto-dream + L0 compact index (Claude Code steal Sprint A)
- `prjct dream` — memory auto-dream (KAIROS-style): gates (24h + 5 lands), 4-phase consolidate + L0 index rebuild; also on `prjct land` when gates open
- L0 compact memory index (`prjct memory index`) — ≤4k TOC injected on SessionStart; stored in kv `memory:l0-index`
- `prjct memory close|forget|dream|index` aliases; skill continue-vs-spawn + hygiene verbs

## [3.56.1] - 2026-07-14

### Bug Fixes

- publish npm metadata pointing at prjct-app/cli (#563)

### Maintenance

- one-shot npm publish for registry metadata (temp) (#561)
- point all URLs at github.com/prjct-app/cli (#560)
- point product surface at prjct-app/prjct-cli (#559)

## [3.56.0] - 2026-07-13

### Added
- skill generator l0 test assertions

## [3.55.0] - 2026-07-13

### Added
- Optimized core prjct L0 skill for token efficiency (compressed verbs table + reduced redundancy = 791 tokens). Upgraded create-skill with SDO and TDD-for-skills patterns. Added systematic-debugging skill. Updated architecture with curation principles. All retrocompatible with all models. Full post analysis wins delivered. Tests and harness score passing.

## [3.54.0] - 2026-07-13

### Added
- Optimized core prjct L0 skill for token efficiency (compressed verbs table + reduced redundancy = 791 tokens). Upgraded create-skill with SDO and TDD-for-skills. Added systematic-debugging skill. Updated architecture with curation principles. All retrocompatible. Full post analysis wins delivered. Tests and harness passing.

## [3.53.2] - 2026-07-13

### Added
- Optimized core prjct L0 skill for token efficiency (compressed verbs table and reduced redundancy → 791 tokens). Upgraded create-skill with SDO and TDD-for-skills patterns. Added systematic-debugging skill template. Updated architecture.md with curation principles. All changes retrocompatible with all models. Full implementation of post analysis wins. Tests and harness score passing. Branch: feat/post-analysis-optimizations

## [3.53.0] - 2026-07-13

### Added
- skill curation from post analysis

## [3.52.0] - 2026-07-13

### Added
- KISS/DRY dead code cleanup after portable L0 skill

## [3.51.0] - 2026-07-13

### Added
- portable multi-LLM L0 skill isolation — no global project stamp

## [3.50.2] - 2026-07-12

### Added
- perf: routing fix + MCP schema slim (19→10 tools)

### Performance

- **MCP schema slim (ListTools tax)**: default core surface **19 → 10 tools**; `projectPath` optional (cwd / `PRJCT_PROJECT_PATH`); typed record verbs + cost/signals/skills/developer/tiers/artifacts moved to `PRJCT_MCP_TOOLS=standard|all`; shorter server instructions. CLI parity unchanged.

### Bug Fixes

- **Routing: `prjct harness score` no longer GTD-captures to inbox** — `harness` was implemented in bin-commands but missing from `BIN_ONLY_COMMANDS`, so multi-word GTD rewrote it to `capture` whenever the daemon path ran. Registered as bin-only + completeness test so handlers cannot outlive the allowlist again.

### Performance

- **Lazy hook runners** — Stop/embeddings/transcript graph no longer loads for prompt/pre-edit cold spawns (`hooks/registry.ts` dynamic import per event).
- **UserPromptSubmit hot path** — `bumpTurnCount` returns post-bump task (one write, no second read); owner from task; parallel queue/ship/inbox/handoff/git; parallel alignment imports.
- **Usefulness rerank** — `decayedScores` accepts candidate IDs so FTS rerank no longer full-scans `memory_usefulness`.
- **Typo suggestions** — `findClosestCommand` uses full COMMANDS manifest (bin-only verbs included) + length early-exit.

## [3.50.2] - 2026-07-12

### Performance

- slim core ListTools 19→10 tools (#554)

## [3.50.1] - 2026-07-12

### Performance

- fix harness GTD capture + hot-path efficiency (#553)

## [3.50.0] - 2026-07-12

### Added
- Claude ecosystem adopt — trust, tiers, session, packs

### Features

- **Claude ecosystem adopt (patterns, not products)** — model-agnostic harness organs:
  - **Trust boundary** (`core/services/trust-boundary.ts`): single gate for secrets, prompt-injection, package install, imported workflow rules; wired into pre-secrets/pre-package/remember/capture/MCP/projectMemory SoT + workflow-engine
  - **Alignment card** mid-cycle MUST inject (loop / context-pressure / quality / stuck) on UserPromptSubmit
  - **Context cache tiers L0–L3** contract + live L0 budget; `prjct context tiers --md`, harness criterion `context-tiers`
  - **Safe artifacts** audit surface (judgment, ships, handoffs, checkpoints, session continuity); `prjct context artifacts --md`
  - **Managed session continuity**: land stamps `session:continuity`; prime restores resume card; SessionStart cold cue; MCP `prjct_session_resume`
  - **Pack marketplace-lite**: semver + integrity hash, `seed catalog` / `seed verify`, activation receipts in `packs:installs`

### Bug Fixes

- **Daemon performance + stability**: spawn single-flight lock kills concurrent bind races (`Failed to listen` / `chmod ENOENT`); hook vs command request lanes (no HOL-block of Claude hooks); graceful drain on shutdown; absorb uncaught errors with capped respawn; hook client timeout 5s (shim parity); version drift only when global is strictly newer semver; self-respawn only on code mtime reload; richer `daemon status` (version, RSS, active, absorbed errors)

## [3.49.1] - 2026-07-12

### Bug Fixes

- performance + stability hardening (#550)

## [3.49.0] - 2026-07-12

### Features

- Dynasty program — unbridgeable moat (v3.48.0) (#548)

### Bug Fixes

- project pattern supremacy + mechanical review FP refute (v3.48.0) (#549)

## [3.48.0] - 2026-07-11

### Features

- **Dynasty program** (#548): public harness Δ, content-bound stamp, SoT hard-bind H2+, trap-surface SLO, impact-ranked next, geometry-at-intent, skill diet ≤900, cycle budget card, land Rho dry-run, one-breath install, doctor --fix
- **Project pattern supremacy** (#549): match house style; upgrade only real anti-patterns; work alignment brief; mechanical prefer-const refute when reassignment present
- freeze review scope from git (gentle-ai v1.49) (#547)

### Changed

- **Repo hygiene (complete)**: knip-clean; no repo-local AGENTS/CLAUDE/Copilot/MCP harness; dead template docs removed; contributor architecture in `CONTRIBUTING.md` + `docs/`.
- **Source renames (product-only naming)**: `host-agents-md` / `host-claude-md` / `runtime-claude` / `agent-info` / `agents-md-discovery`; crew templates under `templates/crew/roles/`; standalone installer `scripts/install-standalone.sh`. Destination host paths (e.g. user-project `CLAUDE.md`, `.claude/agents/`) unchanged — those are host APIs.
- **Licensing**: MIT © 2024–2026, `NOTICE`, package author/SPDX, CONTRIBUTING contribution clause.

## [3.47.1] - 2026-07-11

### Bug Fixes

- security P0 (no shell spawns) + cold afterEmit detach (#546)
- harden subprocess surfaces + detach cold-path afterEmit

### Maintenance

- repo hygiene + solid MIT licensing (#545)
- complete product-only rename — no repo agent harness leftovers
- strip non-product agent harness from repo tree
- repo hygiene — dead code, root cruft, solid MIT licensing

## [3.47.0] - 2026-07-10

### Added
- **Dominance SUPERIOR program (complete)**: all feature gaps vs gentle-ai / open-GSD / memory plugins are hard mechanisms, not banners.
  - **Gates (consent-scoped overrides)**: discuss-lock H2+; context-pressure hard-blocks ship (`--force-pressure`); package PreToolUse + ship (`--allow-new-deps`); judgment dual-blind on code-strict (`--no-judgment-gate`); ship delivery-geometry on large diffs (`--geometry`); Nyquist-lite on H2+ work with vague ACs.
  - **Memory hygiene**: `prjct close <id>`; Rho retention + auto-source cap + vault health; SoT/SUGGEST tip→user.
  - **Drift**: SessionStart schedules world-model refresh; applied stamp clears permanent-stale banner.
  - **Multi-runtime**: Claude/Codex/Gemini/Cursor/Grok signal parity matrix; CONTRACT.loop on Codex/Gemini surfaces (Codex ≤1024B).
  - **Proof**: competitive dust SUPERIOR every row; `gate:dominance` 28/28.

## [3.46.0] - 2026-07-10

### Features

- value-based memory retention (full plan: score + apply + triggers) (#542)
- terminal tip channel — agent surfaces SoT/suggest to user
- living apply — SoT binding + live mod suggestions

### Bug Fixes

- align tip→user tests + ship as v3.45.0

## [3.45.0] - 2026-07-10

### Added
- **Living apply (SoT · live suggest · tip→user)**: Rho-kept memory injects as binding SoT (decision/gotcha/fact) or live modification suggestions (anti-pattern/pattern + files). Agent is the terminal tip channel (no web UI) — restates SoT/SUGGEST in chat, then acts.
- **Rho-inspired selective memory (microsoft/rho analogy)** — real reference model R (judgment + living-v2), excess = 1−max_sim vs R via local subword embeddings (0 tokens), capture gate rejects low-excess noise, score/apply/embed driven by excess + usage + groundedness. Modules: `retention/reference-model.ts`, `excess.ts`, `capture-gate.ts`.
- Value-based retention apply path: archive/delete caps, inbox triage, done-trigger, `config.retention.mode` off|dry-run|apply.
- **Historical bloat mitigation on `prjct sync`**: soft-deleted vacuum (30d), orphan remember-events purge, archive prune, auto-source live cap (20), vault health line; auto-source capture gate (stricter excess); inject filter demotes aged auto history on recall.
- **Distill-then-hard-delete**: worthless history analyzed into one digest then hard-deleted; auto-source overflow distilled; delete verdicts hard-delete (protected types archive only).

## [3.45.0] - 2026-07-10

### Features

- paid UX — account status, connect, billing (v3.45.0) (#543)
- distill-then-hard-delete worthless history
- historical bloat mitigation on prjct sync
- real Rho excess vs reference model R
- complete retention plan — apply, inbox triage, done-trigger, selective embed
- retention score service + sync dry-run report (PR1 of value-based cleanup)

## [3.44.0] - 2026-07-10

### Added
- multi-agent realtime yield/switch handoff + auto-worktree isolation
- **`prjct switch <agent> [--reason] [--launch]`** — yield the live work cycle to another runtime (codex/claude/grok/…) with durable who/why in SQLite (`task_handoffs`)
- **`prjct accept [hand_id]`** / **`prjct handoffs`** — accept pending handoff, rebind ownership, resume brief
- Owner stamping on cycle start (`ownerAgent` / `ownerIdentity` / `ownerSessionId`) so handoffs know who started
- Auto-worktree isolation when `prjct work` collides with a foreign occupant on main (`multiAgent.autoWorktree`: auto|ask|off)
- Prompt + SessionStart cues for pending handoffs; desktop notify on yield/accept; optional CLI launch
- Loop-discipline skill triggers for stuck/switch and parallel worktree isolation

## [3.42.0] - 2026-07-10

### Added
- adorable Codex-style cast names for multi-agent fan-out
- Adorable multi-agent cast names (Codex-style): orchestration assigns durable scientist/inventor codenames (Popper, Copernicus, McClintock…) to explore/implement/review or crew roles; shown on `prjct work` and used as default `claim` identity when `--as` / `PRJCT_AGENT` unset.

## [3.41.0] - 2026-07-10

### Added
- closed-loop judgment + dynamic work-scope inventory
- Closed-loop judgment continuity: Judgment Receipts on `land`/Stop (capture:receipt-v1), Decision Conflict Gate on Edit|Write (`judgment.conflictMode` off|advisory|strict with durable override via remember tags — not land/sdd modes), hot-path latency budgets (≤300ms fail-open + SQL LIMIT on file recall), SessionStart git timeouts, closed-loop health line on `prjct harness score`. Proof of traps prevented and decisions applied — continuity of engineering judgment, not an AI memory product (mem_3919).
- Full 7-bet leap: world-model impact on `guard` (import/co-change + traps); default routing surface `work`+`ship` progressive disclosure; multi-agent geometry DEFAULT wording for H2/H3 fan-out; token economics score on `prime`/`harness score`; `judgment.weakModelMode` product mode (strict conflict floor + elevated quality + SessionStart/prime banner).
- Work-scope SSOT: before Grep/Glob, agents get a constrained file list from memory (FTS + semantic embeddings when enabled) + BM25 code index + import/co-change graph (`resolveWorkScope`). Wired into `prjct work`, prompt file cue, MCP `prjct_relevant_files`, and skill MUST discipline.
- Project file inventory on every `prjct sync`: discovers real extensions/languages in the tree (language-agnostic). Work-scope ranks with inventory weights (unknown ext downranks, never hard-drops).
- Conflict gate defaults pack-gated: off | code→advisory | code-strict→strict (no CONFLICT spam on bare projects). Pre-edit shares one preventive recall between decide+build.

## [3.40.0] - 2026-07-10

### Added
- CLI login PKCE S256 (flow=pkce-v1) aligned with api+app
- CLI login PKCE S256 (flow=pkce-v1): callback carries only code+state; exchange via /auth/cli/exchange

## [3.39.0] - 2026-07-10

### Added
- quality orchestrator P0: auto ledger + inject; ship suggest with text confirm

## [3.38.0] - 2026-07-09

### Added
- credential pre-secrets MUST (no PPID) + inert cloud workflow pull

## [3.36.0] - 2026-07-09

### Features

- multi-runtime organic wire + weak A/B CI dominance gate (#533)
- precision-gated judgment v2 — evidence tax, DNA, RED/BLUE merge, ghost FP memory, next card, ship hard-gate

## [3.35.0] - 2026-07-09

### Features

- dominance P0–P2 vs gentle-ai + open-GSD (#532)

## [3.34.0] - 2026-07-09

### Features

- brutal quality vs GSD — friction promote + denser prime (#531)

## [3.33.0] - 2026-07-09

### Added
- deeper understanding
- xAI Grok Build CLI compatibility (agent-runtime-registry)

## [3.32.0] - 2026-07-09

### Features

- passive capture v2, land auto-synthesis, weak-vs-frontier demo (#528)

## [3.31.0] - 2026-07-09

### Features

- absolute scorecard, lean defaults, multi-provider maps (#526)

### Bug Fixes

- Node 22 + pin npm@11 so publish is not blocked by engines (#527)

## [3.30.0] - 2026-07-09

### Features

- xAI Grok Build CLI compatibility (#525)

## [3.29.1] - 2026-07-06

### Bug Fixes

- fail remember on required write errors (#524)

## [3.29.0] - 2026-07-03

### Features

- surface work-graph + ceremony verbs in the verb map (#523)

## [3.28.1] - 2026-07-03

### Bug Fixes

- import 'it' in task-orchestration test (#522)
- research classifies as its own kind → parallel fan-out (#521)

## [3.28.0] - 2026-07-03

### Features

- Tier-3 hygiene — tiered MCP loading + bounded working-set renders (#520)

## [3.27.0] - 2026-07-03

### Features

- Tier-2 ceremonies — journal, compiled briefs, replan, prime/land, adversarial review (#519)

## [3.26.0] - 2026-07-03

### Features

- the work graph — deps, ready frontier, atomic claim, phases, decompose loop (Tier 1) (#518)

## [3.25.0] - 2026-07-03

### Features

- time-window token attribution + historical backfill from transcripts (#517)

## [3.24.3] - 2026-07-03

### Bug Fixes

- completion no longer clobbers measured task tokens with zero (#516)

## [3.24.2] - 2026-07-03

### Bug Fixes

- clamp plausible token overages — per-task tokens finally populate (#515)

## [3.24.1] - 2026-07-03

### Bug Fixes

- run packed versions via the production launcher with installed deps (#514)

## [3.24.0] - 2026-07-02

### Features

- session tracker on typed tables + token-budget default — storage backlog closed (#513)

## [3.23.0] - 2026-07-02

### Features

- tier-2 package — guard PR mode, global KB, memory lifecycle, changelog, bench, import hint (#512)

## [3.22.0] - 2026-07-02

### Features

- the measured harness — token budget, per-model cost, subagent telemetry, estimation loop (#511)

### Maintenance

- refresh AGENTS.md routing block (v3.21.2 dogfood) (#510)

## [3.21.2] - 2026-07-02

### Performance

- hot-path follow-up — stop-hook throttle, BM25 query-path, config cache (#509)

## [3.21.1] - 2026-07-02

### Bug Fixes

- cleanup sweep — dead code, edge cases in recent ships, hot-path perf (#508)

## [3.21.0] - 2026-07-02

### Features

- gentle-ai learnings — ALL 8 mechanisms (#507)

## [3.20.0] - 2026-07-02

### Features

- task history in typed tasks table — state blob −94% (Schema v2 C4, history slice) (#506)

## [3.19.0] - 2026-07-02

### Features

- ideas in typed table + orphan kv-key sweep (Schema v2) (#505)

## [3.18.0] - 2026-07-02

### Features

- restore velocity from typed delivery data + developer-evolution weekly snapshots (#504)

## [3.17.0] - 2026-07-02

### Features

- queue in typed queue_tasks — retire the 1.08MB per-prompt blob (Schema v2) (#503)

## [3.16.0] - 2026-07-02

### Features

- metrics in typed tables + stamp tasks.shipped_at — two more dual-store bugs fixed (#502)

## [3.15.1] - 2026-07-02

### Bug Fixes

- harden session ships — sync ping-pong, node 22.5–22.12 fallback, classifier false positives (#501)

## [3.15.0] - 2026-07-01

### Features

- ships in typed shipped_features table — retire the 5.4MB kv_store blob (Schema v2 C5) (#500)

## [3.14.0] - 2026-07-01

### Features

- triage drives orchestration — trivial→direct, complex→SDD+TDD+crew, per-subagent model (#499)

### Performance

- run bundled entry in-process — 41% faster commands (#498)

## [3.13.0] - 2026-07-01

### Features

- Schema v2 relational redesign + vault removal + legacy cleanup (#497)

## [3.12.2] - 2026-06-29

### Bug Fixes

- regenerate statusline body on upgrade so the version-check fix ships (#496)

## [3.12.1] - 2026-06-29

### Bug Fixes

- statusline version check owned by daemon, not legacy files (#495)

## [3.12.0] - 2026-06-29

### Added
- world class efficiency

## [3.11.1] - 2026-06-29

### Bug Fixes

- make prjct harness-agnostic across LLMs (Codex/Gemini) + sandbox-safe (#493)

## [3.11.0] - 2026-06-29

### Added
- harness pillars

## [3.10.0] - 2026-06-29

### Added
- hacer que prjct sea el mejor harness agéntico del mercado para devs: estructura de workspace, bucle de agentes, arquitectura multi-agente, skills/comandos, y soberanía del rig (modelo intercambiable)

## [3.9.0] - 2026-06-28

### Added
- token-efficiency program: compact pull verbs, lean routing blocks, search relevance threshold, guard precision, fix BM25 file-index prototype crash

## [3.8.0] - 2026-06-27

### Added
- work token savings

## [3.7.0] - 2026-06-26

### Added
- kimi cli doesn't know what prjct is — surface prjct agent protocol to Kimi CLI

### Fixed
- make commits and `prjct ship` safe inside git worktrees (staged-file pre-commit lint; never bare-push to an inherited `origin/main` upstream)

## [3.6.0] - 2026-06-26

### Added
- investigate and fix multiple cloud sync problems users are reporting after recent v3.4.0/v3.5.0 sync ships

## [3.5.0] - 2026-06-26

### Added
- make all sync entities bidirectional (pull+push) and preserve per-record created_at (origin creation time) distinct from synced_at (ingestion time on receiving machine)

## [3.4.0] - 2026-06-26

### Added
- work cost

## [3.3.0] - 2026-06-26

### Added
- Investigate why Claude spent 55k tokens exploring existing repo context instead of prjct surfacing files context and repo state

## [3.2.0] - 2026-06-26

### Added
- synthesis context eval gate

## [3.1.0] - 2026-06-26

### Added
- cold hook bundle

## [3.0.0] - 2026-06-26

### Added
- v3.0 AI Agile OS second brain context refresh

## [2.77.0] - 2026-06-26

### Added
- context quality cleanup

## [2.76.2] - 2026-06-26

### Bug Fixes

- vault regen self-heals missing files (no more stale-complete vault) (#476)

## [2.76.1] - 2026-06-26

### Bug Fixes

- prjct sync regenerates the vault (was leaving it stale) (#475)

## [2.76.0] - 2026-06-26

### Features

- project context RAG — the history of contexts (context is gold) (#474)

## [2.75.0] - 2026-06-26

### Features

- deterministic project id, stable deviceId, local-safe sync (#473)

## [2.74.0] - 2026-06-26

### Features

- sync specs + full analysis to the cloud vault (#472)

## [2.73.0] - 2026-06-25

### Added
- fix daemon auth cache for cloud link

## [2.72.0] - 2026-06-25

### Added
- auth bin only logout

## [2.71.0] - 2026-06-25

### Added
- secure cli login auth

## [2.70.0] - 2026-06-25

### Features

- sync sanitized project metadata for the web /projects view (#468)

## [2.69.0] - 2026-06-24

### Added
- reduce user token consumption in generated agent context

## [2.68.0] - 2026-06-24

### Added
- transparent auto-harness task start and Codex status line install
- `prjct task` now creates a transparent auto-harness (H0-H3) with expected evidence and advisory completion warnings, shared by CLI and MCP task starts.

### Fixed
- `prjct install` now repairs detected Codex `~/.codex/config.toml` with the prjct MCP server and TUI `status_line`, matching the setup flow.

## [2.67.2] - 2026-06-24

### Bug Fixes

- route upgrade alias through update (#465)
- route upgrade alias through update

## [2.67.1] - 2026-06-23

### Fixed
- command routing fallback

## [2.67.0] - 2026-06-23

### Added
- eval benchmarks cloud

## [2.66.0] - 2026-06-23

### Added
- cleanup command surfaces and dead templates

## [2.65.0] - 2026-06-23

### Added
- setup-owned vault root with OS-aware defaults

## [2.64.0] - 2026-06-23

### Added
- eval benchmarks cloud

## [2.63.2] - 2026-06-23

### Bug Fixes

- resolve Dependabot audit alerts

## [2.63.1] - 2026-06-23

### Bug Fixes

- harden prjct eval workflow inputs

## [2.63.0] - 2026-06-23

### Added
- eval result publishing

## [2.62.0] - 2026-06-23

### Added
- Point CLI metadata to cli site

## [2.61.0] - 2026-06-23

### Added
- Improve prjct-cli maintainability performance and UX

## [2.60.0] - 2026-06-22

### Added
- update tolerates legacy project dbs

## [2.59.0] - 2026-06-22

### Fixed
- **Windows and Linux compatibility foundations.** Package-manager installs now use a portable Node launcher on Windows, the daemon uses named pipes on Windows and Unix sockets on macOS/Linux, Git auto-sync hooks no longer depend on Unix-only shell utilities, and CI smokes Ubuntu, macOS, and Windows.

## [2.58.0] - 2026-06-22

### Added
- stale sync slash copy

## [2.57.0] - 2026-06-22

### Added
- context7 daemon path

## [2.56.0] - 2026-06-22

### Added
- paid-tier product proof surfaces

## [2.55.0] - 2026-06-21

### Added
- fix sync analysis save for all agents

## [2.54.0] - 2026-06-21

### Added
- Universal AI coding agent compatibility surfaces. `prjct init`, `setup`, and `sync` now refresh AGENTS.md, legacy Claude routing, stable IDE rules, and repaired MCP config from a shared runtime registry covering Codex, Claude, Gemini, OpenCode, Qwen Code, Cursor, Windsurf, Cline/Roo, Continue, Kiro, Copilot, Devin, Jules, Zed, Warp, Amp, Factory, Augment, Kilo Code, Phoenix, Ona, Semgrep, and related agent runtimes.

### Fixed
- `prjct ship` no longer writes `current work` into CHANGELOG.md or the default ship commit when the active task has already been closed. No-arg ships now use the active task description, derive a readable summary from the feature branch, or fail with an explicit release-description prompt.

## [2.53.1] - 2026-06-21

### Fixed
- **Embeddings now work with OpenRouter out of the box.** OpenRouter namespaces every model as `vendor/model`, so a bare OpenAI-style id (`text-embedding-3-small`) returned "model not found" — even though zero-config correctly auto-detected the OpenRouter base URL from an `sk-or-…` key. prjct now auto-prefixes the implied vendor (`text-embedding-3-small` → `openai/text-embedding-3-small`) whenever the base URL is OpenRouter, applied on read, on `embeddings set`, and on the wire (so existing, per-project, and global configs all resolve correctly). No-op for OpenAI / Ollama / any other base, and an already-namespaced id is left untouched. (OpenRouter *does* serve `/embeddings`; the earlier assumption it didn't was wrong.)

## [2.53.0] - 2026-06-20

### Added
- **Desktop notifications + sharper work-state — never lose track of a background wait.** prjct now pings you (best-effort OS notification, **default on**) the moment **Claude is waiting on you** and when a **subagent finishes** — so a wait no longer hangs silently while you've tabbed away. New Claude Code hooks (`Notification`, `SubagentStop`) fire the ping with the active task + pending count; macOS (`osascript`) and Linux (`notify-send`) supported, silent elsewhere. Toggle with **`prjct notify on|off`** (`config.notify.mode`). Separately, the per-prompt "project state" block now shows a **`Pending: N · Next: "…"`** line (from the task queue) on top of the existing active-task + owner (worktree) + inbox lines — so "what's active, what's pending, who's working it" is always in view. Notifications are best-effort and `safeRun`-wrapped: they never disturb the session.

## [2.52.0] - 2026-06-20

### Added
- **`prjct sdd` — opt-in Spec-Driven Development mode.** Gates the spec pipeline prjct already has (`spec → audit-spec → task --spec → ship`), per project, mirroring `lean`/`tdd`: `off` (default, escalate-only — no change), `advisory` (nudge + the existing ship acceptance surface), or `strict`. In **strict**, every `prjct task` must link a **reviewed** spec — enforced in `task-service` so the CLI and the MCP write-path share the gate — and `ship` blocks work with no linked spec (`prjct ship --no-spec-gate` overrides). `prjct sdd` shows the mode + the active task's pipeline station as a checklist. No new pipeline; this only gates the existing one.

## [2.51.0] - 2026-06-20

### Added
- **`prjct tdd` — opt-in Test-Driven Development mode.** For dev teams that want test-first discipline, set an intensity per project (mirrors `lean`): `off` (default, zero change), `assist` (skill biases the implement loop test-first; `ship` reminds), or `strict` (test-first expected; `ship` surfaces a hard gate). `prjct tdd check` runs the auto-detected test command (per-stack via `detectProjectCommands`) and reports red/green — the real teeth; `prjct tdd` alone shows the mode + detected command. Enforcement stays consistent with prjct's model: the CLI surfaces the gate, `prjct tdd check` is the actual red/green, the agent honours it (no new engine). `prjct ship --no-test-gate` overrides.

## [2.50.1] - 2026-06-20

### Security
- **Removed the runtime Bun auto-installer (supply-chain hardening).** The CLI no longer runs `scripts/ensure-bun.sh` (an unpinned, unverified `curl -fsSL https://bun.sh/install | bash`) on first invocation when only Node is present — `bin/prjct` now falls straight back to Node (a first-class runtime). The script is deleted and dropped from the published tarball (`files[]`), so the package ships **zero `curl | bash`**. The install-time variant was already gone (no `postinstall` since #391); this closes the same pattern on the runtime path. Addresses the OSV **MAL-2026-4647** false-positive (Amazon Inspector "alternate-runtime-dropper", pinned to 2.21.0) at its root. Bun is still preferred when already installed; users who want it install it themselves (https://bun.sh).

## [2.50.0] - 2026-06-20

### Added
- **Loop-discipline triggers in the always-loaded skill body.** A compact trigger table now tells the agent exactly when to stop going direct: delegate exploration when reading 4+ files, keep one writer + a fresh `review` when touching 2+ non-trivial files, run `review` before any commit/push/PR (trivial diffs excepted), and **STOP and re-orient/`audit` on a wrong cwd, worktree/git accident, merge recovery, or confusing test/env failure** — never debug forward over a broken state. The per-dispatch model quick-reference (implementer→opus, reviewer/judge→sonnet, routing→haiku) now lives in the always-loaded body too, not just in on-demand `workflows.md`, and `ship` documents the pre-PR review gate. (Adopted from patterns observed in Gentleman-Programming/gentle-ai's delegation triggers; kept as lean guidance — no new config.)

## [2.49.2] - 2026-06-20

### Changed
- **Clear "subscription required" message when cloud backup is gated.** The server's 402 paid gate now reaches `prjct cloud sync`/`pull` as a dedicated, friendly notice (`💳 Cloud backup paused — subscription required`) instead of a generic "synced with errors", and it's flagged as a soft failure so local-first work continues. The message text stays server-authored — the CLI keeps zero paywall logic (a `PAYMENT_REQUIRED` code is threaded through `SyncResult`/`PushResult`/`PullResult`).

## [2.49.1] - 2026-06-20

### Fixed
- **`prjct login` now targets the prjct cloud web app's device-authorization flow.** It opens the SPA's `/auth/cli?port=…&device_id=…&hostname=…` route (was the old `/login?redirect=/api/auth/cli-login` shape) and passes this machine's stable `deviceId` + `hostname`, so the key the web mints is bound to the same device id the CLI later sends as `X-Device-Id` — no "device mismatch" rejection on first sync. Default web URL is now `http://localhost:5173` (the web SPA); override with `--url` or `PRJCT_WEB_URL`.

## [2.49.0] - 2026-06-20

### Added
- **Cloud sync — workflows round-trip + hardening.** Added pull handlers for `custom_workflows` (keyed by the stable workflow `name`) and `workflow_rules` (mirrored by source id via `INSERT OR REPLACE`, matching the cloud's upsert-by-id model), so a project's custom workflows + their hooks/gates/steps now sync across machines (both write directly to the tables — no echo back to the queue). A one-line `prjct cloud` pointer was added to the generated skill so agents surface it.

### Changed
- Cloud `include` defaults: `metrics` and `archives` are now **off by default** (opt-in). Neither round-trips yet — `metrics` has no producer, and `archives` ships a lossy summary (no `entity_data`) with no local apply handler — so they're not pushed by default rather than sending data nothing consumes. `archives`/`subtasks`/`metrics_daily`/`velocity_sprints` are now listed as known-skipped entity types (no "no local handler" warn on pull).

## [2.48.0] - 2026-06-19

### Added
- **Cloud sync — realtime (WebSocket).** Linked projects now propagate changes across machines in near-real-time (target <5s), on top of the pull-based sync from 2.47.0. A new realtime client (`core/sync/realtime-client.ts`) uses the **platform global `WebSocket`** (RFC 6455, stable in Node ≥22.5 and Bun) — **no `ws` dependency and no backend SDK**; the token/device/project are passed as `wss://` query params (TLS-encrypted) since the WHATWG WebSocket API can't set headers. Connections live in the **warm daemon** (`RealtimeManager`), reopened on boot from a tiny linked-projects registry (`core/sync/cloud-registry.ts`) instead of scanning every project dir. `prjct cloud link` / `resume` open a connection; `pause` / `unlink` close it; `prjct cloud status` shows the live connection state. Inbound events apply through `syncManager.applyRealtimeEvent` with an **echo-loop guard** (events originating from this device are skipped) and cursor advance so a later pull doesn't re-fetch. Reconnect uses exponential backoff with jitter. Realtime runs only inside the daemon; in `PRJCT_NO_DAEMON` mode sync stays pull-based (no behavior change). The engine-agnostic CI guard now covers the realtime files too.

## [2.47.0] - 2026-06-19

### Added
- **Cloud sync — client foundation (paid, opt-in, local-first).** New `prjct cloud` command group: `link` / `unlink` / `sync` / `pull` / `pause` / `resume` / `status`. A project stays 100% local until you `prjct cloud link` it (`config.cloud.enabled`); then the durable local queue (`sync_pending`) pushes to a token API and pulls remote changes. Linked projects also flush best-effort on `prjct ship` and at session end. **Memories now sync** — the highest-value cross-device entity (decisions/learnings/gotchas) was silently dropped before: the push mapper keyed off legacy `type` strings, so `memories`, `queue_task`, `custom_workflows`, `workflow_rules` and `archives` never reached the wire. Push is now driven by a single canonical entity→table map shared with the pull path, and a new `memories` pull handler applies remote memories into the events table (the source of truth) without echoing back. Per-project `include` whitelist (cross-device groups on; sensitive prompts/sessions/analysis off by default). The client carries only a token (`X-Api-Key` + `X-Device-Id`) and talks to a storage API — **no backend-engine reference anywhere in the client (CI-guarded), and zero paywall logic: paid limits are enforced server-side and surfaced verbatim** (e.g. a 402 upgrade message). Backend lives in a separate repo. No behavior change for projects that never link.

### Internal
- Test isolation (mem_1560): `pathManager.globalProjectsDir` now honors `PRJCT_PROJECTS_DIR` (resolved at access time), and a new bun preload points `PRJCT_CLI_HOME` at a throwaway temp dir for the whole run. The suite no longer leaks fixture projects into the real `~/.prjct-cli/projects` — verified: full suite adds 0 dirs to the real projects dir (previously ~116/run). No production impact (prod never sets `PRJCT_PROJECTS_DIR`).

## [2.46.1] - 2026-06-19

### Fixed
- `prjct spec audit <id> --lenses a,b,c` now actually overrides the lens set. The flag was dropped by every CLI dispatch path (`route-spec`, daemon `dispatch`, and the `audit-spec` alias), which forwarded only `{ md }` — so the documented override silently fell back to the deterministic baseline (shipped that way in 2.46.0). Now forwarded through all paths, with a router-level test that drives `routeSpec` (the earlier tests called the method directly and missed the gap).

## [2.46.0] - 2026-06-19

### Added
- dynamic audit-spec lenses (deterministic baseline + agent override)

### Fixed
- **The first command after an upgrade no longer stalls.** The post-upgrade re-setup (provider installers, Context7 verification, the per-project migration over the whole projects dir) ran synchronously inside whatever command the user happened to run first — up to ~30s of silent blocking on machines with large project dirs. It now runs in a detached `__post-upgrade` child (the auto-updater pattern): the command returns immediately (measured 31.6s → 0.10s) and a one-line banner says setup is finishing in the background. Explicit `prjct update` keeps its synchronous, progress-printing behavior. Both detached-child internals are now in the daemon shim's skip set — routing them to the daemon silently failed them.

### Internal
- **Dead-code and anti-pattern sweep** (no user-visible behavior change). Removed: 29 redundant `export default` aliases, the orphaned OAuth token validation/migration family (`tokens.ts` shrinks to the version pin; `system-database.ts` and its write-only MCP-health table die with it), `projectMemory.similar()`, `memoryService.getRecent`/`getByAction`, `hasIndexesAll`, `aggregateHookSignals`, `deriveWorkspaceId`, and five write-only `SkillContext` fields (task/backlog descriptions deliberately never enter the skill body). Deduplicated: the guard label/detail helpers (one canonical pair in `memory/format.ts`), the CLAUDE.md/AGENTS.md routing writers (shared `routing-block.ts` skeleton), and the pathManager test sandbox (one `_setup/path-manager-mock.ts` instead of eight hand-copied patch/restore blocks). Simplified: `selectProvider` (the never-built `userSelected` prompt path removed), static skill frontmatter takes no context by construction.

## [2.45.0] - 2026-06-16

### Features

- lean — anti-over-engineering capability (prjct-native ponytail) (#434)

## [2.44.2] - 2026-06-12

### Bug Fixes

- post-upgrade setup no longer stalls the user's first command (~30s → 0.1s) (#432)

### Maintenance

- dead-code + anti-pattern sweep — DRY/KISS pass (#431)

## [2.44.1] - 2026-06-12

### Performance

- token diet — coarse timestamps, quiet state lines, counts-only skill State, instruction dedupe (#430)

## [2.44.0] - 2026-06-11

### Features

- retrieval quality — superseded filter, proven-first digests, MCP parity, push-path ship credit, unicode keywords (#429)

## [2.43.4] - 2026-06-11

### Performance

- indexed range queries, git TTL cache, version-aware vault fingerprint, upgrade-scan guard (#428)

## [2.43.3] - 2026-06-11

### Bug Fixes

- Codex first-class — skill under 1KB cap, MCP wiring, real AGENTS.md, doctor checks (#427)

## [2.43.2] - 2026-06-11

### Bug Fixes

- release job is idempotent — recovery path for partial failures + retried npm publish (#426)

## [2.43.1] - 2026-06-11

### Bug Fixes

- memory cap never deletes knowledge — exclude memory.remember.* from capEntries (#425)

## [2.43.0] - 2026-06-10

### Features

- vault v2 — signal-first RAG (telemetry quarantine, link-only tags, dashboard index) (#424)

## [2.42.6] - 2026-06-10

### Bug Fixes

- review follow-ups — cold-only routing, true SIGHUP reload, subagent repeat-miss, in-process prune counter (#422)

### Maintenance

- pin bun via .bun-version — stop resolving 'latest' on every run (#423)

## [2.42.5] - 2026-06-10

### Bug Fixes

- confirmed findings from the v2.42.x range code review (#421)

## [2.42.4] - 2026-06-10

### Performance

- optimization backlog — FTS5 prefix indexes, god-file splits, glob removal + broken post-upgrade setup fixed (#420)

## [2.42.3] - 2026-06-10

### Refactoring

- follow-ups — workflow-engine rename, PRJCT_CLI_HOME everywhere, bin split, lazy daemon groups (#419)

## [2.42.2] - 2026-06-10

### Refactoring

- single command manifest — quadruple dispatch eliminated, flag-strip class gone by construction (#418)

## [2.42.1] - 2026-06-10

### Performance

- hot paths — Stop hook config/transcript once, CAS→txn, backfill anti-join + ghost-DB fix (#416)

### Refactoring

- perf: hot paths — Stop hook config/transcript once, CAS→txn, backfill anti-join + ghost-DB fix (#416)

## [2.42.0] - 2026-06-10

### Features

- LLM-first surface — untruncated agent output, subagent digest, skill-miss loop, indexed recall (#415)

### Refactoring

- feat: LLM-first surface — untruncated agent output, subagent digest, skill-miss loop, indexed recall (#415)

## [2.41.0] - 2026-06-09

Memory recall + apply-loop: prjct now *applies* what it learns at the moment it matters, not just on demand — and the knowledge survives model updates.

### Added
- **`prjct search "<query>"`** — first-class memory recall verb over the blended BM25 + semantic + recency pipeline (`prjct search mem_1234` resolves an entry by id). Before this, `prjct search "x"` was an unknown verb that fell through the GTD auto-route and silently *captured* the query to the inbox instead of searching.
- **`prjct forget <id>`** — the delete half of `remember`. Hard-deletes the source event and drops the FTS mirror + any embedding, so an entry can't resurface lexically or semantically; regenerates the vault. Accepts `mem_1234`, `mem-1234`, or a bare `1234`. (`projectMemory.forget()` existed but had no CLI verb — `prjct remember forget <id>` used to just create a junk `type:forget` entry.)
- **Apply-loop push hooks (Claude).** Anticipation was pull-only (`prjct guard` / the `prjct_guard` MCP tool), which depends on the agent *remembering* to ask — and a freshly-updated model starts with that instinct reset and zero conversation context. Now Claude also gets two targeted pushes (both fire regardless of model = update-proof): a `PreToolUse(Edit|Write)` hook surfaces a file's preventive memory (gotchas/anti-patterns) the moment it's edited, and `SessionStart` injects a compact knowledge digest (top traps + decisions in force + a `developer.md` pointer) on cold start. Pull stays for non-Claude agents. The digest only injects on cold-start sources (`startup`/`clear`/`compact`), never the warm-prefix reusers (`resume`/subagent/cwd-change), so the prompt-cache-stability contract is preserved.

### Changed
- **Slimmed the always-on prjct skill** to curb Opus 4.8 over-routing: a DIRECT-by-default gate, heavy quality workflows (`review`/`qa`/`security`/`investigate`/`audit`) moved out of the lean body into `workflows.md`, and an explicit subagent model-downgrade policy.

### Fixed
- **Tests no longer write vaults into the real `~/Documents/prjct/`.** `getWikiPath` resolved the vault root off `os.homedir()` with no override, so any test that made a tmp project and triggered vault generation left an orphan `~/Documents/prjct/<tmp-slug>/` behind (hundreds accumulated). New `getVaultRoot()` honors `PRJCT_VAULT_ROOT` (mirrors `PRJCT_OBSIDIAN_CONFIG_DIR`); the global test preload sandboxes it to a throwaway temp dir, removed on exit.

## [2.40.0] - 2026-06-02

### Features

- per-worktree active tasks — multi-agent runtime (#413)

  **Multi-agent: per-worktree active tasks.** prjct's single-`currentTask` runtime now supports several AI agents working concurrently, each in its own git worktree, without clobbering a shared task. A deterministic `workspaceId` (derived from the git worktree root) keys each task into the existing `activeTasks[]` layer; the main worktree keeps the singular `currentTask` path, so single-agent use is unchanged. The single-task gate is now evaluated **per workspace** (a task in worktree A no longer blocks worktree B; a second task in the *same* worktree still gates), atomic inside the SQLite compare-and-set updater. Wiring lives at one choke point — `task-service` (`startTask`/`setTaskStatus`/`resolveActiveTask`/`completeActiveTask`) — inherited by the CLI, the MCP `prjct_task_*` tools, and `prjct ship`. Every read path (`prjct task`/`status` no-arg, `prjct remember` attribution, the session hooks, `prjct_task_status`, `prjct_workflow_status`) now resolves the **current worktree's** task and renders a workspace label (`shortId · branch`) plus a multi-workspace list, so it's always clear which worktree a task belongs to. Pause/resume **per worktree** is a planned follow-up (a child-worktree `prjct status paused` returns an explicit "unsupported" rather than a silent no-op); `done`/`ship` isolate correctly today.

## [2.39.0] - 2026-06-02

### Features

- zero-config embeddings (any provider) + fix daemon never serves stale code (#412)

### Fixed
- **Daemon could serve output from an outdated build (the recurring "stale daemon" trap).** Two compounding defects: staleness was detected *after* the daemon decided to serve, so the request that first observed a new build/install was still answered by the old code; and on refusal the client printed `Daemon restarting — retry the command` and exited 1, so the command never ran (1st call stale → 2nd fails → 3rd fresh). Now staleness is detected *before* serving, the daemon refuses cleanly with a `retry` signal (the request never executes → zero side effects), and **both `bin/prjct.ts` and the daemon shim** (`scripts/build.js` → `dist/bin/prjct.mjs`, what users actually run) transparently fall through to direct in-process execution on the fresh code — no error, no manual re-run. Hooks degrade to the fail-soft `{}` no-op. The global-install version-drift check is now time-throttled (1s) instead of every-10-commands (which could leak up to 9 stale responses). Closes the "stale daemon caches old hook code" gotcha.
- **`prjct embeddings test` no longer truncates its failure** to 65 chars (`embeddings endpoi…`). It now prints the full endpoint response plus an actionable hint (401 → base-url/key mismatch, 404 → wrong route, network → unreachable) — the one command meant to diagnose connectivity stopped hiding the diagnosis.
- **Embeddings test isolation:** `global-config` resolves its directory lazily from `PRJCT_CLI_HOME`, so config/embeddings tests no longer read the developer's real `~/.prjct-cli`.

### Added
- **Zero-config embeddings setup — paste just the key.** `prjct embeddings set --key <k>` now infers the base URL from the key's prefix (`sk-or-…` → OpenRouter, `sk-…` → OpenAI, `pa-…` → Voyage; `sk-ant-`/Groq/unknown → keep default), so `--base-url` is optional for known providers. An explicit `--base-url` still wins, and detection re-fires when you switch keys. `set` is now partial-update friendly too: `set --key …` keeps your existing model/base URL instead of resetting them.
- **Embeddings support ANY OpenAI-compatible provider, including non-Bearer ones.** Already worked with OpenAI, OpenRouter, Ollama, Together, Mistral, Voyage, Jina, LM Studio, … via `--base-url` + `--model` + `--key`; now providers that deviate from `Authorization: Bearer` are covered too — e.g. **Azure OpenAI** (`api-key` header + `api-version` query) and custom gateways. New `prjct embeddings set` flags: `--auth-header <h>`, `--auth-scheme <s|none>` (`none` = raw key), `--headers "k=v,…"`, `--query <qs>`. Default stays `Bearer`/`authorization`, so existing providers are unchanged. Vector dimensionality is detected from the response (no hardcoded size).

## [2.38.1] - 2026-06-02

### Performance

- slim always-on skill description (2.38.1) (#411)

## [2.38.0] - 2026-06-01

### Features

- PULL-only prompt hook + MCP task write-path (2.38.0) (#410)

## [2.37.6] - 2026-06-01

Code-health pass (clean-code batch from the optimization audit).

### Changed
- **Dropped the `date-fns` dependency.** `toRelative()` (its only use) now uses the built-in `Intl.RelativeTimeFormat` — identical output, one fewer dependency, smaller bundle, and aligned with the zero-dependency posture. Works on Bun and Node alike.
- **De-duplicated `execFileAsync`.** Four services each re-promisified `execFile` locally; they now import the shared `core/utils/exec` helper (single source, no drift).
- **Hardened DB enum reads.** `workflow-rule-storage` and `context-zone-storage` validated stored enum strings via raw `as` casts; they now validate against the allowed set and fall back to a safe default (the pattern `spec-storage` already used), so a stale/renamed DB value can't propagate a bad union member.
- **Fixed a silently-swallowed error in the file scanner.** `files-tool` had a `// Log but continue` comment with no actual log; non-ENOENT errors (e.g. EACCES) are now debug-logged so "scan found 0 files" is diagnosable. Still never fatal.

Verified not a risk (audit follow-up): `prepare: lefthook install` does not run on registry installs (`npm/bun -g`) — it's dev-only, so it doesn't violate the no-install-time-scripts constraint.

Robustness sweep: close an entire class of "works in the terminal, broken via the daemon" bugs — and add a test so it can't come back.

### Fixed
- **Commands silently dropped their flags when run through the daemon.** A command whose cold handler (`core/index.ts`) reads option flags but has no explicit `case` in the daemon dispatcher fell through to the option-less registry path, dropping every flag. Beyond `embeddings` (fixed in 2.37.3), this hit:
  - `prjct capture "…" --tags … --force` — tags and the secret-override were dropped (an explicit `capture` is registered, so it skipped the unknown-verb auto-route and fell through).
  - `prjct init --pack … --persona … --yes` — onboarding pack/persona selection was ignored.
  - `prjct regen --md` — agents got non-md output.
  - `prjct login --url …`, `prjct logout`, `prjct auth` — flags/args dropped.
  Each now has an explicit dispatch case mirroring the cold path (and `init` correctly uses the request's cwd, not the daemon's).

### Internal
- New `dispatch-option-parity.test.ts`: every option-bearing cold command must be either cold-handled (`_binCommands`) or explicitly cased in the daemon dispatcher. CI now fails if a future option-taking command reintroduces this drift.

Hot-path performance (batch 2 from the optimization audit) — the UserPromptSubmit hook fires on every prompt and blocks context injection, so its DB work is the most worth trimming.

### Performance
- **Inbox depth is now a `COUNT`, not a 200-row overfetch + deserialize.** The prompt hook read up to 200 event rows, JSON-parsed each, filtered by type, and used only `.length`. New `projectMemory.countByType()` runs a single exact-type `COUNT` — and reports the true count instead of capping at 50.
- **Improvement-signal recall is now an exact-type query.** It used the generic `recall({types:['improvement-signal']})`, which does a broad `type LIKE 'memory.remember.%'` 4× overfetch + JS type-filter. New `projectMemory.recallByType()` queries the one exact type, newest-first, using the index. Together these cut the every-prompt hook from up to three `events` overfetch-scans to targeted indexed lookups.

Deferred (audit batch 2 remainder): stop-hook transcript read-once + step parallelization, embeddings backfill delta query, FTS5 prefix-index rebuild — all detached/session-end work, lower priority than the per-prompt path.

Confirmed-bug batch from a full optimization audit (4 parallel reviewers, each finding adversarially verified — two "high severity" findings turned out false and were dropped).

### Fixed
- **`prjct embeddings set --key …` silently lost its flags via the daemon.** `embeddings` had no explicit case in the daemon dispatcher, so it fell through to the option-less registry path — the key never reached the command (the "stale daemon" confusion from 2.34.0). Added an explicit `embeddings` case mirroring the cold path.
- **Codex skill pointed at a non-existent `prjct recall` verb.** Introduced in 2.36.0; Codex would auto-capture it as an inbox note. Replaced with `prjct context memory <topic>`.
- **`prjct_mem_forget` was a no-op with a description that claimed it deleted.** Implemented `projectMemory.forget()` — deletes the source `events` row, soft-deletes the `memories` FTS mirror, and drops any stored embedding, so a forgotten entry stops surfacing in recall, search, and semantic search.

### Performance
- **Recall no longer filesorts on every prompt.** Recall queries (`… WHERE type LIKE 'memory.remember.%' ORDER BY id DESC`) fire on every UserPromptSubmit hook; migration 20's `(type, timestamp DESC)` index couldn't satisfy the `id`-ordered sort, so SQLite ran a separate filesort each time. Added `idx_events_type_id ON events(type, id DESC)` (migration 26) so it's an ordered index scan.

### Changed
- **Quality-workflow methodology rewritten as behavior, not procedure** (in the pulled `workflows.md` reference). The `review` / `qa` / `security` / `investigate` / `ship` / `audit` sections were numbered step-by-step lists (40 procedural steps); they now describe the *observable outcome* — "what good looks like" — and let the agent discover the how. Stop-conditions, the per-role model policy, and the parallel-dispatch mechanics are kept verbatim (those are concrete operational rules, not procedure). Rationale (Deep SWE / Theo): over-specified step-by-step prompts flatter weak models and add noise; behavior-framed prompts force end-to-end exploration and let capable models self-verify. Aligns the methodology with prjct's own anti-harness ethos.

## [2.37.1] - 2026-06-01

Context-efficiency, part 3: trim the recurring per-turn surfaces.

### Changed
- **Per-prompt topical-memory injection is now selective, not padded.** It fires on every prompt. Previously, when FTS/BM25 returned fewer than 8 matches it padded the set up to 8 with weaker recency/substring matches — spending tokens on low-relevance entries every turn. Now it injects exactly the BM25-ranked matches and only falls back to the recency window when FTS returns *nothing* (fresh DB / no indexed match). Narrow prompts inject few, highly-relevant entries instead of a padded eight. Also condensed the per-block preamble that repeated verbatim each prompt.
- **MCP tool descriptions condensed** (~820 → ~680 tokens) without losing the "when to call" signal — they load into context whenever the prjct MCP server is connected.

Context-efficiency, part 2: cut the Claude skill's always-on footprint by 73%.

### Changed
- **Claude skill split into a lean core + pull-on-demand `workflows.md`.** The SKILL.md body stays in the model's context for the whole session ("every line is a recurring token cost"). It was ~9.3k tokens of always-on context. Now the core is ~2.5k tokens (use-when, project context, TRIAGE gate, a compact intent→verb→tier table, routing tiers, gotchas) and the heavy methodology (quality workflows, subagent dispatch + model policy, decision-brief, prefs, builder ethos) lives in `workflows.md`, written next to SKILL.md and read only when the agent actually runs one of those workflows. Same pull-not-push rule as the rest of the runtime; behavior preserved.

## [2.36.0] - 2026-06-01

Context-efficiency pivot (push → pull): stop filling the agent's context window, fix Codex, expose anticipation on demand.

### Fixed
- **Codex skill no longer rejected.** The Codex `SKILL.md` exceeded Codex's hard 1024-byte limit (1085 B), so prjct silently failed to load in Codex entirely. Rewrote it as a minimal router (~870 B) that points at the CLI + MCP instead of inlining instructions.

### Added
- `prjct guard <file>` — anticipation primitive: the preventive memory (gotchas / anti-patterns / recurring-bugs) recorded against a file, pulled on demand before editing. Quiet by design ("clear to edit" when nothing matches).
- `prjct_guard` MCP tool — the same anticipation, pull-based, for Claude and Codex (Codex has no hook system; both reach it here).
- Installer now prunes retired prjct-managed hooks from existing settings.

### Changed
- **Pillar 3 anticipation is now pull, not push.** Replaced the `pre-edit` PreToolUse hook (which could inject into every edit) with the on-demand `prjct guard` CLI + `prjct_guard` MCP tool — the agent asks when it matters instead of prjct pushing into context.

## [2.35.0] - 2026-05-31

### Added
- feat: pillar 3 anticipation — PreToolUse(Edit|Write) hook surfaces a file's gotchas/anti-patterns/recurring-bugs before you edit it, so traps are prevented not repeated

## [2.34.0] - 2026-05-31

### Added
- RAG reorientation pillars 1+2: selective memory (embed only model-building knowledge, prune noise) + developer profile (developer.md from feedback+friction so the LLM acts as the dev)

## [2.33.0] - 2026-05-31

A project-memory RAG overhaul — recall that never bloats, never guesses on vocabulary, ingests your documents, and a vault that is synthesis rather than a mirror. Consolidates 2.32.3–2.32.8.

### Added

- Semantic recall **on by default** for every project — a zero-dependency local embedder (feature-hashed character n-grams) vectorizes memory into SQLite, catching morphological / cross-vocabulary matches BM25 misses.
- Global **BYOT embeddings**: `prjct embeddings set|status|test|clear` — bring one API key, stored in the macOS Keychain (else a 0600 file), used by every project. OpenAI-compatible (OpenAI, Ollama, LM Studio).
- **Bidirectional vault ingest**: drop text files (`.txt/.json/.csv/.md`, auto-chunked) or binary/rich docs (`.pdf/.docx/.rtf`/images, extracted via `textutil`/`pdftotext`/`tesseract` with zero bundled dependency) into `captured/` — they become vectorized memory.
- `architecture.md` is now synthesized for **every** project (from decisions + gotchas), not only when an LLM analysis exists.

### Changed

- Capture **dedups** on `(type, content)` — a verbatim re-capture is skipped, so detectors firing each session can't bloat the store.
- Memory content is authored in **English** by convention, for cleaner embeddings and better LLM comprehension.
- Vault sprawl cut ~46%: a single `releases/index.md` rollup (was one file per version), and opaque machine tag-pages (hash/session/…) dropped.
- `prjct ship` infers the semver bump from the change — `feat` → minor, `fix`/`chore` → patch, breaking → major — instead of always bumping patch.

### Fixed

- friction-detector cross-session dedup compared a 64-char hash to a 12-char key, re-recording the same pushback every session. Migration v25 backfills `content_hash` and purges historical duplicates from both memory tables.

## [2.32.1] - 2026-05-30

### Bug Fixes

- a correction must not credit its own inline reference (#390)

## [2.32.0] - 2026-05-30

### Features

- learn from mistakes automatically — no command needed (#389)

## [2.31.0] - 2026-05-30

### Features

- negative reinforcement — learn from mistakes too (#388)

## [2.30.0] - 2026-05-30

### Features

- ship-success attribution — strongest reinforcement signal (#387)

## [2.29.0] - 2026-05-29

### Features

- reinforcement loop — recall gets smarter with use (#386)

## [2.28.0] - 2026-05-29

### Features

- optional semantic search via embeddings (phase 3 — complete) (#385)

## [2.27.0] - 2026-05-29

### Features

- author-declared compaction in recall (phase 3) (#384)

## [2.26.0] - 2026-05-29

### Features

- traverse the relationship graph on recall (phase 3) (#383)

## [2.25.0] - 2026-05-29

### Features

- parallel executor fan-out + reconcile skill-vs-crew (#382)

### Performance

- serve hooks from the warm daemon (~9x faster per hook) (#381)

## [2.24.3] - 2026-05-29

### Performance

- hook hot-path benchmark (phase 0 instrumentation) (#380)

## [2.24.2] - 2026-05-29

### Performance

- retrieval quality + robustness hardening (phases 1/2/4) (#379)

## [2.24.1] - 2026-05-21

### Bug Fixes

- include chore/build/ci commits in auto-changelog Maintenance section (#378)

### Maintenance

- dead _-prefixed defs round 2 + iCloud conflict-dir sweep + knip in CI (#376)

## [2.24.0] - 2026-05-21

### Features

- FTS5 BM25 recall + hot-path parallelization + smarter tokenizer (v2.23.18) (#375)

## [2.23.8] - 2026-05-19

### Bug Fixes
- crew leader templates no longer grant blanket `.prjct/` write permission — the previous "Edits to `.prjct/` … you may edit directly" line let the leader create `.prjct/audits/`, `.prjct/CHECKPOINTS.md`, `.prjct/deploy/RAILWAY-CHECKLIST.md` in client repos, violating the absolute-persistence rule. Allowlist now scoped to `.prjct/prjct.config.json`; added explicit "Hard persistence rule" section in both `templates/crew/agents/leader.md` and `templates/crew/CLAUDE-leader-mode.md`. Guard test extended (`FORBIDDEN` += audits/deploy/CHECKPOINTS paths, plus positive assertion that the canonical config path is named as the only edit-allowed file under `.prjct/`).

## [2.23.7] - 2026-05-18

### Added
- Repair required SQLite native dependencies during package install, `prjct install`, and daemon startup.
- Configure only required MCP defaults (`context7` and `prjct`); Linear and Jira remain manual optional integrations.

### Changed
- Document native dependency repair in the README, install prompt, and SQLite migration guide.

## [2.23.6] - 2026-05-18

### Added
- test: regression guards for per-role subagent model policy

## [2.23.4] - 2026-05-18

### Bug Fixes

- vault: link cross-references by the note's real slug/basename, not the `mem_N` frontmatter alias — Obsidian's Graph view resolves links by path/basename and ignores aliases, so v2.23.3's alias-only links were graph-invisible (with `hideUnresolved` the relations disappeared entirely). Relations now render as actual graph edges.

## [2.23.3] - 2026-05-18

### Bug Fixes

- vault: one note per memory entry → reconnected, human-legible Obsidian graph; titles not mem_N keys; idTypeIndex from full set; relation tags no longer fragment into orphan stubs (fixes "todas las relaciones se perdieron")

## [2.23.2] - 2026-05-18

### Bug Fixes

- vault makes every mem_N navigable — Obsidian anchors + linkified cross-refs (mem_3233) (#356)

## [2.23.1] - 2026-05-18

### Bug Fixes

- orchestrator triage-first — stop funneling every action through spec+reviewers (#355)

## [2.23.0] - 2026-05-18

### Features

- resolvable + legible memory references (no more opaque mem_NNNN) (#354)

### Bug Fixes

- make prjct upgrade bulletproof — no silent misroute, no stale-daemon, no downgrade (#353)

## [2.22.1] - 2026-05-18

### Bug Fixes

- changelog generator PROMOTES [Unreleased] instead of stranding it (mem_2895 root cause) (#352)

## [2.22.0] - 2026-05-18

### Features

- prjct update self-cleanup of parallel installs + prjct upgrade alias + one-command notify (WS4+WS5) (#347)

### Bug Fixes

- WS3b — ship-atomicity marker + serialized daemon request handling (#350)
- WS2b SQLite hardening — BEGIN IMMEDIATE txns, statement-cache + daemon-cache gating (#349)
- WS3 P2 reliability — timer leak, backup clobber, daemon-exit, WAL checkpoint, duplicate-POST (#348)

## [2.21.1] - 2026-05-18

### Bug Fixes

- route all remaining os.homedir()/.prjct-cli sites through pathManager (#344)
- optimistic CAS on StorageManager.update() — close the lost-update data race (#346)
- gate workflow rules ingested from repo markdown (close clone-to-RCE) (#345)

## [2.32.8] - 2026-05-31

### Added
- global BYOT embeddings: one securely-stored API key (Keychain) for all projects + prjct embeddings command

## [2.32.7] - 2026-05-31

### Added
- vault signal cleanup: collapse release/tag sprawl + always-on architecture.md synthesis

## [2.32.6] - 2026-05-31

### Added
- binary ingest extractors: zero-dep auto-detect (textutil/pdftotext/tesseract) for PDF/Office/images

## [2.32.5] - 2026-05-31

### Added
- ingest pipeline: multi-format text drops + chunking (bidirectional vault INPUT, auto-vectorized)

## [2.32.4] - 2026-05-31

### Added
- embeddings ON por defecto (local subword, universal, cero-dep) + auto-upgrade + convención de contenido en inglés (RAG #2)

## [2.32.3] - 2026-05-30

### Added
- memory dedup en capture + heal histórico (RAG #1): content-fingerprint, dedup net en remember(), fix friction-detector 64-vs-12, migración v25 backfill+purga

## [2.32.2] - 2026-05-30

### Added
- current work

## [2.24.3] - 2026-05-30

### Added
- current work

## [2.23.18] - 2026-05-20

### Added
- Perf round 2 + LLM recall quality (FTS5 BM25, hot-path parallelization, camelCase tokenizer)

## [2.23.17] - 2026-05-20

### Added
- Deep cleanup: legacy/dead code + verbose comments cut

## [2.23.16] - 2026-05-20

### Added
- current work

## [2.23.15] - 2026-05-20

### Added
- Audit followups 2: regression tests para prompt-injection, exec hardening defense-in-depth, legacy-crew-sweep env gate

## [2.23.14] - 2026-05-20

### Added
- current work

## [2.23.13] - 2026-05-20

### Added
- Audit followups: docs tightening, scripts orphans verified, CHANGELOG archive split, migrate-json deprecation track

## [2.23.12] - 2026-05-20

### Added
- current work

## [2.23.11] - 2026-05-20

### Added
- Audit cleanup: prompt-injection defense, perf paralelización, crew identity por nombre+color, vault sweep fix

## [2.23.10] - 2026-05-20

### Fixed
- Retry native SQLite dependency repair before daemon startup and keep install flows non-blocking when repair is deferred.

## [2.23.9] - 2026-05-20

### Added
- Repair required SQLite native dependencies during package install, `prjct install`, and daemon startup.
- Configure only required MCP defaults (`context7` and `prjct`); Linear and Jira remain manual optional integrations.

### Changed
- Document native dependency repair in the README, install prompt, and SQLite migration guide.

## [2.23.5] - 2026-05-18

### Added
- perf: per-role subagent model policy + everything-in-prjct persistence

## [2.23.4] - 2026-05-18

### Added
- vault: link by note slug not alias — fix Obsidian graph (alias links graph-invisible)

## [2.23.3] - 2026-05-18

### Added
- vault: nota por entrada + grafo conectado legible (fix relaciones perdidas)

## [2.21.0] - 2026-05-17

### Features

- **`prjct review-risk [--md]`** — advisory size/delivery-geometry signal (minimal cut of harnesses #18/19/20). Reads the committed changeset vs the merge-base with the default branch (`git diff --shortstat`), derives a size tier (trivial/normal/large) and suggests a delivery geometry (`direct`/`single`/`split`, with the touched top-level dirs as natural split lines). Read-only/Tier-1 (retro/health shape); never gates, never splits, never mutates git; graceful no-signal when there is no base or nothing committed. (#340)

## [2.20.2] - 2026-05-17

### Added

- **Architecture guard: SQLite connection factory is now an enforced invariant.** `openDatabase()` in `core/storage/database/sqlite-compat.ts` already baked the daemon-safety PRAGMAs (`journal_mode=WAL`, `busy_timeout=5000`) into every connection, but nothing stopped a future caller from doing a raw `new Database(...)` / `require('bun:sqlite')` / `require('better-sqlite3')` and silently bypassing them — the open half of the HIGH-severity daemon-vs-CLI write-lock anti-pattern. New `core/__tests__/storage/sqlite-factory-guard.test.ts` scans `core/` + `bin/` and fails CI if any file outside the sanctioned factory acquires a driver, and separately asserts the factory keeps both PRAGMAs. Closes the anti-pattern by moving it from convention to enforced. No runtime code change. (#342)

### Bug Fixes

- skill routing triages complexity FIRST — spec is the exception, not the default (v2.20.1) (#341)

## [2.20.1] - 2026-05-17

### Fixed

- **skill-miss-detector no longer false-positives after a crew run (#16 follow-up) (#339).** Crew implementer/reviewer run as isolated subagents in the *shared* working tree, so at the leader's Stop hook `getModifiedFiles()` saw their edits and path-overlap relevance fired — but the leader transcript never carries the memory references the subagent made in its own isolated transcript, producing a false skill-miss nag for every crew-touched file. Fix: `detectSkillMisses` collects the `files_touched` of crew runs whose `ended_at` is within `CREW_RUN_RECENCY_MS` (6h) via `crewRunStorage.list` and excludes them from path-overlap relevance; token-overlap detection stays active so non-crew work in the same session is still covered. Crew itself is unchanged (it was architecturally correct). Best-effort — any failure degrades to prior behavior. Tests: `core/__tests__/services/skill-miss-detector.test.ts`.

## [2.20.0] - 2026-05-17

### Added

- **Skill Resolution Feedback (harness #16, spec `08344b7d`).** At Stop, `core/services/skill-miss-detector.ts` flags captured project knowledge (`decision` / `gotcha` / `anti-pattern`) that was relevant to the session's work but never referenced — a "skill-miss" — and persists it as an `improvement-signal` tagged `source:skill-miss-detector`. Transcript-primary; changed-file overlap is a best-effort booster via `getModifiedFiles()` (absent on a clean tree → degrades to token overlap, never errors). Precision-leaning: relevance needs a path hit OR ≥2 distinctive shared tokens; `inferred`-provenance and captured-this-session memories are excluded; hashed `(type,key)` dedup makes Stop re-runs idempotent (mirrors `friction-detector`).
- **`prjct skill-adherence [window] [--md]`** — read-only QA surface: skill-misses vs resolutions over a window (7d default), with an addressed ratio. Same Tier-1 read-only contract as `prjct retro` / `prjct health`.

### Changed

- **`buildImprovementSignals` now carries both detectors under one block.** The recall no longer hard-filters `source:friction-detector`; friction and skill-miss signals render under the existing `# prjct: improvement signals` header with **per-source budgets** (friction ≤3, skill-miss ≤2) so a noisy friction session can't starve skill-miss out of the shared 24h window. No parallel block (session-start advisory density stays bounded). The `resolves:` prose is extended with `resolves:skill-miss`; the 24h age-out remains the actual drop-from-rotation mechanism (a real `resolves:` consumer stays owned by the memory close|forget spec).

### Fixed
- **`getProjectId` no longer silently mints a random orphan project.** Root cause: `ConfigManager.getProjectId()` fell through to `pathManager.generateProjectId()` (`crypto.randomUUID()`) whenever `readConfig()` returned null, so any path-resolution miss (daemon resolving the wrong cwd, config transiently unreadable, case-variant path) forked a brand-new project and scattered specs/memory across ghost projects with no error surfaced. Now returns `''` — the falsy sentinel 31/32 call sites already guard with `if (!projectId)` → callers fail loud ("run prjct init") instead of writing into a random new project. Only explicit `prjct init` (`createConfig`) mints. Regression test: `core/__tests__/infrastructure/config-manager-getprojectid.test.ts`.

## [2.19.9] - 2026-05-16

### Bug Fixes

- strictly-monotonic updated_at so the CAS token can't collide (#337)

## [2.19.8] - 2026-05-14

Crew-mode persistence v7 (spec a50b32d1). SQLite becomes the single source of truth for crew runs, team enrollment, and checkpoint customization. Disk mirrors exist only where an external read contract demands one (the pre-commit hook).

### Breaking changes

- **`.prjct/CHECKPOINTS.md` is no longer authoritative.** `prjct crew install` does not write it anymore; the reviewer agent template carries the current checkpoints content embedded between `<!-- prjct:checkpoints:start/end -->` markers, spliced in at install time from `kv_store['crew:checkpoints']`. Existing customizations are migrated automatically on first `prjct sync` post-upgrade (the disk file is left in place but no longer read at run time; delete it once you've verified the migration).
- **`.prjct/team.json` is now a derived mirror.** `prjct team` writes the kv_store row first (DB = source of truth), then regenerates the disk file atomically (`.tmp` + `fs.rename`). The pre-commit hook string in `core/commands/team.ts` is unchanged — it still reads `.prjct/team.json` because the hook must work before prjct is installed on a new contributor's machine. **Do not hand-edit the mirror** — edits will be silently overwritten on the next team write. Run `prjct team check` to detect/heal drift.
- **`SqliteStatement.run` return type widened** from `void` to `{ changes: number }` in the compat wrapper. Both drivers already returned this shape at runtime; the wrapper was discarding it. Non-breaking for callers that ignore the return (grep-verified — no caller in core/ consumes the value).

### Added

- **`prjct crew record-run`** — persists one row per crew session at kv_store key `crew-run:<id>` with `{spec_id?, task_id?, started_at, ended_at, implementer_summary, files_touched, reviewer_verdict, reviewer_notes?}`. Idempotent on caller-supplied `--run-id`. Vault renders to `~/Documents/prjct/<slug>/_generated/crew-runs/<slug>-<ts>.md`.
- **`prjct crew checkpoints [show|set|reset|export]`** — kv_store CRUD for the reviewer's checkpoint gate. `set` errors fast (exit 2 + stderr) when stdin is a TTY and no `--content` / `--file` flag is given. `export` empty-state emits the bundled default + stderr log `(exporting bundled default; no user customization set)`.
- **`prjct team check`** — drift detector + self-heal for `.prjct/team.json`. Canonical-JSON byte-equality between disk and DB. On drift, rewrites the mirror atomically. Three cases: adopt-disk-into-DB on migration, rewrite-mirror-on-drift, no-op on both empty.
- **`prjct spec breakdown <id> [--force]`** — manual recovery / re-trigger for `breakdownSpecToTasks`. Default gate: status='reviewed' or later. `--force` bypass emits an audit event (`type=spec.breakdown.forced`) and echoes the mem id on stdout.
- **`SpecContent.tasks_created_at: string | null`** — completion marker for breakdown idempotency. Zod nullable default null; absorbs legacy rows without a DB migration.
- **`specStorage.casUpdate(projectId, specId, content, expectedUpdatedAt): boolean`** — optimistic-concurrency UPDATE on the specs table for the recordReview retry loop.
- **`queueStorage.deleteByFeatureId(projectId, featureId): Promise<number>`** — partial-breakdown recovery helper (wipes queue rows tagged with the spec's `featureId`).
- **`prjctDb.listDocsByPrefix<T>(projectId, prefix)`** — kv_store prefix scan, used by `crew-run-storage.list()`.
- **`writeFileAtomic(filePath, content)`** in `core/utils/file-helper.ts` — atomic `.tmp` + `fs.rename` write.
- **Wiki regen**: new `crew-runs/<slug>-<ts>.md` page per recorded crew session + `team.md` reflecting the enrollment row. New `runBuilder()` isolation helper wraps the two new builders so a malformed row doesn't abort the rest of the regen.
- **Build-time architecture guard** in `scripts/build.js` — bundle fails if any shipped template references `.prjct/sessions/`, `.prjct/CHECKPOINTS.md`, or `.prjct/team.json`.
- **Regression tests**: `spec-storage-cas.test.ts` (CAS happy path + stale read + marker preservation), `spec-task-breakdown-partial-recovery.test.ts` (fresh, idempotent re-entry, wipe-and-retry on partial state).

### Fixed

- **`recordReview` concurrent-write race.** Previously last-write-wins via `updateContent` — two concurrent reviewers could clobber each other's verdict. Now reads the spec + its `updated_at`, mutates `content.reviews` in memory, writes via `specStorage.casUpdate`. On rows-affected=0 → retry up to 3× with 50ms backoff. After exhaustion → throws `SPEC_RECORD_REVIEW_CONFLICT_RETRY_EXHAUSTED`. `breakdownSpecToTasks` runs OUTSIDE the CAS (it awaits async work — JSON file writes + event publishes — which cannot live inside a synchronous SQLite transaction). The CAS guarantees only one writer observes `draft→reviewed` per attempt, so breakdown fires at most once.
- **`breakdownSpecToTasks` crash recovery.** Previously "skip if linked_tasks non-empty" left the spec wedged forever on a mid-loop crash (queue rows inserted but `linkTask` never called → re-runs early-returned). Now uses a `tasks_created_at` completion marker (set ONLY after the full loop completes) + a wipe-by-featureId recovery branch (marker null + linked_tasks non-empty → delete partial queue rows, clear linked_tasks, re-run the full loop). Convergence guaranteed by bounded retry, not transactional safety.

### Migration

- On first `prjct sync` post-upgrade, the sync service runs a `legacy-crew-sweep` phase that detects `.prjct/CHECKPOINTS.md` and `.prjct/team.json`, migrates their content into kv_store (`crew:checkpoints` with `source='migrated'`; `team:enrollment` + atomic mirror regen), and captures an inbox note. The legacy files are left in place — delete them when you've verified the migration. Subsequent hand-edits to the legacy files fire a one-shot inbox warning (mtime-cached so the warning doesn't repeat on every sync).

## [2.19.7] - 2026-05-13

### Changed
- **SQLite connection factory centralized.** `openDatabase()` in `core/storage/database/sqlite-compat.ts` now bakes `PRAGMA journal_mode=WAL` + `PRAGMA busy_timeout=5000` into every connection it returns. The duplicated PRAGMA calls in `core/storage/database.ts` and `core/storage/system-database.ts` were removed, and `system-database.ts` no longer ships its own copy of the `bun:sqlite` / `better-sqlite3` shim. Eliminates the regression class behind the v2.19.0 sync hang — a new SQLite caller cannot forget the daemon-safety pragma because the factory enforces it.

## [2.19.6] - 2026-05-13

### Fixed
- **Crew mode no longer writes `.prjct/sessions/` files into the customer's working tree.** The shipped templates (`templates/crew/agents/{leader,implementer,reviewer}.md`, `CHECKPOINTS.md`, `CLAUDE-leader-mode.md`) previously instructed subagents to persist plan / impl notes / review verdicts as loose markdown files under `.prjct/sessions/<task-slug>/<role>.md`. This violated the product invariant (SQLite + regenerated vault are the only allowed persistence surfaces) and was customer-reported. Subagents now reply inline; durable state goes through `prjct` CLI verbs only.

### Added
- Build-time guard in `scripts/build.js` that fails the bundle if any template under `templates/` reintroduces a forbidden persistence path (currently: `.prjct/sessions/`).
- Regression test `core/__tests__/commands/crew-templates-no-disk-writes.test.ts` asserting the same invariant at unit-test time.

## [2.19.5] - 2026-05-13

### Added
- current work

## [2.19.4] - 2026-05-11

### Bug Fixes

- Stop `prjct ship` from creating two release commits per invocation. Root cause: the production CLI shim emitted by `generateDaemonShim()` in `scripts/build.js` had a 5s timeout and unconditionally called `fallback()` on timeout/error/close — re-importing `prjct-core.mjs` in-process while the daemon kept running. For any daemon-routed command that took longer than 5s (notably `ship`, whose push step alone is ~10s), the in-process fallback ran a second copy that saw the daemon's first commit at HEAD, bumped the version again, and produced a duplicate release commit. Sync the shim's fallback policy with the hardening from commit d08727b8 (May 1): timeout = 30s, refuse to re-execute on anything except `ECONNREFUSED`/`ENOENT`. Adds 4 regression tests in `core/__tests__/infrastructure/daemon-shim-sync.test.ts` that fail if the shim's policy drifts from the source again.

## [2.19.3] - 2026-05-11

### Features

- `prjct daemon restart` — graceful stop (with force-kill fallback) followed by a fresh spawn. Mirrors the existing top-level `prjct restart` shortcut so users who think of `daemon` as a noun discover it under the same namespace as `start`/`stop`/`status`.
- `prjct daemon logs [--lines=N | -n N] [--all] [--follow|-f]` — prints the tail of `~/.prjct-cli/run/daemon.log`. Defaults to the last 50 lines; `--all` dumps the entire file; `-f` streams via `tail -f` and forwards SIGINT for clean exit.
- The unknown-subcommand error now lists all five `daemon` subcommands.

## [2.19.2] - 2026-05-11

### Bug Fixes

- `prjct sync` hung indefinitely when the daemon held concurrent RW handles on `prjct.db` (no error, no daemon log activity). Set `PRAGMA busy_timeout = 5000` on every SQLite connection (per-project DB + system DB) before migrations run, so writer/schema lock contention waits instead of failing silently or hanging.
- Added per-phase `log.debug` instrumentation in `syncService.sync()` covering all numbered phases (context7, migrate, sweep, gather, incremental, index, skills, update-files, metrics, archive, install-global, verify). Visible via `PRJCT_DEBUG=debug` for future hang diagnosis.
- Wrapped heavy phases without internal abort paths (migrate, gather, index) with a 60s timeout (`Promise.race`, configurable via `PRJCT_SYNC_PHASE_TIMEOUT_MS`). On timeout, sync now fails with `sync phase '<phase>' timed out after Nms` instead of hanging from the user's perspective.

## [2.19.0] - 2026-05-05

### Features

- Phase 1.6 — close the wire on Phase 1.5 (B1-B4) (#324)

## [2.18.1] - 2026-05-05

### Bug Fixes

- make spec update --json a PATCH (shallow merge), not full replace (#323)

## [2.18.0] - 2026-05-05

### Features

- auto-breakdown spec acceptance criteria into queue tasks on audit pass (#322)

## [2.17.0] - 2026-05-05

### Features

- Phase 1.6 — brownfield-aware SDD (auto-context + codebase reviewers + inventory) (#321)

## [2.16.0] - 2026-05-04

### Features

- Phase 1.5 — harden sync engine for prjct-cloud (B1–B8) (#319)

### Bug Fixes

- drop unused imports in entity-handlers (#320)

## [2.15.0] - 2026-05-03

### Features — SDD: Spec-Driven Development (#318)

prjct now ships an end-to-end SDD primitive. The canonical sequence is `spec → audit-spec → task --spec → implement → ship (acceptance gate) → remember learning`.

- **`prjct spec "<title>"`** — first-class verb. Drafts a spec with structured fields (goal, eli10, stakes, acceptance_criteria, scope, out_of_scope, risks, test_plan). Persists to a new `specs` SQLite table and mirrors a memory event so `prjct context memory spec` finds it.
- **Sub-verbs:** `prjct spec list | show | update | set-status | record-review | link-task | ship | audit`.
- **`prjct audit-spec <id>`** — emits a parallel-subagent dispatch prompt. Three reviewers (strategic / architecture / design) run in parallel via the Agent tool and write verdicts back via `prjct spec record-review`. All three pass → spec auto-promotes `draft → reviewed`.
- **`prjct task --spec <id>`** — links a task to its spec (`tasks.linked_spec_id`). Without it, `ship` has nothing to gate against.
- **`prjct ship` acceptance gate** — when the active task has a linked spec, ship surfaces the spec's `acceptance_criteria` as a checklist before proceeding. Override with `--no-spec-gate`.
- **Vault rendering** — specs auto-render to `~/Documents/prjct/<slug>/_generated/specs/<slug>.md` on every regen, with a status-grouped index at `_generated/specs/_index.md`.
- **Skill body** — Claude is taught the SDD canonical sequence and the `spec` / `audit-spec` verbs in the intent map. The skill body's verb intent map now leads with `spec` for substantive work; `task` is the right call for routine work that doesn't deserve a spec.
- **Templates** — `templates/spec-template.md`, `templates/spec-reviewer-rubrics/{strategic,architecture,design}.md`, `templates/sdd-canonical-sequence.md`. Old `templates/planning-methodology.md` renamed to `planning-methodology-deep.md` (retained but de-defaulted).

- self-heal prjct SKILL.md on every CLI invocation (#317)

### Schema

- Migration 16 adds the `specs` table and the `tasks.linked_spec_id` column. Additive — existing memory and tasks unaffected.
- `'spec'` added to `BASE_MEMORY_TYPES`.

## [2.14.3] - 2026-05-02

### Refactoring

- split 19 files >500 LOC into SRP modules (#316)

## [2.14.2] - 2026-05-03

### Refactoring

- DRY pass + analysis/sync-service splits (consolidates #312-#314) (#315)

## [2.14.1] - 2026-05-03

### Refactoring

- split 1522-line workflow.ts into SRP modules (#311)
- split 746-line setup.ts into SRP modules (#303)
- zod-validate analysis-save-llm input (#310)
- single source of truth for verb→handler dispatch (#309)
- IndexRegistry — unify bm25/import-graph/git-cochange (#308)
- split 1454-line wiki-generator into pure builders (#307)
- introduce runHook<I> runner — DRY the hook quartet (#305)

## [2.14.0] - 2026-05-02

### Features

- cleanup + friction-detection + proactive improvement loop (#302)

## [2.13.0] - 2026-05-02

### Features

- project CLAUDE.md routing + onboarding rewrite (UX phase 4+5) (#301)

## [2.12.0] - 2026-05-02

### Features

- inject project state per turn (UX phase 3) (#300)

## [2.11.0] - 2026-05-02

### Features

- verb intent map + suggest/auto-execute protocol (UX phase 1+2) (#299)

## [2.10.1] - 2026-05-02

### Bug Fixes

- zero-out every quality check (typecheck/lint/tests/knip) (#298)

## [2.10.0] - 2026-05-02

### Features

- prjct context-save / context-restore (gstack Fase D) (#296)

## [2.9.0] - 2026-05-02

### Features

- prjct health — composite quality dashboard (gstack Fase C/5) (#295)

## [2.8.0] - 2026-05-02

### Features

- prjct retro — weekly engineering retrospective (gstack Fase C/6) (#294)

## [2.7.0] - 2026-05-02

### Features

- gstack Fase B — question registry + 'stop asking me about X' (#293)

## [2.6.0] - 2026-05-02

### Features

- gstack Fase A — ethos preamble + memory dedupe (#292)

## [2.5.0] - 2026-05-02

### Features

- adopt gstack patterns — subagent dispatch + audit orchestrator + decision-brief (#291)

## [2.4.43] - 2026-05-02

### Added
- current work

## [2.4.42] - 2026-05-02

### Added
- current work

## [2.4.41] - 2026-05-02

### Added
- current work

## [2.4.40] - 2026-05-02

### Added
- perf: cache context7 verify to disk + dead-code cleanup (3.5x faster sync direct path)

## [2.4.39] - 2026-05-02

### Added
- current work

## [2.4.38] - 2026-05-02

### Added
- current work

## [2.4.37] - 2026-05-02

### Added
- current work

## [2.4.36] - 2026-05-02

### Added
- current work

## [2.4.35] - 2026-05-02

### Added
- current work

## [2.4.34] - 2026-05-02

### Added
- current work

## [2.4.33] - 2026-05-02

### Added
- current work

## [2.4.32] - 2026-05-02

### Added
- current work

## [2.4.31] - 2026-05-02

### Added
- current work

## [2.4.30] - 2026-05-02

### Added
- current work

## [2.4.29] - 2026-05-02

### Added
- current work

## [2.4.28] - 2026-05-02

### Added
- current work

## [2.4.27] - 2026-05-02

### Added
- current work

## [2.4.26] - 2026-05-02

### Added
- current work

## [2.4.25] - 2026-05-02

### Added
- current work

## [2.4.24] - 2026-05-02

### Added
- current work

## [2.4.23] - 2026-05-02

### Added
- current work

## [2.4.22] - 2026-05-02

### Added
- current work

## [2.4.21] - 2026-05-01

### Added
- current work

## [2.4.20] - 2026-05-01

### Added
- current work

## [2.4.19] - 2026-05-01

### Added
- current work

## [2.4.18] - 2026-05-01

### Added
- current work

## [2.4.17] - 2026-05-01

### Added
- current work

## [2.4.16] - 2026-05-01

### Added
- current work

## [2.4.15] - 2026-05-01

### Added
- current work

## [2.4.14] - 2026-05-01

### Added
- current work

## [2.4.13] - 2026-05-01

### Added
- current work

## [2.4.12] - 2026-05-01

### Added
- current work

## [2.4.11] - 2026-05-01

### Added
- current work

## [2.4.10] - 2026-05-01

### Added
- current work

## [2.4.9] - 2026-05-01

### Added
- current work

## [2.4.8] - 2026-05-01

### Added
- current work

## [2.4.7] - 2026-05-01

### Added
- current work

## [2.4.6] - 2026-05-01

### Added
- current work

## [2.4.5] - 2026-05-01

### Added
- current work

## [2.4.4] - 2026-05-01

### Added
- current work

## [2.4.3] - 2026-05-01

### Added
- current work

## [2.4.2] - 2026-05-01

### Added
- current work

## [2.4.1] - 2026-05-01

### Added
- current work

## [2.4.0] - 2026-05-02

### Features

- per-project MCP scoping — list, deny, allow

### Bug Fixes

- feat(mcp): per-project MCP scoping — list, deny, allow

## [2.3.11] - 2026-05-02

### Bug Fixes

- never silently re-run a command that may have partially run

## [2.3.10] - 2026-05-02

### Bug Fixes

- upgrade every detected global install, not just one

## [2.3.9] - 2026-05-02

### Bug Fixes

- remove orphaned context/CLAUDE.md checks; gate auto-update banner

## [2.3.8] - 2026-05-02

### Bug Fixes

- runtime-resolve npm for zsh+nvm setups
- collapse legacy unmanaged duplicates on install
- runtime-agnostic package manager handling

## [2.3.7] - 2026-05-01

### Bug Fixes

- regression tests for bugs surfaced in 2.3.5 → 2.3.6

## [2.3.6] - 2026-05-01

### Bug Fixes

- add `crew` to daemon-shim skip list

## [2.3.5] - 2026-05-01

### Refactoring

- rename `harness` command to `crew` to avoid concept collision

## [2.3.4] - 2026-05-01

### Bug Fixes

- switch to OIDC trusted publishing for npm releases

## [2.3.3] - 2026-05-01

### Bug Fixes

- bump to 2.3.3 to recover from npm publish outage

## [2.3.2] - 2026-05-01

### Features

- .github/workflows: Migrate workflows to Blacksmith runners (#265)

### Bug Fixes

- drop dynamic node -e from update checker (scanner mitigation)

## [2.3.1] - 2026-05-01

### Bug Fixes

- sync bun.lock with package.json (unblock --frozen-lockfile)

## [2.3.0] - 2026-04-30

### Features

- opt-in multi-agent harness mode (#264)

## [2.2.18] - 2026-04-25

### Added
- current work

## [2.2.17] - 2026-04-25

### Added
- current work

## [2.2.16] - 2026-04-25

### Added
- current work

## [2.2.15] - 2026-04-25

### Added
- current work

## [2.2.14] - 2026-04-25

### Added
- current work

## [2.2.13] - 2026-04-25

### Added
- current work

## [2.2.12] - 2026-04-26

### Performance

- silence Stop nag + drop variable content from SessionStart (cache stability) (#261)

## [2.2.11] - 2026-04-25

### Added
- current work

## [2.2.10] - 2026-04-25

### Added
- current work

## [2.2.9] - 2026-04-25

### Bug Fixes

- replicate bare-verb auto-route to capture (#258)

## [2.2.8] - 2026-04-25

### Bug Fixes

- re-export getActiveProvider (regression from #256) (#257)

## [2.2.7] - 2026-04-24

### Added
- current work

## [2.2.6] - 2026-04-24

### Added
- current work

## [2.2.5] - 2026-04-24

### Bug Fixes

- seed main-branch gate + trailing newline in writeJson (#255)

## [2.2.4] - 2026-04-24

### Bug Fixes

- stop hook counts ships/captures/tags as checkpoints (#254)

## [2.2.3] - 2026-04-23

### Refactoring

- workflow-first dispatcher + ambiguity gate (#253)

## [2.2.2] - 2026-04-22

### Bug Fixes

- sandboxable config resolver + stop leaking to real config

## [2.2.1] - 2026-04-22

Follow-up to 2.2.0: the vault was generated at the right location but
Obsidian refused to open it via `obsidian://open?vault=<slug>` because
the folder wasn't registered in Obsidian's global vault list. Users had
to manually "Open folder as vault" the first time.

### Added
- `core/services/obsidian-vault.ts`: `ensureObsidianVault(vaultPath)`
  does two things, idempotently:
  1. Bootstraps a minimal `.obsidian/app.json` inside the vault so
     Obsidian treats the folder as already-initialized (and skips its
     trust prompt).
  2. Registers the vault path in Obsidian's config file
     (`~/Library/Application Support/obsidian/obsidian.json` on macOS,
     `$XDG_CONFIG_HOME/obsidian/obsidian.json` on Linux,
     `%APPDATA%\obsidian\obsidian.json` on Windows). The vault then
     shows up in the Vault Switcher after a restart.
  Best-effort — quietly skips registration when Obsidian isn't
  installed (no config directory). Bootstrap still runs so the vault
  is valid the moment the user does run Obsidian.
- `wiki-generator.ts` calls `ensureObsidianVault(wikiRoot)` at the end
  of every regen. `.catch(() => undefined)` guard: never fail a regen
  because Obsidian glue misbehaved.
- Tests in `core/__tests__/services/obsidian-vault.test.ts` cover
  bootstrap, URL-encoding of vault names, registration append (keeps
  prior vaults), idempotency, and the no-Obsidian-installed path.

### Operator note

First-time upgraders from <2.2.1: Obsidian caches its vault list in
memory. Close Obsidian fully (⌘Q on macOS, File > Exit on Windows/
Linux) and relaunch — the newly-registered vault will appear in the
switcher.

## [2.2.0] - 2026-04-22

Obsidian vault location moved out of the repo. Each project now has its
own visible vault at `~/Documents/prjct/<slug>/` instead of the hidden
`<repo>/.prjct/wiki/` path. Two reasons:

1. The `.prjct/` prefix is a dotfile — Finder/Explorer hide it by
   default, so users who opened Obsidian looking for their vault often
   couldn't find it. The new path lives under `~/Documents/prjct/`,
   visible without toggling hidden files.
2. Privacy-by-default. The old path lived inside the repo and got
   committed on any `git add -A` unless the user remembered to
   `.gitignore` it — leaking private decisions, learnings, and gotchas
   on push.

### Changed (BREAKING — path, not API)
- Default vault path: `~/Documents/prjct/<slug>/` where `<slug>` is
  derived from the project directory name (basename, lowercased,
  slugified). Callers that hard-coded `.prjct/wiki/` will no longer find
  the vault there.
- `core/infrastructure/path-manager.ts` exposes a new `getWikiPath()`
  resolver as the single source of truth. Both `wiki-generator.ts` and
  `wiki-ingest.ts` route through it.

### Added
- `vaultPath` field in `.prjct/prjct.config.json` (optional string) —
  overrides the default. Accepts absolute paths, `~/...`, or
  project-relative paths (e.g. `"./docs/wiki"` to keep the vault
  in-repo). Use `"vaultPath": ".prjct/wiki"` to keep pre-2.2.0 behaviour
  verbatim.
- Auto-migration: the first `prjct remember`/`ship`/`context wiki sync`
  after upgrade detects a legacy `.prjct/wiki/` folder and moves its
  contents to the new location. Cross-filesystem moves (EXDEV) fall
  back to copy + delete. Idempotent.
- `.gitignore` gets a `.prjct/wiki/` entry appended when a git repo is
  detected during migration, so the legacy folder doesn't show up in
  `git status` if a tracked copy was ever committed.
- Tests:
  - `core/__tests__/infrastructure/path-manager-wiki.test.ts` covers the
    resolver (defaults, overrides, slug collisions, project-relative
    rollback).
  - `core/__tests__/services/wiki-migration.test.ts` covers the move
    (no-op cases, conflict detection, gitignore dedup).

### Migration notes

- **Nothing breaks for users who accept the default.** The first
  wiki-touching command after upgrading moves your existing
  `.prjct/wiki/` to `~/Documents/prjct/<repo-name>/` with a one-line
  stderr notice, then continues. Second invocation is silent.
- **To keep the old path**, add `"vaultPath": ".prjct/wiki"` to
  `.prjct/prjct.config.json`. The migration respects the override and
  leaves the legacy folder alone.
- **Conflict handling**: if you somehow already have content at both
  the legacy path and the new default, the migration refuses to
  overwrite and prints a warning. Merge manually or pick a side via
  `vaultPath`.

## [2.1.2] - 2026-04-22

Upgrade-safety pass for clients coming from 1.x or 2.1.0. The 2.1.1
release fixed the CLI surface but left two upgrade hazards that clients
could hit in the wild.

### Fixed
- **Zombie daemon after global upgrade.** pnpm's content-addressable
  store leaves the previous-version files untouched on disk when a new
  version is installed globally, so the long-lived daemon kept serving
  requests from the old build. The thin shim's mtime-based stale check
  never fired. Daemon now reads its own `package.json` at startup,
  periodically probes the globally-installed `prjct` binary
  (pnpm/npm/volta/asdf paths covered), and shuts itself down on
  version mismatch — the next request spawns a fresh daemon.
  (`core/daemon/daemon.ts`)
- **Orphan `workflow_rules` after v1 → v2.** v1 users could attach hooks
  to command verbs that v2 narrowed `HookCommand` to `[task, done,
  ship, sync]`. Rules keyed on `pause/resume/reopen/next/dash/bug/idea/
  linear/jira/tokens/velocity/plan` survived the upgrade as dead rows
  that `prjct workflow list` still surfaced. SQLite migration v15
  disables them idempotently (enabled=0, not deleted — visible with
  `--include-disabled` for rename/re-enable). Only the orphans —
  `done/ship/task/sync` hooks are preserved.
  (`core/storage/database.ts`, migration v15)

### Added
- Upgrade-path test coverage in
  `core/__tests__/storage/upgrade-v1-to-v2.test.ts`: seeds a v1-shaped
  DB, asserts orphan rules are disabled, valid hooks survive, and the
  legacy task-status values (`in_progress`/`done`/etc.) still coerce
  correctly through the state machine.

### Migration notes

- Upgrading from 1.x: no action required. On first `prjct <cmd>` after
  install, any stale daemon detects the version drift and exits; the
  next invocation starts a clean daemon and runs migration v15 the
  first time each project's DB is touched.
- Orphan rules show as `disabled` in `prjct workflow list
  --include-disabled`. Rename their `command` to a v2 `HookCommand`
  value (`task`/`done`/`ship`/`sync`) and re-enable if still relevant.

## [2.1.1] - 2026-04-22

Closes the v2 migration gap shipped (incompletely) in `2.1.0` and
`2.0.0-alpha.12`. The v2 sweep deleted the v1 workflow verbs (`done`,
`pause`, `resume`, `next`, `reopen`, `dash`, `bug`, `idea`, `linear`,
`jira`, `tokens`, `velocity`, `plan`) in favour of the `status`/`capture`
primitives — but left the templates, state machine prompts, the
installed `CLAUDE.md`, and the context config pointing at ghosts. The
result was two user-visible regressions (P0 bugs):

### Fixed
- **P0 — silent-capture data loss.** Typing `prjct done`/`prjct pause`
  on an active task no longer quietly files a note called "done" into
  the inbox. Removed verbs now short-circuit with a migration message
  and exit 1. Matching check added on both the fallback path
  (`core/index.ts`) and the daemon path (`core/daemon/daemon.ts`).
  New module: `core/commands/removed-verbs.ts` is the single source of
  truth for the migration map.
- **P0 — `prjct ship` degraded prereleases.** `bumpPatch` stripped the
  prerelease suffix (`2.0.0-alpha.12` → `2.0.1`), corrupting the alpha
  channel on every ship. Rewritten to follow semver rules:
  `2.0.0-alpha.12` → `2.0.0-alpha.13`, `0.1.0-beta` → `0.1.0-beta.1`,
  stable bumps unchanged. Build metadata (`+xyz`) is dropped to match
  npm/pnpm behavior. Test coverage added in
  `core/__tests__/services/version-service.test.ts`.

### Changed
- State machine (`core/workflow/state-machine.ts`) prompts and
  `formatNextSteps()` now emit executable `prjct …` invocations that
  map to the v2 CLI. `done`/`pause`/`resume`/`reopen` are surfaced as
  `prjct status <value>`. Internal `WorkflowCommand` tokens stay for
  lifecycle validation.
- `canTransition()` error wording is state-transition-centric instead of
  advertising non-existent CLI verbs.
- `core/config/command-context.config.json` bumped to `2.0.0` and pruned
  to registered v2 verbs only. Removed mappings for
  `done/dash/next/pause/resume/idea/bug/spec/feature/cleanup/design/now/history/test/work/build/review/refactor/fix`.
- `GLOBAL_CLAUDE_MD_CONTENT` (`core/infrastructure/command-installer.ts`)
  rewritten: auto-activate list is the v2 surface; a concise v2
  lifecycle cheat-sheet replaces the ghost-verb flow.
- `CommandMethodName` (`core/types/commands.ts`) narrowed to registered
  method names. `WorkflowCommand` (`core/types/workflow.ts`) no longer
  includes `next` (never was a real transition).

### Migration (for `prjct` users upgrading from v1.x)

| v1 verb | v2 replacement |
|---|---|
| `prjct done` | `prjct status done` |
| `prjct pause` | `prjct status paused` |
| `prjct resume` | `prjct status active` |
| `prjct reopen` | `prjct status active` (on completed task) |
| `prjct next` | `prjct status` |
| `prjct dash` | `prjct status` + web dashboard |
| `prjct bug "…"` | `prjct capture "…" --tags bug` |
| `prjct idea "…"` | `prjct capture "…" --tags idea` |
| `prjct linear …` / `prjct jira …` | MCP server (`prjct seed list`) |
| `prjct tokens` / `prjct velocity` / `prjct plan` | removed |

### Operator note

Upgrading from `1.x` while a long-running daemon is alive may leave a
stale process bound to the socket. Run `prjct daemon stop` once after
install, or kill the pid in `~/.prjct-cli/run/daemon.pid`.

## [2.1.0] - 2026-04-22

### Features

- current work

## [2.0.0-alpha.12] - 2026-04-21

Summary of the alpha.6 → alpha.12 arc and the dead-code / harness sweep
that closed it. Covers five commits on `v2/cut`: 28eb87e0, e3a163cb,
4c661bde, d59612a5, b1cd664f.

### Added (alpha.6 → alpha.11, landed earlier in the arc)
- **Hook pack**: `prjct claude install` writes 7 passive hooks into
  `~/.claude/settings.json` (SessionStart / UserPromptSubmit /
  PreToolUse / PostToolUse / Stop / SubagentStart / CwdChanged).
  Each hook emits `additionalContext` from project memory + persona;
  nothing blocks unless a hand-rolled workflow rule says so.
- **Persona per project** (`.prjct/prjct.config.json#persona`):
  `role`, `focus`, `mcps`, `packs`. Injected by every hook.
- **Packs (5)**: `code`, `daily`, `pm`, `founder`, `research` as
  declarative JSON manifests — no bash seeded, just memory types +
  workflow-slot names + hook signals + suggested persona.
- **`prjct capture`** — GTD inbox verb. Bare `prjct "..."` now
  routes here (was `task`).
- **14 base memory types + user-defined**: `fact`, `decision`,
  `learning`, `gotcha`, `pattern`, `anti-pattern`, `shipped`,
  `inbox`, `todo`, `idea`, `insight`, `question`, `source`,
  `person`. Any lowercase identifier also accepted.
- **Workflow step types**: `script:<path>`, `mcp:<server>:<tool>`,
  `persona:context`. Scripts live in `.prjct/workflows/*.sh` and
  receive `PRJCT_BRANCH` / `PRJCT_FILES_CHANGED` / `PRJCT_TAGS` env.

### Removed (this sweep — 16,859 LOC across 58 files)
- **Outcome subsystem** (`outcome-recorder/storage/learner/analyzer`):
  zero write callsites anywhere in the codebase; every read returned
  empty. Downstream velocity / estimate-history / learn-from-outcomes
  features went with it.
- **Agentic stack** (`command-executor`, `loop-detector`,
  `plan-mode`, `context-builder`, `prompt-builder`,
  `orchestrator-executor`, `memory-system`, `semantic-memories`,
  `pattern-store`, `memory-stores`, `domain-classifier`,
  `response-validator`). `workflow.now()` (`prjct task` entry
  point) rewired to persist via `stateStorage` directly +
  `executeWorkflowRules`; no more detour through the orchestration
  chain.
- **Pre-v2 MCP tools** (`patterns.ts`, `session.ts`, `review.ts`,
  `context.ts`): duplicated what `projectMemory` already does.
  `prjct_mem_save / _list / _similar / _forget` in `memory.ts` is
  now the single MCP memory surface, wired to `projectMemory`.
  `prjct_patterns` in `project.ts` reads the same store.
- **Six outcome-backed MCP tools** (`prjct_velocity`,
  `_outcomes_search`, `_outcomes_similar`, `_outcomes_recent`,
  `_estimate_accuracy`, `_velocity_detail`).
- **Ghost verbs** (`sessions`, `tokens` — no handlers).
- **Harness CLI context subtools** (`files`, `signatures`,
  `imports`, `recent`, `summary` under `prjct context` — Claude has
  Glob / Grep / Read / git natively). Internals kept for MCP.
- **Seven phantom dispatcher entries** (`diff`, `seal`, `rollback`,
  `verify`, `analysis-payload`, `analysis-save-llm`, `analysis-llm`)
  that routed to methods deleted in earlier alphas — 8 pre-existing
  TS errors gone.
- **Gate cache** + **bilingual NL parser** in `workflow.ts` (alpha.10).
- **Obsolete config files / types / utils**: `core/cli/arg-parser`,
  `core/events/pub-sub`, `core/schemas/roadmap`,
  `core/session/task-session-manager`, `core/session/utils`,
  `core/commands/context-contract`, `core/schemas/outcomes`,
  `core/schemas/classification`, `core/schemas/llm-output`,
  `core/constants/commands`, `core/session/session-log-manager`,
  `core/tools/context/recent-tool`, `core/utils/agent-stream`,
  `core/utils/jsonl-helper`, `core/utils/subtask-table`.

### Changed
- `workflow.now()` 346 → ~120 LOC. `prjct task` (no arg) now shows
  the active task instead of failing validation; `command-data.ts`
  marks the description optional.
- `context.ts#context` emits the same JSON shape but `domains` /
  `primaryDomain` / `subtasks` are empty — no more intent guessing.
  Use `prjct tag` to classify explicitly.
- `analysis.ts` inlines `pathManager.getFilePath` instead of pulling
  `contextBuilder`. Stats endpoint keeps its output shape for
  backward compat; `patternsSummary` fields are zeros.
- `shipping.ts` drops `memorySystem.learnDecision` /
  `recordWorkflow` calls — redundant with `shippedStorage.addShipped`
  (which `projectMemory` reads as `type=shipped`).
- MCP server registers 5 tool groups (was 9): memory, project,
  files, workflow, code-intel.

### Verified
`prjct init --pack … --persona …`, `sync`, `task` (with + without
arg), `remember`, `capture`, `context memory`, `seed list`,
`SessionStart` / `CwdChanged` hooks with persona — all green on a
fresh tmp project. `bun test`: 756 pass / 0 fail. `tsc --noEmit`: 0
errors (was 8 pre-existing). `knip`: 0 unused files.

## [2.0.0-alpha.5] - 2026-04-20

Wiki performance pass — answers the "SQLite vs Obsidian markdown graph"
question by making the hybrid (SQLite source-of-truth + markdown cache)
cheap enough that there's no reason to pick only one.

### Incremental regen (O-1)
`core/services/wiki-generator.ts` now keeps a `.manifest.json` of
`{relPath: sha256}` per generated file. On regen:
- build every file body in memory
- sha256 each, diff against the manifest
- write only files whose hash changed
- delete files that were in the old manifest but not the new
- always rewrite the manifest itself (tiny)

For the common delta (one new memory entry touching 1-2 files), the
wiki now writes those 1-2 files instead of the whole tree. ~100ms →
<5ms in the write-bound case.

### Deferred under daemon (O-2)
New `regenerateWikiDeferred(projectPath, projectId)`. When the daemon
sets `PRJCT_IN_DAEMON=1`, it fires the regen via `setImmediate` and
returns immediately — the CLI response flushes before the regen
touches disk. CLI path (no daemon) still awaits because
`process.exit` would drop the pending promise. `primitives.remember`
and `shipping.ship` call the deferred wrapper.

### File-size cap via chunking (O-3)
Any memory bucket (type or tag-value pair) with more than 50 entries
is paginated:

```
memory/decision.md         ← index with links
memory/decision/chunk-1.md ← 50 entries
memory/decision/chunk-2.md ← 50 entries
…
```

Tag pages go deeper: `tags/<key>/<value>.md` instead of cramming all
values under a single `tags/<key>.md`. An agent that reads one chunk
or one tag page stays under ~5K tokens regardless of corpus size.

### Bottom line
The hybrid is now the right answer on every axis: SQLite still wins
writes + complex queries, markdown still wins LLM comprehension +
token-per-read, and the cost of keeping them in sync is near-zero.

## [2.0.0-alpha.4] - 2026-04-20

Quality pass — applies every finding from the three-round line-by-line
review. No new user-facing verbs; everything is tightening what's already
in alpha.3.

### DRY
- `core/commands/verb-names.ts` — single source for the auto-route
  allowlist, imported by both bin (zero-heavy-imports path) and the
  daemon dispatcher. Adding a verb touches one list instead of two.
- `core/memory/events.ts` — constants for event prefixes so
  `'memory.remember.%'`, `'memory.task.tagged'`, etc. stop drifting
  between writer and reader.
- `core/commands/guards.ts` — `requireProjectId` / `requireActiveTask`
  helpers kill the duplicated 3-line preamble every v2 primitive used to
  carry.
- `MEMORY_TYPES` is now a single `const` tuple in `project-memory.ts`
  with the `MemoryType` union derived from it. `primitives.ts` imports it
  instead of maintaining a parallel list.

### Perf
- Workflow engine hot path: dynamic imports moved to static top-level,
  the two `git diff` execs run in parallel, and `buildWhenContext` is
  skipped entirely unless a rule in this phase actually reads it
  (conditional rule or gate). Saves ~30ms on the plain hook/step case.
- `when-evaluator.globToRegex` single-pass walker with a compile cache.
  Same pattern tested against N files only compiles once.

### Bugs / UX
- `prjct status` (no args) now shows the real task status recovered from
  `status.changed` events instead of misrepresenting the task `type` tag
  as the status.
- Auto-route no longer swallows typos: a single-token input within
  edit-distance 2 of a known verb surfaces a `did you mean` instead of
  silently creating `prjct task "shipp"`.

### Security
- Wiki lives at `.prjct/wiki/_generated/`. The top-level `.prjct/wiki/`
  is user-owned — any notes you put there survive rebuilds. Only the
  generated subdir gets wiped.
- Workflow rules gain `trust_source` (schema v14). Rules with
  `trustSource === 'imported'` refuse to run their shell action, buying
  forward-compat for a future template registry without shipping it as
  an arbitrary-code-execution vector.
- `prjct remember` refuses content matching obvious secret patterns
  (sk-… tokens, GitHub PATs, AWS access keys, Slack tokens, bearer
  JWT-ish strings) unless `--force` is passed.

### Cleanup / smell
- Magic numbers in `recall()` replaced with `OVERFETCH_FACTOR` and
  `DEFAULT_RECALL_LIMIT` constants with comments explaining the 4×.
- Wiki regenerates on `prjct remember` too — not just `prjct ship`.
  Subagents reading `_generated/` see newly captured memory without
  waiting for the next ship.
- Wiki now surfaces inferred `patterns` + `anti-patterns` from
  `prjct sync`, rendered at `_generated/patterns.md` with an
  INFR provenance note so agents can weight them accordingly.
- Fragile `§§` glob placeholder replaced by a single-pass walker.

### Schema
New migration v14 `workflow-rules-trust-source`:
- `workflow_rules.trust_source TEXT NOT NULL DEFAULT 'local'`

## [2.0.0-alpha.3] - 2026-04-20

Fourth alpha — adds two high-leverage borrows from the graphify review:
provenance tags on memory entries and an agent-crawlable wiki under
`.prjct/wiki/`.

### Memory provenance
Every `MemoryEntry` now carries a `provenance` field so Claude can
calibrate trust when reading memory:

  DECL  — declared by user / LLM via `prjct remember`
  EXTR  — extracted from verifiable project state (ships, tags)
  INFR  — inferred by pattern extractor or heuristic (weakest)
  AMBG  — mixed / unclear

Surfaced as a prefix in `prjct context memory --md`:

    ### DECISION
    - `DECL` [mem_15] use SQLite
    ### LEARNING
    - `DECL` [mem_8] bun faster than npm  _(area=perf)_

Ships auto-tag as `EXTR`; user `remember` calls default to `DECL`. Future
pattern/heuristic-backed entries can override with `INFR`.

### Agent-crawlable wiki
New `core/services/wiki-generator.ts` writes `.prjct/wiki/` on every
`prjct ship`:

    .prjct/wiki/
      index.md            — entry point with links to everything
      ships/<slug>.md     — one file per shipped feature
      memory/<type>.md    — one file per memory type
      tags/<key>.md       — one file per tag key

Subagents can read these with native Read/Glob — no CLI round-trip into
SQLite, zero tokens until the file is opened. New `prjct context wiki`
rebuilds on demand.

### Why these, not the rest of graphify
graphify's knowledge-graph engine (NetworkX + Leiden + vis.js) is a
harness pattern that duplicates what the LLM + file-scorer already do for
a solo-dev codebase. Multimodal PDF ingest is out of scope. The
long-running `--watch` daemon burns tokens. The `--mcp` server fragments
the toolbox. We took the two ideas that fit the v2 philosophy and left
the rest.

Hash cache + post-commit hook were already present in prjct
(`core/domain/file-hasher.ts` + `core/services/hooks-service.ts`) — no
duplication needed.

## [2.0.0-alpha.2] - 2026-04-19

Third alpha — finishes the workflow engine upgrades from the Phase 4 plan.
Custom workflows can now be written once and execute efficiently.

### Conditional rules
New `when_expr` column on `workflow_rules` with a tiny DSL:

```
when: tags:type=bug
when: branch~main files:*.ts
when: tags:domain=frontend
```

Supported: `tags:key=value` / `tags:key~value` (contains), `branch=` / `branch~`,
`files:<glob>` (glob against the current diff). Multiple tokens AND
together. Empty / null → unconditional.

### Parallel hooks
Hooks now run concurrently via `Promise.all` by default. Opt out per rule
with `parallel: false` — those run sequentially ahead of the batch so
ordering-dependent cleanups still work. Gates and steps stay sequential.
Typical speedup on the common "3 independent hooks" case: ~3x.

### Gate result cache
Gate passes are cached in a new `workflow_rule_cache` table, keyed on
`(files changed, tags, branch)`. Default TTL 1 h. Only successful passes
are cached — failures always re-run so the user sees a fresh error. Any
rule edit invalidates its cache. The win: `tsc` / `eslint` gates don't
re-run on every task start when nothing relevant has moved.

### Schema
New migration `v13 workflow-rules-v2`:
- `workflow_rules.when_expr TEXT` (nullable)
- `workflow_rules.parallel INTEGER NOT NULL DEFAULT 1`
- `workflow_rule_cache(rule_id, context_hash, ran_at, ttl_ms)` table

All backward-compatible: existing rules keep running without `when_expr`
and with parallel=true.

### New files
- `core/workflow/when-evaluator.ts` — DSL parser + evaluator (~100 LOC)
- `core/workflow/gate-cache.ts` — cache API + SHA-256 context hasher

## [2.0.0-alpha.1] - 2026-04-19

Second alpha — finishes the four-PR arc planned for v2 so the new shape is
usable, not just carved out.

### Auto-route (PR 2)
- `prjct arregla el checkout lento` → `prjct task "arregla el checkout lento"`.
  Unknown verbs flow straight to task; explicit verbs still win. Works with
  and without the daemon (bin/prjct.ts uses a hardcoded allowlist, core
  dispatcher checks the registry).

### Lazy context (PR 3)
- `prjct task` output collapsed from ~2,400 chars to ~400. No more eager
  `findRelevantFiles` / pattern briefing / RPI / efficiency sections at
  task start — Claude pulls them on demand.
- New context topics:
    prjct context memory [topic]       → facts, decisions, learnings…
    prjct context learnings [topic]    → learning + anti-pattern + gotcha

### Project memory API (PR 4)
- `core/memory/project-memory.ts` — one surface over events-table entries
  (from `prjct remember`) and `shipped_features` rows. Exposes
  `remember / recall / similar` plus a compact markdown renderer.
- `prjct remember` auto-captures the active task id as `source`.

### Workflow engine (PR 4)
- Step actions with prefix `status:` run through the state-machine instead
  of `execAsync`. Custom workflows can now do:
    - step: lint
    - step: test
    - step: status:shipped
  and the final step closes the loop declaratively.

### Fixes
- `tag` param spec `<pairs...>` — previous `<k:v> [<k:v>...]` tripped
  `validateCommandParams` and blocked valid invocations.

## [2.0.0-alpha.0] - 2026-04-19

**BREAKING.** First alpha of the v2 rewrite — "toolbox for LLMs, not harness".

### Removed integrations (pure MCP gateways, no native value)
- `prjct jira` — use Jira MCP directly
- `prjct linear` — use Linear MCP directly
- `prjct obsidian` — use Obsidian MCP or a custom hook

### Removed verbs (status-changes & ceremony)
- `done`, `pause`, `resume`, `next` — status transitions, handled by workflows or `prjct status`
- `bug`, `idea`, `spec` — replaced by `prjct task` + `prjct tag type:bug`
- `cleanup`, `undo`, `redo`, `history`, `recover`, `enrich`, `design` — maintenance ceremony
- `dash`, `stats`, `perf`, `velocity`, `tokens`, `sessions` — observability, not primitives
- `worktree`, `parallel`, `conductor` — harness patterns

### New primitives
- `prjct status [value]` — inline task status change (Linear-style escape hatch)
- `prjct tag <k:v> [<k:v>...]` — Claude attaches tags; no heuristic classifier
- `prjct remember <type> "<content>"` — capture project memory (fact, decision, learning, gotcha, pattern, anti-pattern, shipped)

### CLI surface (v2 minimal)
- Core: `task`, `ship`, `workflow`, `context`, `status`, `tag`, `remember`
- Bootstrap: `init`, `setup`, `login`, `logout`, `update`, `uninstall`

### Skills (~/.claude/skills/)
- Kept: `prjct-context`, `prjct-task` (toolbox-style rewrite), `prjct-ship`, `prjct-workflow`
- Dropped: 12 dead skills matching removed commands

### Stats
- ~7,000 LOC removed across integrations, aux commands, templates, and tests
- Skills bundle: 16 → 4  |  templates bundle: 71 → 52 files
- Build output: 1.61 MB → 1.40 MB (-13%)

### Coming next (not in this alpha)
- PR 2 — dispatcher auto-route (`prjct "fix bug"` → `prjct task`)
- PR 3 — lazy context injection (`prjct task` < 50 tokens)
- PR 4 — workflow engine upgrade: status-transitions as steps, conditionals, parallel hooks, cache, rich project-memory API

---

## v1.x and earlier

Older releases moved to [CHANGELOG.archive.md](./CHANGELOG.archive.md). Full history also visible via `git tag -l` and the GitHub Releases page.
