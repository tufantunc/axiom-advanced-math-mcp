# Stack pack: axiom-cas — performance
extends: core/skills/performance/SKILL.md

## Stack-specific signals

Measured baselines for this project — use them instead of guessing:

| Operation | Cost |
| --- | --- |
| Giac WASM init | ~59 ms |
| Typical Giac evaluation | 4–19 ms |
| `createServer()` + transport + connect + close (per request) | ~0.25 ms |
| Giac WASM linear memory, steady state | 64 MB |

- **Do not add caching or pooling to the per-request path.** At 0.25 ms against
  a 4–19 ms evaluation, per-request server construction is noise. A cache
  proposed to "avoid rebuilding the server" adds state to a deliberately
  stateless layer and buys nothing measurable.
- **The Giac worker must stay a process-level singleton.** It holds 64 MB of
  WASM linear memory. Constructing one per request, or per session, multiplies
  that directly — and on any 128 MB-class runtime, two of them do not fit.
- **Unbounded work reaching an evaluator.** The Giac path is bounded by
  `AXIOM_EVAL_TIMEOUT_MS` (10 s default) enforced by killing the worker. The
  mathjs path has no equivalent and runs on the event loop: a pathological
  expression there stalls every concurrent request, not just its own.
- **Serialization of the single worker.** All Giac calls funnel through one
  child process. A change that fans out N concurrent evaluations does not gain
  parallelism; it queues, and each caller's timeout still runs. Watch for loops
  that `await giacEngine.evaluate()` per element over a user-sized list.
- **Response size.** `plot` returns base64 SVG inline in the tool result. Point
  count and canvas size multiply into the model's context window, which is a
  real cost even though it is not CPU.

- **Regex backtracking on user input — measure it, do not eyeball it.** Every
  preprocessing regex runs on the caller's string, on the event loop, *before*
  any Giac call, so `AXIOM_EVAL_TIMEOUT_MS` does not bound it. This shipped:
  `/(\d+\.?\d*)\s*°/g` cost **208 seconds** on `'9'.repeat(8000) + 'x°'` — an
  8 KB input, inside `MAX_EXPRESSION_LENGTH`. Over the HTTP transport that is
  every client stalled, from one request.

  The tell is an ambiguous quantifier sequence: two ways to split the same
  characters. `\d+\.?\d*` can divide a digit run many ways; `\d+(?:\.\d*)?`
  matches the same strings exactly one way and cost 0.1 s on the same input.
  Same shape: `.*X.*`, `(\w+)\s*=`, `[\s\S]*` followed by a literal.

  Judge by measurement, not by the rule firing. Four regexes were flagged here;
  one was a 208-second denial of service and the other three measure 25–100 ms
  at the input cap — reported, bounded, correctly left alone:

  ```js
  const t = process.hrtime.bigint();
  ('9'.repeat(8192) + 'x°').replace(re, 'X');
  console.log(Number(process.hrtime.bigint() - t) / 1e6, 'ms');
  ```

- **Fix the pattern repo-wide, not the reported line.** The regex above lived in
  two files. Fixing the reported one changed the end-to-end time by nothing, and
  it took a CPU profile to notice the second copy was still there. Preprocessing
  helpers in this repo are duplicated across `quick-calc-preprocessor.ts`,
  `exact-arithmetic.ts` and `compute/normalize.ts`; after fixing one, grep for
  the pattern before believing the fix landed.

## Stack-specific remedies

- Bound any new evaluator entry point explicitly; do not assume the worker
  timeout covers a path that does not go through the worker.
- Write quantifiers with one way to match: `\d+(?:\.\d*)?` over `\d+\.?\d*`,
  `[^,]*,` over `.*,` when the next token is a literal.
- Batch multi-value CAS work into one Giac expression where the CAS supports it
  rather than looping per element.
- Keep the WASM asset loaded once per process; never re-instantiate per call.

## Stack-specific severity guidance

- A second Giac engine instantiated per request/session: **High** (64 MB each).
- An unbounded user-controlled loop of CAS calls: **High**.
- Event-loop-blocking mathjs evaluation with no timeout: **Medium**, High if it
  is on an unauthenticated HTTP path.
- A regex on user input whose measured worst case at `MAX_EXPRESSION_LENGTH`
  exceeds ~1 s: **High** — it blocks the event loop and no timeout covers it.
  Under ~100 ms at the cap: not a finding, even when the rule fires.
- Micro-optimisation of the per-request server construction: not a finding —
  it is 0.25 ms.
