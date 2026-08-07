# Hono HTTP Transport — Stateless Rewrite

**Date:** 2026-08-07
**Branch:** `feat/hono-http-transport` (from `main` @ `173e119`)
**Status:** DESIGN — approved, pending implementation plan

## Background

The project was relicensed GPL-3.0-or-later and is being released as open
source for self-hosting (commit `173e119`). That changes what the HTTP
transport is for: it is no longer the private delivery mechanism of a hosted
service, it is a thing other people will install, read, and run.

The current HTTP transport (`src/http.ts`, ~90 lines) is Express-based and
carries three problems that the open-source context makes material:

1. **Dependency weight.** Measured by installing each production dependency
   set into a clean project and reading npm's own package count:

   | Production dependency set | Packages | Disk |
   | --- | --- | --- |
   | Baseline (`sdk` + `mathjs` + `zod`, no HTTP framework) | 103 | — |
   | Current (baseline + `express@4`) | **135** | 45 MB |
   | After (baseline + `hono` + `@hono/node-server`) | **103** | 43 MB |

   Express contributes **32 packages**; `hono` and `@hono/node-server`
   contribute **zero** — both are zero-dependency, so the post-migration tree
   is byte-for-byte the baseline. Net removal: **32 packages (−24%)**.

   Note the disk saving is small (2 MB): the MCP SDK and mathjs dominate the
   tree, and no framework choice changes that. The argument here is package
   count and supply-chain surface, not install size. Most users never touch
   HTTP at all — `npx axiom-mcp` uses stdio — so Express's 32 packages are dead
   weight for the majority.

2. **Dead session machinery.** The server emits **zero** server-initiated
   messages: no progress, no logging, no `listChanged` notifications
   (verified by grep across `src/`). The session `Map`, the `GET /mcp` SSE
   stream, and `DELETE /mcp` therefore carry no traffic. Roughly 60 of the 90
   lines serve nothing.

3. **No test coverage.** None of the 616 tests touch `src/http.ts`, yet
   `docker/Dockerfile` runs `dist/http.js` as the production entrypoint. Any
   change to this file today is unverified.

### Goals (agreed with user)

- Replace Express with Hono, using the MCP SDK's
  `WebStandardStreamableHTTPServerTransport`.
- Convert the transport to fully stateless.
- Give the transport real test coverage, currently at zero.
- Structure the code so a Cloudflare Workers entrypoint becomes possible later
  without another rewrite — and enforce that boundary with a test.
- Clean up the Docker/README drift this work exposes.

### Non-goals

- **OAuth 2.1 Resource Server layer** — deferred to a follow-up spec. The MCP
  authorization spec makes the MCP server a *resource server* and puts the
  authorization server explicitly out of scope, which means every self-hosting
  user would have to stand up an AS (Auth0, Keycloak, …). That is a project of
  its own and it lands cleanly on top of this one. The SDK already ships the
  pieces (`server/auth/middleware/bearerAuth`, `providers/proxyProvider`,
  `handlers/authorize|token|revoke`, `router`), so the follow-up needs no new
  dependency either.
- **A Workers entrypoint and a Workers-compatible Giac build.** Giac's loader
  uses `new Function()` and runtime `WebAssembly.instantiate(buffer)`, both
  blocked on Workers, and its linear memory is 64 MB against a 128 MB isolate
  limit. Separate, much larger project. This spec only avoids foreclosing it.
- **Rate limiting.** No demonstrated need.
- **`benchmark/`.** Verified not to use Express. Untouched.

## Approach

Four options were considered:

- **A. Hono + the SDK's `WebStandardStreamableHTTPServerTransport`** — chosen.
- **B. Hono + the community `@hono/mcp` `StreamableHTTPTransport`.** Initially
  chosen, then rejected on evidence — see below.
- **C. Hono + `@hono/node-server`, driving the SDK's Node-flavoured
  `StreamableHTTPServerTransport` through raw `req`/`res`.** Official SDK code,
  but re-binds the transport to Node HTTP objects and so kills the portability
  goal. Also leaves Hono used as a router while bypassing its `Response` model.
- **D. Stay on Express, delete the dead session code.** Lowest risk, no new
  dependencies, but keeps 32 packages and forecloses Workers.

### Why B was rejected

B was the original choice. A spike run before writing any implementation code
falsified it. Under `@hono/mcp`, a stateless `POST /mcp` that closes the
transport once `handleRequest` resolves returns:

```
initialize -> status 200, content-type: text/event-stream, body: ""
```

The transport answers with SSE, and closing it truncates the stream to an empty
body. The "responses are fully materialised JSON" assumption this spec
originally recorded as a risk was simply wrong.

### Why A

The MCP SDK exports `WebStandardStreamableHTTPServerTransport`
(`@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js`), built on
`Request`/`Response`/`ReadableStream`. Its own documentation gives the two
usages this project needs verbatim:

```ts
// Hono.js usage
app.all('/mcp', async (c) => transport.handleRequest(c.req.raw));

// Cloudflare Workers usage
export default { async fetch(request) { return transport.handleRequest(request); } };
```

