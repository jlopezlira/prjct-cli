# Resolving merge conflicts

Resolve an in-progress merge or rebase from primary intent, not marker proximity.

1. Inspect the exact git state, operation, history, and unmerged files. Confirm each conflict is real and identify the two source commits.
2. Recover both intents from commits, diffs, tests, ADRs, specs, issues, or PR context. For each hunk, state what each side is trying to preserve.
3. Produce the smallest resolution that preserves both intents. When they are incompatible, follow the merge goal and repository contract, record the tradeoff, and avoid inventing unrelated behavior.
4. Verify no conflict markers or unmerged entries remain. Run the repository's focused typecheck, tests, and formatter/linter in its established order; fix only breakage caused by the resolution.
5. Continue, stage, or commit only when that action is inside the caller's authorization and the host workflow permits it. Otherwise return the resolved files, verification evidence, and exact remaining git operation.

Keep abort/reset as an explicit user decision. Preserve recoverability throughout.
