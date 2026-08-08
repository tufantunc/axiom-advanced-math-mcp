# Stack pack: axiom-cas — backend
extends: core/skills/backend/SKILL.md

## Stack-specific signals

- **The Workers portability boundary.** `src/server/transports/http-app.ts`
  must import **no `node:*` module, directly or transitively**. Its two
  dependencies (`healthProbe`, `createServer`) are injected precisely because
  importing them would drag `node:child_process` in through
  `giac/index.ts → wrapper.ts → worker-host.ts`. Any new direct import in that
  file, or a new option resolved by importing rather than injecting, breaks a
  property `test/http-portability.test.ts` enforces. This has already been
  breached once and caught by that test — treat it as live, not theoretical.
- **Environment reading belongs in `src/http.ts`**, never in the app factory.
  A `process.env` read inside `http-app.ts` is both a portability break and a
  layering break.
- **Statelessness.** The transport issues no `Mcp-Session-Id` and keeps nothing
  between requests. A change that adds a session map, a cache keyed by caller,
  or an in-memory rate-limit bucket to the app layer silently reintroduces the
  state the design removed and breaks horizontal scaling.
- **MCP protocol shape.** Responses must keep the JSON-RPC envelope. Method
  rejection on `/mcp` is `405` with `Allow: POST` (the MCP spec requires 405
  where no SSE stream is offered), not `404`. Parse failures are `-32700`,
  unknown paths `-32601`, internal errors `-32603`.
- **`enableJsonResponse: true` is load-bearing.** Without it the SDK transport
  answers with SSE and the `finally { transport.close() }` truncates the body to
  `""` — measured, not theoretical. Removing that option without replacing the
  cleanup strategy is a defect.
- **Tool descriptions are the model's API.** `compute`/`verify`/`plot`
  descriptions and their Zod schemas in `src/server/index.ts` are what an LLM
  reads to choose a tool. Narrowing a description, or changing a schema field's
  meaning without updating the description, degrades routing quality in a way
  no test catches.

- **Two surfaces, one contract.** The same three tools are reachable over MCP
  (`src/server/index.ts`) and from the CLI (`src/cli/commands.ts`). A guard that
  exists on only one of them is a finding, not a difference in scope. This has
  already happened once: the 8 KB input cap is declared in the zod schemas but
  enforced **only** by the MCP SDK's `server.tool(...)` dispatch, so the CLI
  shipped with no bound at all until it was added to `resolveInput`. When
  reviewing a new guard, ask which surface enforces it and check the other.
- **`bin` is public API.** `package.json` must keep exactly one `bin`. Two bins
  whose names do not match the package name make `npx -y axiom-advanced-math-mcp`
  fail with "could not determine executable to run" — the line in every MCP
  client config. Adding a second bin is a breaking change disguised as a feature.
- **Running with no arguments must start the MCP stdio server.** Every existing
  client config invokes the binary that way. Any change to argument dispatch
  that could alter the no-argument path is high severity regardless of how
  clean it looks.
- **stdout carries only requested output.** In server mode stdout is the JSON-RPC
  stream; in CLI mode it is the value a caller captures with `$(...)`. Hints,
  warnings and errors go to stderr in both. A `console.log` added to a success
  path is a contract break, not a logging preference.

## Stack-specific remedies

- Inject host-specific capabilities into `createHttpApp` instead of importing
  them; keep the app factory on Web Standards only.
- When adding a route, decide explicitly whether it belongs on the portable app
  (protocol surface) or the Node entrypoint (operational surface).
- Update the tool description whenever the schema's accepted input changes.

## Stack-specific severity guidance

- A new `node:*` import reachable from `http-app.ts`: **High** — it silently
  voids the stated architectural goal.
- Per-caller state reintroduced into the app layer: **High**.
- Dropping `enableJsonResponse` or the transport cleanup pairing: **High**.
- Tool description drifting from its schema: **Medium**.