Spiked with `sessionIdGenerator: undefined` and `enableJsonResponse: true`,
against per-request throwaway servers. All four properties this design depends
on were confirmed:

- `content-type: application/json` with **complete** bodies — early close is
  safe, deterministically, not by assumption
- no `Mcp-Session-Id` header
- `tools/list` and `tools/call` succeed on an instance that never saw
  `initialize`, which is what makes a throwaway server per request viable
- already present at the project's existing `^1.25.3` floor — verified against
  1.25.3, 1.26.0 and 1.27.0

A dominates B on every axis that mattered: it is first-party rather than a
pre-1.0 community package, it adds **zero** transitive dependencies where B
added `hono-rate-limiter` and `pkce-challenge`, and it makes the resource
cleanup correct instead of broken.

The argument originally made for B — that `@hono/mcp/auth` would carry the
Spec 2 OAuth work — does not survive either: the SDK ships its own auth module
(`server/auth/middleware/bearerAuth`, `providers/proxyProvider`,
`handlers/authorize|token|revoke`, `router`), so Spec 2 also stays first-party.

**Residual risk:** none specific to this choice. `hono` and
`@hono/node-server` are used only as a router and a Node adapter; the MCP
protocol surface is entirely SDK code.

## Architecture

`src/http.ts` currently mixes two responsibilities: application definition
(routes, protocol) and Node bootstrap (port binding, signals, Giac init).
Portability breaks precisely at that missing seam. Split it, following the
existing `src/server/transports/stdio.ts` convention:

### `src/server/transports/http-app.ts` — portable core

```ts
export interface HttpAppOptions {
  healthProbe: () => boolean;
}

export function createHttpApp(options: HttpAppOptions): Hono;
```

Contains **no Node APIs**: no `node:crypto`, no `process.env`, no port, no
signal handling. Web-standard `Request`/`Response` only. This is the file a
future Workers entrypoint would consume unchanged via
`export default { fetch: app.fetch }`, and it is the target of the tests.

The `healthProbe` injection is load-bearing, not ceremony. Calling
`giacEngine.isReady()` directly would pull
`src/server/giac/index.ts → wrapper.ts → worker-host.ts → node:child_process`
into the app module and silently destroy the portability boundary. Injection
keeps the app layer ignorant of Giac.

### `src/http.ts` — Node entrypoint (~30 lines)

Reads configuration (`MCP_PORT`, `MCP_HOST`), eagerly initialises Giac
(measured at 59 ms, which keeps `/health` meaningful and the first request
fast), serves the app via `@hono/node-server`'s `serve()`, and handles
`SIGTERM`/`SIGINT`.

Emits a one-line stderr warning when bound to `0.0.0.0` with no authentication
configured. `docker-compose.yml` sets exactly that, and auth does not arrive
until Spec 2; the user should know what they are running.

## Routes and data flow

| Route | Behaviour |
| --- | --- |
| `POST /mcp` | Per request: `createServer()` + `WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })`, `handleRequest(c.req.raw)`, then close |
| `GET /mcp` | **405** — required by the MCP spec for servers that offer no SSE stream |
| `DELETE /mcp` | **405** — session termination is meaningless without sessions |
| `GET /health` | `{ status, giac, transport: 'stateless' }`; HTTP 503 when the probe reports Giac not ready |

**The invariant that makes stateless viable:** the expensive thing is a
process-level singleton, the cheap thing is per-request. The Giac worker (a
forked child process holding 64 MB of WASM linear memory) stays a module-level
singleton shared across requests. Only the `McpServer` is per-request.

Measured per-request cost of `createServer()` + transport + `connect()` +
`close()`: **0.25 ms**, against 4–19 ms for a typical Giac evaluation. Memory
retained after GC across 2000 request cycles: **0.79 MB total, 416 bytes per
request** — noise, not a leak.

### Resource cleanup

`enableJsonResponse: true` makes every response a complete JSON body rather
than an SSE stream, so closing the transport in a `finally` once
`handleRequest` resolves is safe by construction — there is no stream left to
drain.

This is not an assumption. The first draft of this design did assume it, was
spiked, and turned out to be wrong under `@hono/mcp`, which answered with
`text/event-stream` and returned an empty body when the transport was closed.
`enableJsonResponse` is precisely the option that removes the ambiguity, and
the spike confirms complete bodies under the chosen transport.

A test still asserts `content-type: application/json` on POST responses — not
to guard a guess, but to pin the contract the cleanup depends on, so a future
change to transport options cannot silently reintroduce truncation.

## Error handling

Centralised, preserving the JSON-RPC envelope:

- `app.onError` → `-32603 Internal error`. **No stack traces in the response
  body**; the full error goes to stderr. Leaking internals from an
  open-source server is needless disclosure.
- Malformed JSON body → `-32700 Parse error` (Hono's `c.req.json()` throws;
  catch and map).
- `app.notFound` → 404 with a JSON-RPC-shaped body.
- Giac's 10 s timeout already surfaces as an MCP tool-level error from the
  `compute` handler, not a transport error. This layer does not touch it.
