# prjct evals

`prjct eval` is the product-evaluation harness for proving whether prjct-cli gets better or worse between versions. It is deterministic by default, local-first, and publishable to the prjct cloud API when the project has active cloud sync.

## Commands

```bash
prjct eval run --candidate 2.62.0
prjct eval report --md
prjct eval compare --baseline 2.61.0 --candidate 2.62.0 --md
prjct eval run --candidate "$GITHUB_SHA" --publish --target cloud
prjct eval compare --baseline "$BASELINE" --candidate "$CANDIDATE" --publish --target cloud
```

## Local storage

Runs and comparisons are written under:

```text
$PRJCT_CLI_HOME/evals/<owner-repo-or-local-hash>/
  latest.json
  latest-comparison.json
  runs/<runId>.json
  runs/<runId>.md
  comparisons/<comparisonId>.json
  comparisons/<comparisonId>.md
```

The JSON files are the local source of truth. Markdown exists so humans can review the same evidence quickly.

## Cloud publishing

Publishing sends a structured benchmark payload to the prjct API:

```text
POST <apiUrl>/benchmarks/evals
```

A real publish requires all of these to be true:

- The directory is a prjct project (`prjct init`).
- The CLI is authenticated (`prjct login`).
- The project is linked and active in cloud (`prjct cloud link`, not paused).

Use `--dry-run` to validate the benchmark payload without sending it:

```bash
prjct eval publish --target cloud --dry-run --md
```

Every scenario and comparison carries actionables. Regressions are blocking actionables; improvements and unchanged scenarios still tell maintainers what to protect or keep measuring.

## Hook latency SLOs

The agent-runtime hot path is a release contract:

- Warm hook handler p50: **< 20ms**, observed with `prjct perf --md`.
- Cold production hook p50: **≤ 400ms** and p95: **≤ 800ms**, gated by `node scripts/bench-hooks.mjs --runtime both`.
- Prompt state payload: **≤ 700 characters** (STATE_BUDGET) and byte-hash deduplicated when unchanged.
- PreToolUse fan-out: **one prjct process per host event** (`pre-bash` or `pre-edit`); do not reinstall separate secret/package/commit processes.

Use `--no-fail` only for exploratory benchmark capture. The default benchmark exits non-zero on an SLO regression.

## CI usage

CI should run evals and upload local artifacts with the CI provider's normal artifact mechanism when needed. Publishing to the shared benchmark history is intentionally not wired to GitHub Actions in this repo; it is an explicit `prjct eval ... --publish --target cloud` operation that uses prjct cloud auth and server-side ownership/subscription checks.
