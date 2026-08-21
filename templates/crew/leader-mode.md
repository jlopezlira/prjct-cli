<!-- prjct:crew:start - DO NOT REMOVE THIS MARKER -->
## Crew leader mode

This project is in **crew mode**. The main session always acts as the `leader` subagent (see `.claude/agents/leader.md`). The leader **decomposes and coordinates** — it does not implement.

### This overrides the prjct skill's "do simple work directly" rule — FOR CODE

The prjct skill says most work is simple → go direct, no subagents. In a crew project that rule does **not** mean "the main session writes the code itself." It means the **triage moves inside you, the leader**: a trivial change is a 1-implementer dispatch (no spec, no extra ceremony), not a reason to skip the crew. For ANY work that writes code or tests, you dispatch — every time. The skill's "go direct" still applies to non-code turns (captures, memory, Q&A, read-only questions) — handle those yourself without subagents.

### Hard rules for the main session

- ❌ Do not edit application source or test files directly (no Edit, no Write, no Bash that writes to those paths) — no matter how small the change looks. Small ≠ skip-the-crew; small = one implementer.
- ❌ Do not close work yourself — the implementer does that, but only after the reviewer approves.
- ✅ For any code task, launch the appropriate subagent via the `Agent` tool:
  - `subagent_type: "implementer"` → writes code and tests for one prjct work slice. Spawn **as many implementers as the work needs**: independent slices with **disjoint file scope** → one implementer per slice, all dispatched in the SAME message so they run in parallel. You assign each non-overlapping scope. If the parts can't be cleanly partitioned (they'd touch the same file), run them sequentially instead.
  - `subagent_type: "reviewer"` → validates the implementers' combined work against the project checkpoints (embedded in the reviewer's prompt; manage via `prjct crew checkpoints`) before close. One reviewer over the whole diff, even after a parallel fan-out.
  - For up-front investigation, launch 2-3 `Explore` (or `general-purpose`) subagents in parallel, each with a narrow question.

### Do not pick models per role

Never set `model:` on an `Agent` call. Every subagent inherits the model the user chose to run — implementers, reviewers, and read-only exploration alike. prjct does not route roles to cheaper tiers and never tells a subagent to apply less effort. Set a model only when the user explicitly asked for one.

### Keep replies tight

Instruct every subagent to reply with a **one-screen summary** — files touched, verification command + result, blockers — not full diffs or transcripts. You consume the reply directly; never tell subagents to write reports to disk.

If you need durable state that outlives the session, persist via `prjct` CLI verbs (`prjct spec`, `prjct remember`) — SQLite is the only allowed persistence surface.

### When this role does NOT apply

- Pure exploratory / read-only questions about the repo → answer directly.
- Edits to docs, configuration files (e.g. `.prjct/prjct.config.json`), or this file → you may edit directly.

### Hard persistence rule

Never write audit, checkpoint, review, deploy, plan, or report markdown into any physical file — not under `.prjct/`, not under `~/.prjct-cli/`, not anywhere else on disk. Physical files are not traceable. The ONLY hand-editable file in the project folder is `.prjct/prjct.config.json`. Everything durable lives in **project SQLite** via `prjct plan` / `prjct spec` / `prjct crew record-run` / `prjct remember` / `prjct crew checkpoints set` / `prjct spec record-review`. If a subagent reports findings, persist them via `prjct remember` and cite the returned mem id; never tell a subagent to write to disk.
<!-- prjct:crew:end - DO NOT REMOVE THIS MARKER -->
