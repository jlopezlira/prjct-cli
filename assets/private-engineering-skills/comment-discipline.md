# Comment discipline

Comments capture **intent**, invariants, protocol constraints, non-obvious tradeoffs, or external reasons in the shortest form that preserves them. Prefer one precise sentence. Keep licenses, public API documentation, security warnings, generated-code markers, and genuinely complex algorithm notes at the length their contract requires.

Review only added or changed comment lines. For each comment, ask whether the code can express the same meaning through a better name, type, extraction, or test. If yes, improve the code and remove the narration. Keep the comment when it explains why the obvious implementation is wrong, records a stable invariant, links an external constraint, or prevents a likely regression.

Use current facts and vocabulary. Place the comment beside the decision it protects. Remove headings, conversational asides, implementation diaries, repeated signatures, and line-by-line descriptions of visible code. A retained comment is done when deleting it would remove information that cannot be recovered cheaply from the code or repository.