- The `onError` contract is written to accommodate the 401/403 surface Spec 2
  will add.

## Testing

`app.fetch(new Request(...))` runs the whole stack in-process — no port
binding, no server lifecycle, no flakiness, and **no new devDependency**
(no `supertest`). Unit tests already run against real Giac; there is no mock to
wire up. (`vitest.config.integration.ts` carries a stale comment about a Giac
mock — no `setupFiles` exists in either config.)

New file: `test/http-transport.test.ts`, matching the existing `test/*.test.ts`
convention so it runs in the default vitest config.

### Sequencing — this is the safety net

Write the tests covering *shared* behaviour against the **current Express
implementation** first and confirm they pass: `initialize`, `tools/list`,
`tools/call`, `/health`. Then migrate and confirm they still pass. This turns
the migration from "swap and hope" into a verified change.

Stateless-specific tests (405s, absence of session headers) fail on Express by
design; they are written after the migration. Two groups: *behaviour to
preserve* and *intentional change*.

### Cases

**Protocol conformance**
- `initialize` returns the correct `serverInfo` (name and version)
- `tools/list` contains `compute`, `verify`, `plot`
- `tools/call compute` with `integrate(sin(x)^3,x)` returns
  `-cos(x)+cos(x)^3/3` — proves the full chain end to end
- `prompts/list` returns the registered prompts

**Stateless invariants**
- No `Mcp-Session-Id` header on any response
- Two independent POSTs each succeed with no handshake between them
- POST response `content-type` is `application/json` (the cleanup guard above)

**Method rejection**
- `GET /mcp` → 405
- `DELETE /mcp` → 405

**Error envelopes**
- Malformed JSON → `-32700`
- Unknown JSON-RPC method → `-32601`
- Internal error → `-32603`, and the response body does not match `/at .*\(/`
  (no stack trace)

**Health**
- Probe `true` → 200 with `giac: true`
- Probe `false` → 503. One line to test, because `healthProbe` is injectable —
  the concrete payoff of that design decision.

**Portability guard**

A test that walks the transitive import closure from
`dist/server/transports/http-app.js`, following relative imports, and asserts
no file in that closure imports `node:*` (~25 lines).

This must be transitive, not a surface regex. The violation caught during
design was an indirect chain — `index.ts → wrapper.ts → worker-host.ts →
node:child_process` — which a direct-import check would have missed. Without
this test the Workers boundary is a comment, and someone re-wires Giac into
`/health` six months from now with nothing to stop them.

## Docker and README

In scope because `dist/http.js` is exactly what the production image runs.

- **`docker/Dockerfile`**: drop
  `COPY --from=builder /app/src/server/giac ./src/server/giac`. Since
  `173e119` the build copies the asset into `dist/`, so this line adds a
  redundant 9.7 MB layer.
- **`docker/docker-compose.yml`**: `GIAC_TIMEOUT` → `AXIOM_EVAL_TIMEOUT_MS`;
  delete `GIAC_MEMORY`, `LOG_LEVEL`, and the `data` volume. Verified: none of
  them is read anywhere in `src/`. Phantom configuration is a silent trap for
  anyone who believes it works.
- Add a `healthcheck` against `/health`. Meaningful now that it returns 503
  when Giac is not ready — a free benefit of the health-probe design.
- **README**: document stateless behaviour, the 405s, and `/health` semantics.
  Add the two undocumented environment variables (`AXIOM_EVAL_TIMEOUT_MS`,
  `AXIOM_COMPUTE_HYGIENE`) to the table. Add the `0.0.0.0`-without-auth caveat,
  pointing at Spec 2.

### One small in-scope addition

`package.json` says `0.1.0` while `src/server/index.ts:11` reports `0.2.0` in
`serverInfo`. Folded into this spec because the test strategy forces the
question — the `initialize` test must assert a version and must not pin the
wrong one. Reduce to a single source of truth.

## Expected outcome

- Production dependency tree: **135 → 103 packages** (−32, −24%) — identical to
  a build with no HTTP framework at all
- HTTP transport coverage: **0% → full transport layer**
- The Workers path stays open, enforced by a test rather than a convention
- Docker image loses a redundant 9.7 MB layer and its phantom configuration

## Adjacent finding — not part of this spec

`mathjs@15.1.1` (the pinned version) carries a **high-severity advisory**:
[GHSA-29qv-4j9f-fjw5](https://github.com/advisories/GHSA-29qv-4j9f-fjw5) and
[GHSA-jvff-x2qm-6286](https://github.com/advisories/GHSA-jvff-x2qm-6286),
unsafe object property setter / improperly controlled modification of
dynamically-determined object attributes. It is present in the baseline tree
and is unrelated to the framework choice — neither Express nor Hono affects it.

It matters here for two reasons: this project feeds user-supplied expressions
straight into mathjs, which is precisely the exposed surface; and once the
repository is public, `npm audit` and Dependabot make it visible. Worth its own
task before or shortly after the public release.
