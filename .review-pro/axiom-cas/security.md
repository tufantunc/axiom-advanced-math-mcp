# Stack pack: axiom-cas — security
extends: core/skills/security/SKILL.md

## Stack-specific signals

This server's entire job is evaluating attacker-controllable mathematical
expressions. Two independent evaluators sit behind the `compute`, `verify` and
`plot` tools, and each has its own escape surface.

- **mathjs instance built with `create(all, {})`** (`src/server/tools/quick-calc-service.ts`,
  `src/server/tools/plot/evaluator.ts`) leaves `import`, `createUnit`, `evaluate`,
  `parse`, `simplify` and `derivative` reachable from the expression parser.
  mathjs's own security guidance calls for disabling those for untrusted input.
  A user string reaching `.evaluate()` on an unrestricted instance is the exact
  configuration that CVE-class parser escapes target — treat any new call site
  that widens this, or any new `math.import(...)` without a matching lockdown,
  as a finding.
- **String interpolation into a Giac expression** — `giacEngine.evaluate(\`fn(${x})\`)`
  where any interpolated part derives from user input without normalization.
  Giac is a full CAS with its own assignment and program syntax; this is the
  injection analogue of building a shell command by concatenation. Check
  `src/server/tools/giac-eval.ts` and every `` evaluate(`...${}...`) `` site.
- **New `eval` / `new Function` / `WebAssembly.instantiate(buffer)`** outside
  `src/server/giac/wasm-wrapper.ts`. That file uses `new Function` deliberately
  to load the Emscripten glue and is the documented exception; anywhere else it
  is a finding.
- **Unbounded expression cost** reaching an evaluator without the worker's
  timeout in front of it. The Giac path is protected by
  `AXIOM_EVAL_TIMEOUT_MS` in `worker-host.ts`; the mathjs path has no such
  bound, so a pathological mathjs expression blocks the event loop directly.
- **Error text echoed back to the caller** that contains a filesystem path, a
  stack frame, or raw engine internals. Tool errors and the JSON-RPC `-32603`
  envelope must stay opaque.
- **HTTP transport perimeter**: `POST /mcp` has no authentication by design
  (deferred). Anything that widens what an unauthenticated caller can reach —
  removing the body limit, removing the Host allowlist, adding a route that
  bypasses them — is a finding, not a refactor.

## Stack-specific remedies

- Harden the mathjs instances: after any legitimate `import`, disable `import`
  and `createUnit` (`math.import({ import: () => { throw ... }, createUnit: ... },
  { override: true })`), or evaluate through a restricted instance.
- Normalize and validate user input into a known grammar before interpolating
  it into a Giac expression; prefer passing values through the existing
  normalizers in `src/server/tools/compute/normalize.ts` over ad-hoc templating.
- Keep every new evaluator call behind the worker timeout, or give it its own
  explicit bound.

## Stack-specific severity guidance

- A path from tool input to an unrestricted `evaluate()` that can reach
  `import`/`createUnit`/constructor access: **Critical**.
- Unnormalized interpolation into a Giac expression string: **High**.
- Removing or weakening the body limit or Host allowlist on `/mcp`: **High**.
- Engine internals or filesystem paths in a returned error: **Medium**.
