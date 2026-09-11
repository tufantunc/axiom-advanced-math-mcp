# Sonar sweep: every non-ODE finding (17 findings, one branch)

Scope: everything except the ODE block (extractors:326/:409, ode-system-shape
×2), deferred until the other session's branch merges. Groups, one commit
each:

- **A (round leftovers):** S3358 ×2 in formatTerm (nested ternary → if/else,
  byte-identical); S5976 in geometry.test.ts (similar refusal rows → it.each);
  S3776 number-theory:42 (dispatch → runPrimeFactorize/runAnalyze/
  runSequenceIdentify, throw convention, guards migrate); S3776 verify:376
  findMainEquals (depth tracking extracted; the == two-char skip stays inline —
  the Critical lesson).
- **B (non-ODE S3776 singles ×8):** runPlot stages; host worker-message
  dispatch; scanNonFinite object branch → scanObjectValue; sampleGrid →
  samplePoint; AdvancedSolveService.evaluate stages; chiSquareIndependence
  stages; numerical-methods per-method validators; renderSvg sections;
  formatToolResponse → answerSummary.
- **C (S5843 ×4):** UNKNOWNS_LIST, casPatterns, knownMathFns,
  NATURAL_LANGUAGE_WORDS → array-joined RegExp, sources byte-identical.
- **D (S7785 ×2):** cli.ts and http.ts promise chains → top-level await with
  identical finish/exit semantics.

Verification: per-file old-vs-new harnesses (regex source equality + behavior
matrices; real-Giac end-to-end for handlers; CLI exit-code smoke for D),
five gates after each group, review-pro correctness → tests-mutation over the
whole diff.
