# Contributing

Thanks for wanting to help. This is a small project, so the process is small too.

## Get it running

Node.js >= 20 is the only requirement. The CAS engine is committed as a
pre-built WebAssembly file, so there is nothing to compile beyond TypeScript.

```bash
git clone https://github.com/tufantunc/axiom-advanced-math-mcp.git
cd axiom-advanced-math-mcp
npm install
npm run build
npm test
```

If `npm test` is green, you have a working checkout. Try the CLI:

```bash
node dist/cli.js compute 'integrate(sin(x)^3,x)'
```

## Make your change

Work on a branch, and run these before you push — they are exactly what CI runs,
so passing locally means passing there:

```bash
npm run typecheck
npm run lint
npm run format:check   # `npm run format` fixes it
npm test               # unit — no build needed
npm run test:integration   # builds first, then exercises dist/
```

CI also runs the tests on Node 20, 22 and 24, and installs the packed tarball
into a scratch project to check the published artifact still works.

### Tests

Every change to behaviour needs a test. For a project whose whole job is being
correct, one rule matters more than the rest:

**Assert the actual mathematics, not that something came back.** `expect(result).toBeDefined()`
passes on a wrong answer, which is worse than no test at all.

```ts
// good — pins the answer
expect(text).toContain('-cos(x)+cos(x)^3/3');

// bad — passes even when the CAS returns nonsense
expect(text).toBeDefined();
```

Tests live in `test/`, one file per area, named `<area>.test.ts`. Copy the shape
of a neighbouring file; they call the handlers directly and assert on the result.

## Commit and open a PR

Commit messages use conventional prefixes — `feat:`, `fix:`, `docs:`, `test:`,
`refactor:`, `chore:`, `ci:`, `build:`. Say what changed and, when it isn't
obvious, why.

Open the PR against `main` and describe what you changed and how you checked it.
Small PRs get reviewed faster than large ones. If you are planning something big,
open an issue first so we can agree on the shape before you spend the effort.

## A few things about this codebase

Four things that are not obvious from reading the code:

- **Two surfaces, one contract.** The same three tools are reachable over MCP
  (`src/server/index.ts`) and from the CLI (`src/cli/commands.ts`). A guard,
  limit, or behaviour added to one belongs on the other. Input length caps have
  already been missed this way once.
- **stdout is a contract.** In server mode it is the JSON-RPC stream; in CLI mode
  it is the value a script captures with `$(...)`. Hints, warnings and errors go
  to stderr in both. Never `process.exit()` on a path that has written to
  stdout — writes to a pipe are asynchronous and get truncated.
- **A silent wrong answer is the worst possible bug here.** Prefer erroring out
  over returning something that might be wrong. This is why `verify`
  distinguishes "checked and false" from "could not check".
- **The CAS has global state.** Giac remembers `sto` and `assume` between calls,
  so every tool call runs inside a reset-and-locked session. If you add a code
  path that talks to Giac, route it through the existing engine rather than
  around it.

`src/server/giac/giac.wasm.js` is a 9.7 MB build artifact checked into the repo.
You should never need to touch it; rebuilding it requires Docker and is
documented in the README.

## Bugs and security

For a bug, open an issue with the input you gave and the output you got —
for this project a one-line reproduction is usually enough:

```
axiom-math compute 'the expression'   → got X, expected Y
```

**Do not open a public issue for a security vulnerability.** Use GitHub's
[private reporting](https://github.com/tufantunc/axiom-advanced-math-mcp/security/advisories/new).
[SECURITY.md](SECURITY.md) explains what is in scope.

## License

This project is GPL-3.0-or-later, because it embeds Giac/Xcas. Contributions are
accepted under the same license — by opening a PR you agree your changes ship
under it. There is no CLA.
