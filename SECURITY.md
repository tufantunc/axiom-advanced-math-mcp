# Security Policy

## Reporting a vulnerability

Please report security issues privately, through GitHub's
[private vulnerability reporting](https://github.com/tufantunc/axiom-advanced-math-mcp/security/advisories/new)
on this repository — not as a public issue.

Include what you need to reproduce it: the expression or request, the transport
(stdio or HTTP), and the version. A proof of concept helps more than a
description.

This is a personal project with no SLA. Expect a first response within about a
week.

## Supported versions

Pre-1.0. Only the latest release receives fixes; there are no maintained
backport branches.

## What this software does, and why that matters

Axiom evaluates **caller-supplied mathematical expressions**. That is not an
incidental feature — it is the entire product. Every hardening decision below
follows from it.

Two independent evaluators sit behind the tools:

| Evaluator | Used by | Runs in | Bounded by |
| --- | --- | --- | --- |
| Giac/Xcas (WASM) | `compute`, `verify` | a forked child process | `AXIOM_EVAL_TIMEOUT_MS`, default 10 s |
| mathjs | `compute` (arithmetic), `plot` | the main event loop | input length only — **no timeout** |

The mathjs path has no timeout. A sufficiently expensive expression there
blocks every concurrent request, not just its own. Input length is the only
bound, which is why it exists.

## Threat model

**In scope:** anything reachable by a caller who can send MCP requests —
expression-parser escapes, CAS state leaking between callers, resource
exhaustion through the evaluators, information disclosure in errors.

**Out of scope:** a caller who can already run code on the host, or read the
process's memory. The stdio transport gives its client the same trust level as
the process itself by design.

## Current posture

### No authentication

`POST /mcp` is unauthenticated. This is a known gap, not an oversight — an
OAuth 2.1 resource-server layer is planned as separate work. Until then:

- The default bind is `127.0.0.1`. **`docker/docker-compose.yml` sets
  `MCP_HOST=0.0.0.0`**, which exposes the port on every interface.
- If you expose it beyond localhost, put an authenticating reverse proxy in
  front. The server logs a warning at startup when bound to `0.0.0.0`.

### Perimeter controls that do exist

| Control | Behaviour |
| --- | --- |
| Host allowlist | `localhost`, `127.0.0.1`, `[::1]` by default; `MCP_ALLOWED_HOSTS` replaces (not extends) that list. Case-insensitive. A missing `Host` is rejected. |
| Origin allowlist | An `Origin` not on the list is rejected; an **absent** `Origin` is allowed, so non-browser clients keep working. |
| Request body cap | 1 MB, enforced before the body is parsed. |
| Expression length | 8 KB per expression (`compute.problem`, `verify.claim`, `plot.expression`). |
| Method rejection | Anything other than `POST /mcp` returns 405 with `Allow: POST`. |

The Host and Origin checks defend against DNS rebinding — a browser page
resolving an attacker domain to `127.0.0.1` to reach a local server. They are
**not** authentication: any non-browser client can send whatever `Host` it
likes.

### CAS session isolation

Giac keeps global session state. A `sto(7,x)` or `assume(x>0)` from one call
would otherwise still be in effect for the next — including a call from a
*different client*, since the HTTP transport is stateless and multi-client. The
observable failure was a silently wrong answer returned with a 200.

Three mechanisms close it, and they work together:

1. The engine is reset at every tool-call boundary.
2. A mutex holds the CAS session for the whole tool call, so concurrent calls
   cannot interleave their evaluations against the shared worker.
3. The evaluation cache is dropped with the session it was computed under, so a
   memoized result cannot outlive the state it depended on.

### mathjs lockdown

Both mathjs instances have `import` and `createUnit` disabled, per mathjs's own
guidance for untrusted input. `evaluate`, `parse`, `simplify` and `derivative`
remain enabled because this project's own code calls them.

Keeping mathjs current matters independently: two advisories fixed in 15.2.0
were arbitrary JavaScript execution *through the expression parser*, which is
exactly this server's exposed surface.

### Error handling

Internal errors return a bare JSON-RPC `-32603`. Stack traces and filesystem
paths go to stderr only, never into a response.

## Known limitations

Named plainly, because they are the things most likely to bite you:

- **No rate limiting and no concurrency cap.** Nothing stops a caller from
  submitting expensive expressions back to back.
- **One CAS worker, serialized.** Tool calls queue behind each other. A call
  that runs to the 10 s timeout delays everything queued behind it.
- **The mathjs path has no timeout.** Bounded by input length alone.
- **`AXIOM_EVAL_TIMEOUT_MS` is a footgun when raised.** It sets how long one
  caller can hold the shared worker.
- **Giac is GPL-3.0 and compiled from upstream sources.** See
  [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).

## Deployment guidance

- Keep the default `127.0.0.1` bind unless something else terminates and
  authenticates the connection.
- Set `MCP_ALLOWED_HOSTS` explicitly when reaching the server by hostname or
  LAN address; the loopback default will reject those.
- Leave `AXIOM_EVAL_TIMEOUT_MS` at its default unless you have measured a need.
- Run `npm audit` after updating dependencies. The tree is clean as of the
  latest release.
