# Axiom Advanced Math MCP — Agent Instructions

## Run first

```bash
npm run typecheck    # required before shipping changes
npm test             # 137 tests — must pass
```

## Build & run

| Command | Purpose |
|---|---|
| `npm run build` | TypeScript → `dist/` (strict, ES2022, NodeNext) |
| `npm start` | STDIO mode (Claude Desktop / Claude Code) |
| `npm run dev` | Hot-reload with tsx |
| `npm run inspect` | MCP Inspector for tool introspection |

## Tests

```bash
npm test                 # unit tests (excludes integration.test.ts)
npm run test:integration # real Giac engine — needs WASM binary
npm run test:coverage    # v8 coverage report
```

**Integration test quirk:** `vitest.config.integration.ts` has no `setupFiles`. Do NOT add one — it would load the Giac mock and prevent testing the real engine.

## Lint & format

```bash
npm run lint         # oxlint
npm run lint:fix     # auto-fix
npm run format       # prettier (semi, singleQuote, 100 char)
```

## Architecture notes

- **Entry points:** `src/cli.ts` (STDIO), `src/http.ts` (HTTP via Express on `/mcp`)
- **WASM engine:** Giac lives at `src/server/giac/`. HTTP server calls `giacEngine.initialize()` before starting.
- **Response format:** All 15 tools return `{ content: [{type:"text", text:"..."}], isError:false }` — the LLM grader parses the last text block.

## Benchmark recipe

Default recipe (grader-v2 default; no flag needed):

```bash
cd benchmark
npm run cas:quick:zai
npm run gsm8k:quick:zai
npm run math:quick:zai
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
