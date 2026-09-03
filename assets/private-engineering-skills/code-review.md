# Code review

Review a pinned diff along two independent axes: **Standards** and **Spec**.

Budget: one bounded pass over changed hunks plus direct dependencies. Do not
scan the whole repository, launch helper agents, or repeat a clean pass. Report
at most 8 actionable findings in roughly 1,600 output tokens. Zero findings is
a valid result when the checked scope, relevant tests, and residual gaps are
named explicitly.

1. Resolve the fixed point supplied by the task; otherwise use the repository's explicit target/base when it is unambiguous. Verify the ref exists and inspect the three-dot diff plus intervening commits. An invalid ref or empty diff is a result, not a review.
2. Locate the originating spec from the supplied path, task/issue references, branch-matched specs, or acceptance criteria. Locate repository standards such as `AGENTS.md`, `CONTRIBUTING.md`, ADRs, and coding guides. State when either source is absent.
3. Evaluate the same diff independently:
   - **Standards:** documented-rule violations and evidence-backed design smells. Repository rules override generic heuristics; skip what tooling already enforces.
   - **Spec:** missing or partial requirements, incorrect behavior, and unrequested scope. Cite the requirement behind each finding.
4. Report findings first, ordered by severity within each axis, with file/line, evidence, impact, and the smallest useful remedy. Keep the axes separate; one cannot cancel the other. If no findings remain, say so and name residual verification gaps.

Refactoring belongs here after behavior is green. Approve it only when the diff shows a concrete smell or maintenance cost; preserve the public contract and rerun the relevant checks.
