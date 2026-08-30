# CHECKPOINTS — End-state criteria

> In multi-agent systems you don't evaluate the path, you evaluate the destination.
> These are the objective checkboxes a reviewer (human or AI) walks through to decide
> whether the project is healthy after a session.

> **Customise this file for your project.** The defaults below cover the generic
> crew invariants. Add project-specific items (lint rules, build commands,
> deployment gates) under the matching section.

## C1 — The crew is wired

- [ ] `.prjct/prjct.config.json` exists and points to a valid project ID.
- [ ] The `crew:state` row exists in kv_store (`prjct crew status` reports complete).
- [ ] The `crew:checkpoints` row exists in kv_store (the gate criteria the reviewer applies — visible via `prjct crew checkpoints`).

## C2 — State is coherent

- [ ] At most **one** work cycle is active (`prjct work --md`).
- [ ] No active work cycle is older than the current session without a synthesized blocker note.
- [ ] Every completed work cycle has at least one paired test file (or a justified exception in the implementer report).

## C3 — The code respects the architecture

- [ ] Modified files follow the conventions of their neighbouring files (style, naming, imports).
- [ ] No new runtime dependencies were added without a `prjct remember context --tags dep-add` note.
- [ ] No debug noise: no `console.log` / `print()` / `dbg!` left in source.
- [ ] No `TODO` without a synthesized follow-up in `prjct remember`.

## C4 — Verification is real

- [ ] The project's test command was run for this session and exited cleanly.
- [ ] Every new public function has at least one test covering the happy path.
- [ ] Every new error path has at least one test asserting the error is raised/returned.
- [ ] Tests use real temp dirs / real fixtures, not blanket mocks of the filesystem or DB.

## C5 — The session closed cleanly

- [ ] No untracked junk in the worktree (`*.tmp`, scratch logs, accidental binaries, any subdirectory of `.prjct/`).
- [ ] The implementer replied inline with the summary block (STATUS / PLAN / FILES TOUCHED / VERIFICATION / NOTES).
- [ ] The reviewer replied inline with `VERDICT: APPROVED` (first line).
- [ ] The work cycle was closed or intentionally paused after reviewer approval.

---

**How to use this file:**

The `reviewer` subagent reads every checkbox, marks `[x]` for met and `[ ]` for missed,
and refuses to approve session close if any C1-C5 box remains unchecked. Customise the
list with project-specific gates (lint, typecheck, build, deploy preview, etc.).
