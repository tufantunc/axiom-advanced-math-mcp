# Stack pack: axiom-cas — tests
extends: core/skills/tests/SKILL.md

## Stack-specific signals

- **Assertions that do not pin the mathematics.** `expect(result).toBeDefined()`,
  `expect(status).toBe(200)`, or asserting only that a string is non-empty, for
  a computation whose whole value is being *correct*. A CAS test must assert the
  actual expected expression or value — e.g. `integrate(sin(x)^3,x)` →
  `-cos(x)+cos(x)^3/3`.
- **Assertions loose enough to pass on a wrong answer.** `toContain('x')` on a
  symbolic result, or a regex so permissive that a different-but-plausible
  expression satisfies it. Equivalent-form tolerance is legitimate for CAS
  output, but it must be deliberate (normalize both sides, or check symbolic
  equivalence) rather than accidental laxity.
- **Suite split.** Unit tests (`vitest.config.ts`) must not require a build;
  anything inspecting `dist/` belongs in `vitest.config.integration.ts`, which
  runs `npm run build` first. A test that reads build output from the unit
  config will validate stale artifacts or fail confusingly.
- **Guard tests that can pass vacuously.** `test/http-portability.test.ts`
  walks an import closure; if the closure is empty, a broken walker returns no
  violations and the assertion passes for the wrong reason. Any test whose
  subject can become trivially empty needs a positive control alongside it.
- **Worker-dependent tests.** Tests that exercise the Giac timeout/recycle path
  are inherently slow and stateful. They must not leave a forked child behind,
  and must not depend on ordering relative to other Giac tests (a recycle
  discards CAS globals).
- **Characterization tests.** A test that pins current *broken* behaviour must
  say so in its name and carry a comment explaining what will make it flip.
  Otherwise a future reader "fixes" the test instead of the defect.

- **Subprocess tests that leak their child.** A test that spawns the server or
  the CLI must kill it on **every** path, including the assertion failure it
  exists to detect. Putting `child.kill()` after the `await` means a timeout
  leaks the process — and the server blocks on stdin by design, so the orphan
  never exits and can stall the runner. This shipped once and was caught only
  by a whole-branch review; a `try/finally` is the fix, and a deliberate forced
  failure plus a `ps` check is the proof.
- **A test whose assertion is satisfied by the wrong half of a feature.** The
  parser's `--help` handling was tested and passing while the dispatcher
  discarded the result, so per-subcommand help never rendered. When a feature
  spans two modules, at least one test must cross the seam end to end.

## Stack-specific remedies

- Assert the exact expected CAS output; where multiple equivalent forms are
  acceptable, normalize explicitly or assert symbolic equivalence.
- Put build-dependent tests in the integration config, never the unit config.
- Pair every guard/meta test with a positive control that fails if the guard
  stops guarding.

## Stack-specific severity guidance

- A test for a computation that would pass on a wrong answer: **High** — it is
  worse than no test, because it certifies incorrectness.
- Build-dependent test in the unit config: **Medium**.
- Guard test that can pass vacuously: **Medium**, High if it is the only
  enforcement of a stated architectural property.
- Leaked child process or cross-test Giac state coupling: **Medium**.
