# Stack pack: axiom-cas — correctness
extends: core/skills/correctness/SKILL.md

## Stack-specific signals

- **Giac worker lifecycle.** `src/server/giac/worker-host.ts` runs Giac in a
  forked child and recycles it on timeout or crash. Two consequences that are
  easy to break:
  - A recycle **resets Giac global state** (`sto` assignments, `assume`
    declarations). Any code that writes CAS state in one call and reads it in
    another is relying on something the host may discard at any time.
  - In-flight calls must be failed and their timers cleared on recycle. A new
    code path that awaits the worker without going through `evaluate()`'s
    pending-map bookkeeping can hang forever.
- **The engine is a process-level singleton; the MCP server is per-request.**
  Inverting that — constructing an engine per request, or caching per-caller
  state on the server — breaks the stateless HTTP transport. Module-level
  mutable state added under `src/server/tools/` is a finding: today every such
  binding is an immutable constant.
- **Result parsing.** Giac returns text. Code that indexes into that text, or
  regex-extracts a value, without handling the `list[...]`, `undef`, empty and
  error shapes will silently produce a wrong answer rather than an error.
  Silent wrong answers are the worst failure mode for this product.
- **Numeric vs exact drift.** Mixing a mathjs float result into an exact Giac
  pipeline (or formatting an exact value through `Number()`) loses exactness
  the tool promised. Watch conversions in `exact-arithmetic.ts`,
  `number-utils.ts`, `response-formatter.ts`.
- **Verification asymmetry.** `verify` exists to independently check `compute`.
  If a change makes `verify` reuse `compute`'s own result or its parsing helpers
  for the same claim, the check becomes circular and stops being evidence.

## Stack-specific remedies

- Route every Giac call through `giacEngine.evaluate()` so timeout, recycle and
  pending-call bookkeeping apply uniformly.
- Parse Giac output through the existing extractors rather than new ad-hoc
  regexes; extend the extractors when a shape is missing.
- Keep `verify`'s path independent of `compute`'s — different method, or at
  minimum a different extraction route.

## Stack-specific severity guidance

- A change that can return a **wrong mathematical result without erroring**:
  **Critical** — silent incorrectness is this product's defining failure.
- Reliance on Giac global state surviving across calls: **High**.
- A Giac call path that bypasses the timeout/recycle bookkeeping: **High**.
- Exactness lost in a conversion: **Medium**, High if it is on `compute`'s
  default path.
