# Axiom Advanced Math MCP Server

[![MIT License](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![Node.js >=20](https://img.shields.io/badge/Node.js->=20-green.svg)](https://nodejs.org/)
[![MCP](https://img.shields.io/badge/MCP-1.25.3-blue)](https://modelcontextprotocol.io/)
[![Tests](https://img.shields.io/badge/Tests-137%20passed-green.svg)](https://github.com/anomalyco/axiom-advanced-math-mcp)

Advanced mathematical computation engine for LLMs powered by the Model Context Protocol.

## Why Axiom?

LLMs often make calculation errors, especially with symbolic math, exact fractions, and multi-step problems. Axiom provides **verified, exact results** through two layers:

- **math.js** — Fast numerical evaluation (arithmetic, trigonometry, matrices)
- **Giac/Xcas WASM** — Symbolic computation (calculus, algebra, equation solving)

### Benchmark Results (GLM-5.1, May 2026)

| Dataset           | Baseline | +MCP    | Delta     |
| ----------------- | -------- | ------- | --------- |
| GSM8K (100)       | 96.0%    | 98.0%   | +2.0%     |
| MATH L3 (50)      | 70.0%    | 80.0%   | +10.0%    |
| MATH L4 (50)      | 50.0%    | 62.0%   | +12.0%    |
| MATH L5 (50)      | 38.0%    | 52.0%   | +14.0%    |
| CAS-quick (60)    | 55.0%    | 70.0%   | +15.0%    |
| Omni-MATH ≥7 (50) | 0.0%     | 0–4%    | (ceiling) |

**Key insights:**

- Phase 0 grader (LaTeX/Unicode normalization + symbolic equivalence) is the dominant value driver across all datasets
- CAS-quick lifted from 26.7% (April pre-grader) to 70% (post-grader) — the biggest single jump
- Omni-MATH ≥7 is at ceiling for current LLM+CAS setups; needs fundamentally different approaches (Lean/Coq, fine-tuning, RAG)

Full results: [`benchmark/results/`](benchmark/results/) and [`docs/superpowers/specs/`](docs/superpowers/specs/) (per-phase analysis)

---

## Features

### 15 Tools with 76 Operations

| Tool                 | Operations       | Use Case                                                                  |
| -------------------- | ---------------- | ------------------------------------------------------------------------- |
| `quick_calc`         | 1                | Fast numeric evaluation (arithmetic, trig, matrices, units)               |
| `calculus`           | 5                | Derivatives, integrals, limits, Taylor series, ODEs                       |
| `algebra`            | 4                | Factor, simplify, expand, partial fractions                               |
| `solve_equation`     | 1                | Single equation solving (real/complex domain)                             |
| `solve_system`       | 1                | System of equations (linear/nonlinear)                                    |
| `matrix`             | 16               | Determinant, inverse, eigenvalues, RREF, decompositions                   |
| `number_theory`      | 3                | Prime factorization, number analysis, sequence identification             |
| `combinatorics`      | 9                | C(n,k), P(n,k), Stirling, Bell, Catalan, derangements                     |
| `probability_calc`   | 10 distributions | Binomial, normal, Poisson, geometric, chi-square, t, F, beta, exponential |
| `hypothesis_testing` | 5 tests          | One/two/paired t-tests, chi-square independence, ANOVA                    |
| `numerical_methods`  | 5                | Newton-Raphson, bisection, secant, Romberg, Simpson                       |
| `advanced_solve`     | Raw CAS          | Giac/Xcas escape hatch (Laplace, vector calculus, etc.)                   |
| `geometry`           | 11               | Distance, area, angle, line intersection, point-line distance             |
| `exact_value`        | 3                | Decimal ↔ exact fraction/sqrt/pi conversion                               |
| `plot_function`      | 1                | SVG function plotting                                                     |

---

## Installation

```bash
# Clone and install
git clone https://github.com/anomalyco/axiom-advanced-math-mcp.git
cd axiom-advanced-math-mcp
npm install

# Build
npm run build
```

**Node.js >= 20 required.**

### Docker

```bash
# Build and run
docker-compose up -d

# Check logs
docker-compose logs -f

# Stop
docker-compose down
```

---

## Usage

### CLI (STDIO Transport)

```bash
# Run with stdio transport (default)
npm start

# Development mode
npm run dev
```

**Claude Desktop integration:**

```json
// ~/Library/Application Support/Claude/claude_desktop_config.json
{
  "mcpServers": [
    {
      "name": "axiom-math",
      "command": "npx",
      "args": ["-y", "/path/to/axiom-advanced-math-mcp/dist/cli.js"]
    }
  ]
}
```

### HTTP Transport

```bash
# Start HTTP server (default: http://127.0.0.1:3000)
npm run start:http

# Development HTTP
npm run dev:http
```

**Environment variables:**

| Variable   | Default     | Description      |
| ---------- | ----------- | ---------------- |
| `MCP_PORT` | `3000`      | HTTP server port |
| `MCP_HOST` | `127.0.0.1` | HTTP server host |

### MCP Inspector

```bash
npm run inspect
```

---

## Run Benchmarks

Default production recipe (grader-v2 included automatically):

```bash
cd benchmark
npm install

# Set provider API key (one of):
export ZAI_API_KEY=...
export ANTHROPIC_API_KEY=...
export OPENROUTER_API_KEY=...

# Run benchmarks (provider defaults from --zai/--anthropic/--openrouter flags)
npm run cas:quick:zai      # CAS-quick (60 problems, ~30 min)
npm run gsm8k:quick:zai    # GSM8K-quick (100 problems, ~30 min)
npm run math:quick:zai     # MATH L3-L5 quick (150 problems, ~75 min)
```

### Optional ablation features (off by default)

- `--features=output-hygiene` — tool output post-processing (Unicode normalize, optional simplify, silent-failure warning). Marginal +1pp on CAS in live measurement.
- `--features=grader-v3` — equation-RHS extraction + bare-comma-list set match. Marginal +1pp on CAS.
- `--features=self-consistency` — N=3 majority voting (variance reduction; 3× cost; no accuracy gain on CAS).

Example:

```bash
npm run cas:quick:zai -- --features=output-hygiene,grader-v3
```

See `docs/superpowers/specs/2026-05-*-results.md` for live ablation analysis of every flag.

### What we tried that didn't work

This project went through extensive ablation across five phases (Phase 0–4). The following experimental approaches were tested live and rejected:

- **Phase 1: Structured JSON output with `\boxed{}` trailers** — model paraphrased boxed content into LaTeX style, breaking answer extraction. Net regression on CAS.
- **Phase 2: 8K token budget (`tokens-8k`)** — gave the model more room to wander rather than recovering from truncation. Net regression −6.7pp on CAS.
- **Phase 3: Self-consistency for accuracy** — N=3 voting did not lift accuracy (Wang et al. literature gain not reproducible on CAS); kept as a methodology tool for variance reduction only.
- **Phase 4: Olympiad-specific scaffolding prompt** — engagement improved (no-tool-call rate 84% → 74%) but accuracy stayed at 0%. Olympiad-tier problems are out of scope for prompt-engineering interventions.

Each phase's per-problem analysis is in `docs/superpowers/specs/2026-05-*-results.md`. The honest documentation of failures is preserved as a project archive.

---

## Tool Reference

### quick_calc

Fast numerical calculations with exact-value detection.

```json
{
  "expression": "2 * sin(30deg) + 5",
  "units": "auto",
  "precision": 10,
  "format": "text"
}
```

**Features:**

- Arithmetic, trigonometry, logarithms, complex numbers
- Unit conversions (km/h, inches, pounds, etc.)
- Natural language detection (rejects non-math input)
- Automatic exact form: `400/11` → `36.36...`

---

### calculus

Symbolic calculus operations.

```json
{
  "operation": "differentiate",
  "expression": "x^2 + sin(x)",
  "variable": "x",
  "order": 2
}
```

**Operations:**

| Operation       | Example                                                                            | Description                     |
| --------------- | ---------------------------------------------------------------------------------- | ------------------------------- |
| `differentiate` | `{"operation":"differentiate","expression":"x^3","order":2}`                       | Derivative (any order, partial) |
| `integrate`     | `{"operation":"integrate","expression":"x^2","lower_bound":"0","upper_bound":"1"}` | Definite/indefinite integral    |
| `limit`         | `{"operation":"limit","expression":"sin(x)/x","point":"0","direction":"+"}`        | Two-sided/one-sided limit       |
| `taylor`        | `{"operation":"taylor","expression":"exp(x)","point":"0","order":5}`               | Taylor/Maclaurin series         |
| `solve_ode`     | `{"operation":"solve_ode","equation":"y'=2*x","initial_conditions":"y(0)=1"}`      | ODE solver                      |

---

### algebra

Algebraic manipulation.

```json
{
  "operation": "factor",
  "expression": "x^2 - 4",
  "complex": false
}
```

**Operations:**

| Operation           | Example                                                                     | Description                     |
| ------------------- | --------------------------------------------------------------------------- | ------------------------------- |
| `factor`            | `{"operation":"factor","expression":"x^4-1"}`                               | Factor into irreducible factors |
| `simplify`          | `{"operation":"simplify","expression":"sin(x)^2+cos(x)^2"}`                 | Simplify to simplest form       |
| `expand`            | `{"operation":"expand","expression":"(x+1)^3"}`                             | Expand products and powers      |
| `partial_fractions` | `{"operation":"partial_fractions","expression":"1/(x^2-1)","variable":"x"}` | Partial fraction decomposition  |

---

### solve_equation

Single equation solving.

```json
{
  "equation": "x^2 - 4 = 0",
  "variable": "x",
  "domain": "real"
}
```

**Features:**

- Real or complex domain (`solve` vs `csolve`)
- Symbolic, exact solutions
- Supports trigonometric, exponential, logarithmic equations

---

### solve_system

System of equations.

```json
{
  "equations": ["x + y = 5", "x - y = 1"],
  "variables": ["x", "y"]
}
```

**Features:**

- Linear and nonlinear systems
- Returns all solutions

---

### matrix

Linear algebra operations (16 total).

```json
{
  "operation": "determinant",
  "matrix": "[[1,2],[3,4]]"
}
```

**Operations:**

| Operation                              | Description              |
| -------------------------------------- | ------------------------ |
| `determinant`                          | Matrix determinant       |
| `inverse`                              | Matrix inverse           |
| `eigenvalues`                          | Eigenvalues              |
| `eigenvectors`                         | Eigenvectors             |
| `rref`                                 | Reduced row echelon form |
| `rank`                                 | Matrix rank              |
| `transpose`                            | Matrix transpose         |
| `nullspace`                            | Nullspace (kernel)       |
| `qr`, `lu`, `cholesky`, `svd`          | Matrix decompositions    |
| `norm_frobenius`, `norm_1`, `norm_inf` | Matrix norms             |
| `condition_number`                     | Condition number         |

---

### number_theory

Integer analysis and sequence identification.

```json
{
  "operation": "analyze",
  "number": 2024
}
```

**Operations:**

| Operation           | Example                                                      | Description                                       |
| ------------------- | ------------------------------------------------------------ | ------------------------------------------------- |
| `prime_factorize`   | `{"operation":"prime_factorize","number":2024}`              | Prime factorization                               |
| `analyze`           | `{"operation":"analyze","number":28}`                        | Primality, divisors, totient, perfect square/cube |
| `sequence_identify` | `{"operation":"sequence_identify","sequence":[1,1,2,3,5,8]}` | Identify pattern (Fibonacci, arithmetic, etc.)    |

---

### combinatorics

Exact combinatorial calculations.

```json
{
  "operation": "combinations",
  "n": 10,
  "k": 3
}
```

**Operations:**

| Operation                           | Example                                               | Description            |
| ----------------------------------- | ----------------------------------------------------- | ---------------------- |
| `combinations`                      | `{"operation":"combinations","n":10,"k":3}`           | C(n,k) = n!/(k!(n-k)!) |
| `permutations`                      | `{"operation":"permutations","n":10,"k":3}`           | P(n,k) = n!/(n-k)!     |
| `multinomial`                       | `{"operation":"multinomial","n":10,"groups":[3,3,4]}` | n!/(k1!_k2!_...)       |
| `stirling_first`, `stirling_second` | Stirling numbers                                      |
| `bell_number`, `catalan_number`     | Special sequences                                     |
| `derangements`, `partition_count`   | Advanced combinatorics                                |

---

### probability_calc

Probability distributions.

```json
{
  "distribution": "binomial",
  "operation": "cdf",
  "params": { "n": 10, "k": 3, "p": 0.5 }
}
```

**Distributions:**

| Distribution                                | Parameters                          | Operations                         |
| ------------------------------------------- | ----------------------------------- | ---------------------------------- |
| `binomial`                                  | `{n, k, p}`                         | pmf, cdf, expected_value, variance |
| `normal`                                    | `{x, mu, sigma}`                    | pmf, cdf, quantile                 |
| `poisson`                                   | `{k, lambda}`                       | pmf, cdf, quantile                 |
| `geometric`                                 | `{k, p}`                            | pmf, cdf, quantile                 |
| `hypergeometric`                            | `{N, K, n, k}`                      | pmf, cdf                           |
| `chi_square`, `student_t`, `f_distribution` | `{df, x}` or `{df, p}`              | cdf, quantile                      |
| `beta`, `exponential`                       | `{alpha, beta, x}` or `{lambda, x}` | cdf, quantile                      |

---

### hypothesis_testing

Statistical hypothesis tests.

```json
{
  "test": "one_sample_t",
  "data": { "sample1": [1, 2, 3, 4, 5], "mu0": 3 },
  "significance": 0.05
}
```

**Tests:**

| Test                      | Required Data        | Description                            |
| ------------------------- | -------------------- | -------------------------------------- |
| `one_sample_t`            | `sample1`, `mu0`     | Test if mean = hypothesized value      |
| `two_sample_t`            | `sample1`, `sample2` | Welch's t-test (unequal variance)      |
| `paired_t`                | `sample1`, `sample2` | Before/after paired measurements       |
| `chi_square_independence` | `contingency_table`  | Test independence in contingency table |
| `one_way_anova`           | `groups`             | Compare means of 3+ groups             |

---

### numerical_methods

Numerical fallback methods.

```json
{
  "method": "newton_raphson",
  "expression": "x^2 - 2",
  "initial_guess": 1.0,
  "tolerance": 1e-10
}
```

**Methods:**

| Method                  | Type         | Description                                       |
| ----------------------- | ------------ | ------------------------------------------------- |
| `newton_raphson`        | Root finding | Fast, needs derivative and initial guess          |
| `bisection`             | Root finding | Guaranteed convergence, needs sign-change bracket |
| `secant`                | Root finding | No derivative needed, needs two starting points   |
| `romberg_integration`   | Integration  | Adaptive, highly accurate                         |
| `numerical_integration` | Integration  | Simpson's rule with configurable subintervals     |

---

### advanced_solve

Raw Giac/Xcas CAS access.

```json
{
  "expression": "laplace(t^2*exp(3*t), t, s)",
  "format": "latex",
  "steps": false
}
```

**Use cases:**

- Laplace transforms
- Vector calculus (div, grad, curl)
- Polynomial operations
- Summation/products
- Any operation not covered by specialized tools

---

### geometry

2D geometry calculations.

```json
{
  "operation": "distance",
  "points": [
    [0, 0],
    [3, 4]
  ]
}
```

**Operations:**

| Operation             | Parameters                                             | Description                         |
| --------------------- | ------------------------------------------------------ | ----------------------------------- |
| `distance`            | `points: [[x1,y1],[x2,y2]]`                            | Distance between two points         |
| `midpoint`            | `points: [[x1,y1],[x2,y2]]`                            | Midpoint of segment                 |
| `slope`               | `points: [[x1,y1],[x2,y2]]`                            | Slope of line                       |
| `area_triangle`       | `points: [[x1,y1],[x2,y2],[x3,y3]]` or `base`+`height` | Area from vertices or base/height   |
| `area_polygon`        | `points: [[x1,y1],...]` (ordered)                      | Area via shoelace formula           |
| `area_circle`         | `radius` or `diameter`                                 | Area from radius/diameter           |
| `perimeter_polygon`   | `points: [[x1,y1],...]`                                | Perimeter from vertices             |
| `circumference`       | `radius` or `diameter`                                 | Circumference from radius/diameter  |
| `line_intersection`   | `line1: [a,b,c]`, `line2: [a,b,c]`                     | Intersection of two lines ax+by+c=0 |
| `point_line_distance` | `points[0]`, `line1`                                   | Distance from point to line         |
| `angle_between_lines` | `line1`, `line2`                                       | Angle (degrees) between two lines   |

---

### exact_value

Exact/decimal conversion.

```json
{
  "operation": "to_exact",
  "value": "0.3333333333"
}
```

**Operations:**

| Operation           | Example                                             | Description                             |
| ------------------- | --------------------------------------------------- | --------------------------------------- |
| `to_exact`          | `{"operation":"to_exact","value":"0.3333333333"}`   | Convert decimal to fraction/sqrt/pi     |
| `to_decimal`        | `{"operation":"to_decimal","value":"sqrt(2)/2"}`    | Evaluate symbolic expression to decimal |
| `simplify_fraction` | `{"operation":"simplify_fraction","value":"12/18"}` | Reduce fraction to lowest terms         |

---

### plot_function

SVG function plotting.

```json
{
  "expression": "sin(x)",
  "x_min": -10,
  "x_max": 10,
  "width": 600,
  "height": 400
}
```

**Features:**

- Returns base64-encoded SVG image
- Auto-detects y-axis range
- Handles discontinuities (asymptote detection)
- Axes, grid, and labels included

---

## Architecture

### Two-Layer Computation Engine

```
┌─────────────────────────────────────────────────────────────┐
│                    MCP Protocol Layer                        │
│  (stdio / HTTP / SSE)                                       │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                    Tool Handlers (15 tools)                  │
│  - quick_calc, calculus, algebra, solve_*, matrix, etc.     │
└─────────────────────────────────────────────────────────────┘
                              │
        ┌─────────────────────┼─────────────────────┐
        ▼                     ▼                     ▼
┌──────────────────┐  ┌──────────────────┐  ┌──────────────────┐
│   math.js        │  │   Giac/Xcas      │  │   Exact Engine   │
│   (numerical)    │  │   (symbolic)     │  │   (fractions)    │
└──────────────────┘  └──────────────────┘  └──────────────────┘
```

### Response Format

All tools return standardized responses:

```json
{
  "content": [
    { "type": "text", "text": "Result: 400/11" },
    { "type": "text", "text": "Decimal: 36.3636363636" },
    { "type": "text", "text": "LaTeX: \\frac{400}{11}" },
    { "type": "text", "text": "" },
    { "type": "text", "text": "The answer is 400/11 (≈ 36.36)" }
  ],
  "isError": false
}
```

This format helps LLMs extract answers reliably via the grader.

---

## Benchmark Results

### Datasets

| Dataset      | Problems | Difficulty                     |
| ------------ | -------- | ------------------------------ |
| GSM8K        | 100      | Grade school math (arithmetic) |
| MATH L3      | 50       | High school math               |
| MATH L4      | 50       | Advanced high school math      |
| MATH L5      | 50       | Olympiad-level math            |
| Omni-MATH ≥7 | 50       | Expert-level math              |

### How to Run

```bash
# Quick benchmark (small samples)
npm run benchmark:quick

# Full benchmark (all datasets)
npm run benchmark:full

# Specific dataset
npm run benchmark:gsm8k
npm run benchmark:math-l3
npm run benchmark:math-l4
npm run benchmark:math-l5

# With specific provider
npm run benchmark:zai      # GLM-5.1 (default)
npm run benchmark:openrouter
```

**Environment variables:**

| Variable             | Required for        | Description             |
| -------------------- | ------------------- | ----------------------- |
| `ZAI_API_KEY`        | zai provider        | Your z.ai API key       |
| `OPENROUTER_API_KEY` | openrouter provider | Your OpenRouter API key |

---

## Development

### Scripts

| Command                 | Description                    |
| ----------------------- | ------------------------------ |
| `npm run build`         | Compile TypeScript to `dist/`  |
| `npm start`             | Run STDIO server               |
| `npm run dev`           | Run in development mode (tsx)  |
| `npm run start:http`    | Run HTTP server                |
| `npm run dev:http`      | Run HTTP server in dev mode    |
| `npm test`              | Run all tests (137 tests)      |
| `npm run test:coverage` | Run tests with coverage report |
| `npm run lint`          | Lint with oxlint               |
| `npm run lint:fix`      | Auto-fix linting issues        |
| `npm run format`        | Format with Prettier           |

### Testing

```bash
# Run all tests
npm test

# Watch mode
npm run test:watch

# Coverage report
npm run test:coverage
```

**Test coverage:** 137 tests, 100% pass rate.

### WASM Build (Giac)

```bash
# Linux/Mac
cd docker
docker-compose -f docker-compose.wasm.win build

# Windows
cd docker
docker-compose -f docker-compose.windows.yml build
```

Build creates `giac.wasm` and `giac.wasm.js` in `docker/wasm-output/`. Copy to `src/server/giac/`.

---

## License

MIT License — see [LICENSE](LICENSE) for details.
