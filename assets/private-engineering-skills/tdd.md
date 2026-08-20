# Test-driven development

TDD is a vertical **red → green** loop. Tests specify behavior through public interfaces and survive internal rewrites.

Before the first test, name the public seam and confirm that it is an intended test boundary. If the interface or seam itself is uncertain, consult codebase-design before committing to test structure. Expected values come from an independent source of truth: the spec, a known-good literal, or a worked example.

For each slice:

1. Write one behavior-focused test at one agreed seam.
2. Run it and confirm RED for the intended missing behavior, not a setup error.
3. Add only enough production code to make that test pass.
4. Run it and confirm GREEN, then begin the next learned slice.

Keep slices vertical: one test, one implementation, repeat. Avoid bulk test-first plans that encode imagined behavior. Keep tests away from private methods, internal collaborator choreography, tautological expected values, and side-channel verification. Mock only a truly external or nondeterministic boundary.

Refactoring is a separate **review-stage** activity, not part of the red → green implementation loop. Once behavior is green, use code review to identify a justified refactor, preserve the public contract, and rerun the relevant suite. Report the agreed seam, red evidence, minimal green change, and verification.
