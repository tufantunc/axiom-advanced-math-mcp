---
name: axiom-math
description: Use when a task needs mathematics that must be exact rather than estimated — symbolic integration or differentiation, solving equations, factoring, limits, series, matrix algebra, combinatorics, or checking whether a mathematical claim is actually true. Runs a computer algebra system (Giac/Xcas) locally via a CLI, so results are computed rather than recalled.
---

# Axiom — exact mathematics from the shell

LLMs are unreliable at symbolic algebra and multi-step arithmetic. This runs a
real CAS instead. Every command exits non-zero on failure, so you can trust the
exit code.

## Compute

```bash
npx -y axiom-advanced-math-mcp compute 'integrate(sin(x)^3,x)'
```

Full output includes the result, its LaTeX, the CAS command used, and a
verification line. For one value to put in a variable:

```bash
ANSWER=$(npx -y axiom-advanced-math-mcp compute -q 'solve(x^2-4=0,x)')   # {-2, 2}
```

For structured output:

```bash
npx -y axiom-advanced-math-mcp compute --json 'solve(x^2-4=0,x)'
```

```json
{ "success": true, "result_type": "set", "display": "{-2, 2}",
  "latex": "\\{-2,2\\}", "data": { "solutions": ["-2", "2"], "count": 2 },
  "method": "solve_equation", "giac_command": "solve(x^2-4=0,x)",
  "verification": { "status": "verified", "check": "(substitution: 2/2 roots satisfy the equation)" } }
```

Options: `--domain real|complex|numeric|exact`, `--precision 1..50`,
`--latex` for LaTeX-focused text.

## Verify

Checks a claim independently. **Exit code carries the verdict:** `0` verified,
`2` not verified, `1` could not run.

```bash
npx -y axiom-advanced-math-mcp verify 'sin(x)^2+cos(x)^2 = 1' && echo "holds"
npx -y axiom-advanced-math-mcp verify -q 'diff(x^3,x) = 3*x^2'   # true
npx -y axiom-advanced-math-mcp verify --json 'x=2 satisfies x^2-4=0'
```

## Plot

```bash
npx -y axiom-advanced-math-mcp plot 'sin(x)' -o wave.svg
```

Options: `--variable`, `--x-min`, `--x-max`, `--y-min`, `--y-max`, `--width`,
`--height`, `--title`. Without `-o` the SVG goes to stdout, so it can be piped.

## Notes

- Expressions can be piped instead of quoted, which avoids shell-escaping pain:
  `echo 'diff(x^3,x)' | npx -y axiom-advanced-math-mcp compute -q`
- **The first invocation downloads about 3.8 MB** (the CAS engine, compiled to
  WebAssembly) and takes a few seconds. Later calls come from the npx cache and
  take roughly 300 ms.
- `AXIOM_EVAL_TIMEOUT_MS` bounds a single evaluation; the default is 10000.
- Syntax is Giac/Xcas: `int(...)`, `diff(...)`, `limit(...)`, `taylor(...)`,
  `factor(...)`, `expand(...)`, `det([[1,2],[3,4]])`, `C(10,3)`, `ifactor(2310)`.
