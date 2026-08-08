# CLI Surface — Tools as Shell Commands

**Date:** 2026-08-08
**Branch:** `feat/cli-surface` (from `main` @ `e07ee4e`)
**Status:** DESIGN — approved, pending implementation plan

## Background

The package ships one `bin`, `axiom-mcp`, pointing at `dist/cli.js`. Despite the
name, that is not a CLI: it starts an MCP stdio server and speaks JSON-RPC.
Running it in a terminal produces a process that sits there waiting for protocol
messages, with no indication of why.

The motivation for changing that is **agent skills**. An MCP server needs
client-side configuration; a skill is markdown that shells out to a command. A
CLI therefore reaches a strictly wider set of consumers than MCP does — any
agent that can run a command, with no setup — and that is the same set of
consumers this project wants.

Feasibility was prototyped before designing, not assumed. A 20-line script
calling the existing handlers produced correct output and exited cleanly:

| Stage | Measured |
| --- | --- |
| Module import (mathjs + SDK dominate) | 195 ms |
| Giac init (fork + WASM) | 82 ms |
| Actual evaluation | 13–25 ms |
| **One-shot total** | **~300 ms** |

The seam already exists: the tool handlers are pure functions returning
`{ content, isError }`. `renderSvg` returns plain SVG text (the base64 wrapping
happens at the MCP layer), and `computeHandler` already sets `isError` on
failure, so file output and exit codes need no new plumbing.

### Goals (agreed with user)

- `compute`, `verify` and `plot` invocable as shell subcommands.
- Ship in the **same** npm package, without breaking the existing MCP
  invocation.
- A ready-to-use skill definition in the repo, so an agent can adopt it in one
  step.
- Structured output (`--json`) available on all three subcommands.

### Non-goals

- **A `--timeout` flag.** `AXIOM_EVAL_TIMEOUT_MS` already exists and is
  documented; a second way to say the same thing is surface for nothing.
- **An argument-parsing dependency.** Three subcommands and a dozen flags is
  ~60 lines by hand. This session took the production tree from 135 packages to
  103; adding `commander` to a GPL package to save that is a bad trade.
- **A REPL or batch mode.** One-shot invocation only. (Noted because it changes
  one assumption below — see "Session isolation".)
- **Changing `plot`'s MCP schema.** See "Schema changes".

## Constraint that determines the architecture

Two bins would break the MCP config line. Measured, not assumed:

```
Two bins, neither matching the package name  -> npm error: could not determine executable to run
Two bins, one matching the package name      -> npx runs that one
One bin, any name                            -> npx runs it
```

The package is `axiom-advanced-math-mcp` and the bin is `axiom-mcp`, which do
not match. That works today only because there is exactly one bin. Adding a
second (`axiom` alongside `axiom-mcp`) makes
`npx -y axiom-advanced-math-mcp` — the line in every MCP client config —
fail outright.

