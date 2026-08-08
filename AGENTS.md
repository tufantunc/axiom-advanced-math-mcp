# Axiom Advanced Math MCP — Agent Instructions

Published on npm as **`axiom-math`**. One package, one bin, three surfaces:
MCP over stdio, MCP over HTTP, and a one-shot CLI.

## Run first

```bash
npm run typecheck
npm run lint
npm run format:check
npm test                  # unit — no build needed
npm run test:integration  # builds first, exercises dist/
```

These five are exactly what CI runs. Passing locally means passing there.

## Build & run

| Command | Purpose |
|---|---|
| `npm run build` | TypeScript → `dist/`, then copies the WASM asset |
| `npm start` | STDIO MCP server |
| `npm run start:http` | HTTP MCP server |
| `npm run dev` | Hot-reload with tsx |
| `npm run inspect` | MCP Inspector for tool introspection |

## Tests

Unit tests must not require a build. Anything that inspects `dist/` belongs in
`vitest.config.integration.ts`, which runs `npm run build` first.

**Integration test quirk:** `vitest.config.integration.ts` has no `setupFiles`.
Do NOT add one — it would load the Giac mock and prevent testing the real engine.

**Assert the actual mathematics.** `expect(result).toBeDefined()` passes on a
wrong answer, which is worse than no test. See CONTRIBUTING.md.

## Architecture notes

- **Entry points:** `src/cli.ts` dispatches on argv — no arguments starts the
  MCP stdio server (what every client config does), a subcommand runs one
  computation and exits. `src/http.ts` is the HTTP entry point.
- **Three tools:** `compute`, `verify` (registered in `src/server/index.ts`) and
  `plot` (registered in `src/server/tools/plot/index.ts`). `compute` is a
  gateway — it parses a CAS-style string and routes to a domain handler, so
  callers learn one tool rather than dozens.
- **Portability boundary:** `src/server/transports/http-app.ts` must import no
  `node:*` module, directly or transitively. `test/http-portability.test.ts`
  enforces it.
- **WASM engine:** Giac lives at `src/server/giac/`, in a forked child process
  recycled on timeout or crash. It keeps global state between calls, so every
  tool call runs inside a reset-and-locked session (`src/server/tools.ts`).

## The four things that cause defects here

Each of these has already produced a real bug:

1. **Two surfaces, one contract.** The same three tools are reachable over MCP
   (`src/server/index.ts`) and from the CLI (`src/cli/commands.ts`). A guard
   added to one belongs on the other — the 8 KB input cap was declared in the
   zod schemas and enforced only by the MCP SDK's dispatch, so the CLI shipped
   with no bound.
2. **stdout is a contract.** Server mode: the JSON-RPC stream. CLI mode: the
   value a script captures with `$(...)`. Hints and errors go to stderr in both.
   Never `process.exit()` after writing to stdout — pipe writes are async and
   get truncated.
3. **A silent wrong answer is the worst failure.** Prefer erroring over
   returning something that might be wrong. Giac swallows syntax errors and
   answers `undef` inside well-formed output (`lname(x +)` → `[undef]`), so
   filter its undefined marker at every parse site.
4. **Statelessness is load-bearing.** The HTTP transport issues no session id
   and keeps nothing between requests. Rate limiting and auth belong at the
   perimeter (`docker/reverse-proxy/`), not in the app.

## Releasing

```bash
npm version patch && git push --follow-tags
```

`npm version` triggers `scripts/sync-version.mjs`, which rewrites
`src/version.ts` into the same commit — the two must agree or
`test/version.test.ts` fails. The tag push triggers `.github/workflows/release.yml`,
which refuses a tag that disagrees with `package.json`, then publishes with npm
trusted publishing (OIDC, no stored token) and provenance.

## Review stacks

`.review-pro/axiom-cas/` holds project-specific reviewer packs (correctness,
backend, tests, security, performance) encoding the traps above. Keep them
current when a new class of defect is found.

## Benchmark recipe

Default recipe (grader-v2 default; no flag needed):

```bash
cd benchmark
npm run cas:quick:zai
npm run gsm8k:quick:zai
npm run math:quick:zai
```

Benchmarks are run manually and are deliberately not in CI.

**Local models (LM Studio, Ollama, vLLM):**

Set `LOCAL_BASE_URL` in `.env` or inline, then run with `--local --model <name>`:

```bash
LOCAL_BASE_URL=http://localhost:1234/v1 tsx index.ts --quick --local --model llama-3.2
LOCAL_BASE_URL=http://localhost:11434/v1 tsx index.ts --quick --local --model llama3
```

Optional opt-in flags (see README "Optional ablation features"):
- `--features=output-hygiene`
- `--features=grader-v3`
- `--features=self-consistency`

**Removed flags** (silent no-op for backwards-compat):
- `--features=v2` — grader-v2 is now the default; passing this is harmless
- `--features=tokens-8k` — Phase 2 regression; removed from code
- `--features=olympiad-prompt` — Phase 4 fail; removed from code

Per-phase results live in `docs/superpowers/specs/2026-05-*-results.md`.
