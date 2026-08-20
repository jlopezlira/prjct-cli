# Writing for agents

Write instructions as executable policy with **positive steering**: state the target behavior first, using concrete verbs and observable completion criteria. Reserve prohibitions for hard guardrails and pair each with the action to take instead.

Treat every always-loaded line as a **context pointer**. Front-load a strong leading word that activates the intended behavior; name each genuinely different trigger branch once; remove identity and detail already carried by the target document. Reuse compact pretrained concepts such as **tight**, **red**, **seam**, or **receipt** to anchor behavior without restating paragraphs.

Protect the information hierarchy:

1. Keep ordered actions and their checkable completion criteria in the main file.
2. Co-locate each concept with its rules and caveats.
3. Put branch-specific definitions and examples behind explicit on-demand pointers.
4. Split by sequence only when visible later steps cause premature completion.

Distinguish mandatory policy, defaults, and examples. State scope, precedence, triggers, permitted actions, stopping conditions, and verification. Keep one source of truth; let code, configuration, and `--help` own facts the agent can cheaply inspect. Prune duplication, stale sediment, vague adjectives, motivational prose, and no-op instructions that do not change model behavior.

Validate the result against a normal case, a boundary case, and a tempting misinterpretation. The document is done when each branch has one reliable pointer, every step has an observable bound, and optional detail stays out of the always-loaded path.