So: **one bin, dispatch on arguments.** No arguments → MCP stdio server
(today's behaviour, byte for byte). A subcommand → CLI.

## Approach

Three options were considered:

- **A. The CLI calls the tool handlers directly** — chosen.
- **B. The CLI drives `createServer()` through an in-memory MCP client.** Its
  one real argument is that the CLI and MCP surfaces then cannot diverge,
  because the CLI walks exactly a client's path. But it adds the SDK client and
  JSON-RPC serialization for no user-visible benefit, on a path where the actual
  computation is 25 ms of a 300 ms invocation.
- **C. The CLI spawns the server as a subprocess and speaks stdio JSON-RPC.**
  Worst of both: process cost plus protocol plumbing.

**A**, with B's justification designed out rather than dismissed. The divergence
risk is real but lives in exactly one place: MCP registration wraps the handlers
in `withIsolatedCasSession` (CAS reset + mutex). A CLI calling handlers directly
would have different isolation semantics from the MCP surface. The fix is to
produce the wrapped tool definitions in one place and have both `createServer()`
and the CLI consume them — which removes the only thing B was buying.

## Architecture

The `bin` target stays `dist/cli.js`. The published contract does not change;
what changes is what that file does.

```
src/cli.ts            dispatcher: no args -> MCP stdio server; subcommand -> CLI
src/cli/parse.ts      hand-rolled argument parsing (~60 lines, no dependency)
src/cli/commands.ts   compute / verify / plot
src/cli/render.ts     output selection (text | json | quiet) and exit-code mapping
src/server/tools.ts   the wrapped tool definitions, consumed by createServer() AND the CLI
```

`src/server/transports/stdio.ts` is unchanged; the server path is untouched.
`src/cli.ts` is currently a six-line wrapper around `startStdioServer()`, so
turning it into the dispatcher also retires a misleading filename — after this
change `cli.ts` genuinely is the CLI.

### Two behaviours worth stating

**TTY hint.** With no arguments the server starts exactly as today. But when
`process.stdin.isTTY` is true — a human typed the command — one line goes to
**stderr** explaining that this is an MCP stdio server and pointing at
`--help`. stdout stays protocol-only, so no client is affected. Today that case
is an unexplained hang.

**stdin.** When a subcommand gets no positional argument, the expression is read
from stdin. Shell quoting of mathematical expressions is genuinely painful
(`$`, `*`, `!`, parentheses) and piping is the natural escape. If stdin is a TTY
and no argument was given, print usage and exit 1 — never wait silently.

### Session isolation

The CLI routes through the same `withIsolatedCasSession` wrapper as the MCP
surface. For a one-shot process this is belt-and-braces (a fresh process has a
pristine CAS), but it costs nothing and it is what keeps the two surfaces
honest. It also means a future batch or REPL mode inherits correct isolation
instead of discovering the problem again.

## Command surface

```
axiom-mcp compute <expr>  [--domain real|complex|numeric|exact]
                          [--precision 1..50]
                          [--json | --latex | -q]

axiom-mcp verify  <claim> [--method numeric|symbolic|both]
                          [--json | -q]

axiom-mcp plot    <expr>  [-o file.svg]
                          [--variable x] [--x-min n] [--x-max n]
                          [--y-min n] [--y-max n]
                          [--width n] [--height n] [--title s]
                          [--json | -q]
```

Global: `-h/--help` (also per subcommand), `-V/--version`. Every flag maps onto
a field that already exists in the corresponding tool schema — no new concepts.

**The output modes are mutually exclusive.** `--json`, `--latex` and `-q` each
select what stdout carries, so combining any two is a usage error (exit 1), not
a silent precedence rule. Omitting all three gives the default text.

### `-q` never parses text

The most important detail in the design. `-q` prints one scalar, always sourced
from structured data, never by scraping the human-readable output:

| Command | `-q` prints | Source |
| --- | --- | --- |
| `compute` | `{-2, 2}` | the envelope's `display` field |
| `verify` | `true` / `false` | `VerifyResult.verified` |
| `plot` | the path written | the command's own result |

`plot -q` therefore **requires `-o`**: without it the SVG itself is the output
and there is no path to print, so `-q` alone is a usage error rather than a
command that prints nothing.

Text scraping would be fragile, and silent wrong answers are this product's
worst failure mode. `-q` is the contract a skill builds on, so its source has to
be typed.

### `plot` output target

- `-o file.svg` given → write the file.
- Omitted **and** stdout is not a TTY → write the SVG to stdout (pipeable).
- Omitted and stdout is a TTY → error. Dumping 5 KB of SVG into a terminal
  helps no one.

### Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Success — and for `verify`, the claim was verified |
| `1` | Tool or usage error (invalid expression, missing argument, Giac failure) |
| `2` | `verify` only: it ran, and the claim was **not** verified |

`2` is separated so `axiom-mcp verify '...' && echo ok` behaves as expected and
so "not verified" is distinguishable from "could not run" — a distinction an
agent needs. This follows the `grep`/`test` convention.

## Schema changes

The agreed "symmetric `--json`" narrows on contact with the MCP layer, and the
two halves are not the same thing:

**`verify` gains a `format` field** — `z.enum(['text','json']).optional()`. This
benefits MCP clients too: reading `verified: true` beats parsing
`Verified: TRUE ✓`. `VerifyResult { verified, confidence, explanation,
checks_performed }` is already computed internally and then formatted away, so
exposing it is nearly free. It deliberately does **not** mirror `compute`'s
three-way `text|latex|json`: a verification verdict has no LaTeX form, and
inventing one would be noise.

**`plot` does NOT gain a `format` field.** As an MCP tool, `plot` returns the
rendered image in a content block, and that image is what a client wants.
Adding `format: 'json'` would replace it with metadata — making the MCP tool
worse. In the CLI there is no inline image; there is a file on disk, and
`--json` describes it:

```json
{ "ok": true, "path": "out.svg", "expression": "sin(x)", "variable": "x",
  "x_range": [-10, 10], "y_range": [-1, 1], "segments": 1, "points": 200 }
```

So `--json` works on all three subcommands as agreed, while the MCP schema
changes only where the change is an improvement.

## Error handling

**One rule: stdout carries only the requested output.** Usage errors, warnings,
hints and tool errors all go to stderr. This is what makes
`RESULT=$(axiom-mcp compute -q '...')` safe — a single stray line on stdout
corrupts it.

Conveniently, the MCP stdio server is already bound by the same discipline
(stdout is protocol-only), so both modes share one rule rather than two.

- Usage/parse error → usage text to stderr, exit 1.
- Tool error (`isError: true`) → message to stderr, exit 1.
- `verify` not verified → normal output to stdout, exit 2.

## Skill definition

`skills/axiom-math/SKILL.md`: frontmatter (`name`, `description` — when to
reach for it: mathematics that must be exact, symbolic integration, equation
solving, verifying a result) and worked examples of the three subcommands.

Two practical notes belong in it:

- `--json` for agents, the default text for humans, `-q` to capture one value
  into a shell variable.
- The **first invocation downloads ~3.8 MB** (the Giac WASM); later ones come
  from the npx cache. A skill's first call being slower than expected has this
  as its cause.

The skill file doubles as living documentation: if its examples break, someone
using it notices — which is more than can be said for examples buried in a
README.

## Testing

The CLI is a thin layer over handlers already covered by 675 tests. The tests
target the CLI's **own** logic and do not re-verify the mathematics. The split
follows the existing one exactly.

**Unit — `test/cli-parse.test.ts`** (no build required, runs in the default
config). Argument parsing and output selection are pure functions: unknown flag,
missing value, `--precision` out of range, `--json`/`--latex`/`-q` conflict,
per-subcommand flag validity.

**Integration — `test/cli-contract.test.ts`** (needs `dist/`, reuses
`http-contract.test.ts`'s spawn machinery).

| Case | Why it matters |
| --- | --- |
| **No args → the MCP server starts and completes a handshake** | The guarantee that every existing MCP client config still works. The most important test in the set. |
| `compute -q '...'` → exactly the value, nothing else | The contract a skill builds on; one stray character breaks it. |
| `verify` with a false claim → exit **2** | Pins the distinguishing convention. |
| `verify --json` → parseable, has `verified` | Proves an agent never has to scrape text. |
| `compute` with an invalid expression → exit 1, stdout empty | The error path does not pollute stdout. |
| `echo '...' \| compute` | The stdin path. |
| `plot -o f.svg` → file begins with `<svg` | File output. |
| `--version` → matches `VERSION` | Version stays single-sourced. |
| The process exits, leaving no forked Giac worker | Verified in the prototype; a one-shot CLI that hangs is exactly the bug that silently times out a skill. |

Expected cost: ~300 ms per subcommand invocation, roughly 3 s added to the
integration suite.

## Expected outcome

- Three tools usable as shell commands, and as an agent skill with no MCP setup.
- `npx -y axiom-advanced-math-mcp` still starts the MCP server, unchanged.
- One new npm dependency: none.
- `verify` gains structured output for MCP clients as a side benefit.

## Sequencing note

This should land **before the first npm publish**. `bin` names and CLI arguments
are public API: adding CLI mode later is fine, but changing how an already
published bin behaves is not.
