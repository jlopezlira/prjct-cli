# Diagnosing bugs

A hard bug is solved through a **tight loop**, not a plausible story. Redact secrets from every command, output, trace, and artifact.

1. **Build the loop.** Name one agent-runnable command that exercises the exact reported symptom. Prefer a failing test, HTTP/CLI script, browser assertion, trace replay, throwaway harness, fuzz loop, bisection, or differential run. Make it red-capable, deterministic, and fast. For flakes, raise the reproduction rate with repetition, concurrency, pinned time/RNG, and isolated state. If no honest loop can be built, stop, list the attempts, and request the missing access, redacted artifact, or permission for temporary instrumentation.
2. **Reproduce and minimise.** Run the command red. Remove inputs, callers, config, and steps one at a time until every remaining element is load-bearing.
3. **Hypothesise.** Write 3–5 ranked, falsifiable causes. Each states a prediction: if X is causal, changing or measuring Y will alter Z. Share the ranking, then continue without blocking.
4. **Instrument.** Test one prediction and one variable at a time. Prefer debugger/REPL, then targeted boundary logs. Tag temporary probes with one unique prefix. For performance, measure a baseline, profile or inspect the query plan, then bisect.
5. **Lock the cause down.** Convert the minimal repro into a regression test before the fix only at a seam that reproduces the real call pattern. If no correct seam exists, record that architectural gap. Apply the smallest causal fix, turn the test green, and rerun the original unminimised loop.
6. **Clean up.** Remove tagged probes and throwaway artifacts; run the focused and neighboring checks.

Finish with this compact RCA receipt:

- symptom and expected behavior;
- minimal reproduction command;
- causal mechanism and contributing conditions;
- evidence that falsified alternatives and confirmed the cause;
- why existing tests missed it;
- regression seam/test, or the missing seam;
- prevention or earlier-detection action.
