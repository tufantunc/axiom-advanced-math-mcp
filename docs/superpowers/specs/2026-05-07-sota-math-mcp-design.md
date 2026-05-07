# Axiom SOTA Math MCP — Design Document

**Date:** 2026-05-07
**Status:** Approved
**Author:** Tufan Tunc + Axiom Design Session

## Problem Statement

Axiom Advanced Math MCP provides 15 math tools (76 operations) via Giac CAS WASM engine to LLMs through the MCP protocol. Benchmark results across 6 runs (glm-4.7, glm-5.1, 360 problems) reveal three systemic weaknesses preventing SOTA product quality:

1. **Tool under-utilization:** LLM calls tools in only 30-70% of opportunities. Regressions' 30-50% come from "no tool call" situations.
2. **Output format mismatch:** Tool produces correct results but the answer parser/grader cannot match symbolic expressions. This causes 63% of regressions.
3. **Olympiad-level problems:** 0% accuracy on Omni-MATH (difficulty >= 7). Model neither solves these nor calls tools.
4. **CAS symbolic operations:** Derivatives, indefinite integrals, ODE, series all score 0% in both baseline and tool-augmented conditions due to output format issues.

**Current best results (April 8, glm-5.1):**
| Dataset | Baseline | +MCP | Delta |
|---------|----------|------|-------|
| GSM8K (100) | 96.0% | 98.0% | +2.0% |
| MATH L3 (50) | 70.0% | 80.0% | +10.0% |
| MATH L4 (50) | 50.0% | 62.0% | +12.0% |
| MATH L5 (50) | 38.0% | 52.0% | +14.0% |
| Omni-MATH >=7 | 0.0% | 0.0% | +0.0% |
| CAS (60) | 28.3% | 26.7% | -1.7% |

## Design Goals

- **Model-agnostic:** Every improvement must benefit any LLM (Claude, GPT-4, Gemini, GLM, etc.)
- **Olympiad inclusion:** Omni-MATH and competition-level problems are in scope
- **Grader + tool output included:** Fix the measurement gap alongside the tools
- **Production quality:** Reliable, well-tested, documented
- **Full pipeline:** Tools + prompt strategies + verification pipeline

## Architecture: Layered Intelligence

Three layers transform Axiom from a "passive calculator" into an "active math assistant":

```
┌─────────────────────────────────────────┐
│         Strategy Layer (analyze)         │
│  Problem classification → Strategy →     │
│  Tool plan → Warnings                    │
├─────────────────────────────────────────┤
│       Computation Layer (compute)        │
│  Preprocess → Route → Dispatch →        │
│  Postprocess → Format                    │
├─────────────────────────────────────────┤
│      Verification Layer (verify)         │
│  Symbolic check → Numeric check →       │
│  Cross-validation → Reflexion            │
└─────────────────────────────────────────┘
```

All layers output structured JSON responses with standardized format.

---

## Section 1: Strategy Layer — `analyze` Tool

### New MCP Tool: `analyze`

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `problem` | string | Yes | Math problem text (natural language or symbolic) |
| `context` | string | No | Additional context (diagram description, prior work) |

**Behavior:**

1. **Problem classification:** Detect domain (algebra, geometry, number_theory, combinatorics, calculus, statistics, proof, olympiad) and subtopics
2. **Difficulty estimation:** Classify as arithmetic / algebraic / symbolic / conceptual
3. **Solution strategy:** Generate step-by-step plan
4. **Tool usage plan:** Specify which tool calls to make, in what order, with what parameters
5. **Trap warnings:** Flag common pitfalls for the detected problem type

**Output (Structured):**

```json
{
  "classification": {
    "domain": "combinatorics",
    "difficulty": "algebraic",
    "subtopics": ["binomial_coefficient", "probability"],
    "is_olympiad": false
  },
  "strategy": {
    "approach": "Direct computation with verification",
    "steps": [
      "1. Compute total outcomes using combinatorics",
      "2. Compute favorable outcomes",
      "3. Divide to get probability",
      "4. Verify result is in [0,1]"
    ],
    "olympiad_strategies": null
  },
  "tool_plan": [
    {"tool": "compute", "input": "C(10,3)", "purpose": "Total combinations"},
    {"tool": "compute", "input": "C(8,3)", "purpose": "Favorable outcomes"},
    {"tool": "verify", "input": "result between 0 and 1", "purpose": "Sanity check"}
  ],
  "warnings": ["Ensure order does not matter in this problem"],
  "estimated_steps": 3
}
```

**Implementation:**

- Rule-based classifier using keyword patterns and structural analysis
- Strategy templates per domain (8 templates, one per domain)
- Tool plan generation via predefined patterns per strategy template
- Giac-based validation for tool plan correctness
- Olympiad detection via difficulty heuristics (multi-step, proof keywords, competition keywords)

### Olympiad Strategy Extensions

When `is_olympiad: true`, `analyze` includes additional strategies:

| Strategy | Description | When to use |
|----------|-------------|-------------|
| Problem Decomposition | Break complex problem into sub-problems | Multi-component problems |
| Special Case Analysis | Start with simple cases, find pattern, generalize | Number theory, combinatorics |
| Constraint Exploration | Examine constraints one at a time | Geometry, algebra |
| Identity Library | Apply known mathematical identities | Trigonometry, algebra |
| Exhaustive Search | Enumerate small state spaces | Number theory (divisor counting) |
| Working Backwards | Start from answer, work to conditions | Inverse problems |

### New Prompt Template: `structured-solve`

```
You are solving a math problem. Follow this EXACT workflow:

1. Call analyze({problem: "..."}) to get strategy
2. Follow the tool_plan from analyze EXACTLY
3. For each step, call compute with the suggested input
4. After getting results, call verify to check your answer
5. If verify fails, follow the suggestion and retry
6. Report final answer in the format: \boxed{answer}

CRITICAL RULES:
- ALWAYS use compute for calculations, never calculate mentally
- If unsure about approach, call analyze FIRST
- Always verify your answer before finalizing
```

### New Prompt Template: `olympiad-solve`

```
You are solving an olympiad-level math problem. These require careful reasoning.

Workflow:
1. Call analyze({problem: "..."}) — pay attention to olympiad_strategies
2. Try the FIRST suggested strategy
3. If stuck, try alternative strategies from analyze
4. Use verify at each intermediate step, not just the final answer
5. If all strategies fail, try working backwards from possible answers
6. Report: \boxed{answer}
```

### New Prompt Template: `step-verify`

```
For each step of your solution:
1. State what you're computing
2. Call compute to get the result
3. Call verify to check the intermediate result makes sense
4. If verify fails, STOP and reconsider
5. Only proceed when verified
```

---

## Section 2: Computation Layer Improvements

### 2.1 Smart Tool Descriptions

Expand each MCP tool's `description` field with usage guidance:

**compute tool:**
```
Universal math computation engine powered by Giac CAS.

WHEN TO USE: Always use this tool for ANY calculation, even simple arithmetic.
- Solving equations (linear, quadratic, polynomial, systems)
- Computing derivatives, integrals, limits, Taylor series
- Matrix operations, combinatorics, probability
- Any expression evaluation with exact or numeric results

WHEN NOT TO USE: For verifying claims (use verify), plotting (use plot),
or analyzing strategy (use analyze).

CRITICAL: Always call this tool for computations rather than calculating mentally.
The tool provides exact results with Giac CAS — more reliable than mental math.
```

**verify tool:**
```
Mathematical claim verification engine. Checks identities, solutions, and constraints.

WHEN TO USE:
- After computing an answer, verify it satisfies the original problem
- Check if a claimed identity holds (symbolic + numeric)
- Validate intermediate results in multi-step problems
- Check if a solution satisfies constraints

WHEN NOT TO USE: For computing new results (use compute).

Returns confidence level and specific check results.
```

**analyze tool:**
```
Mathematical problem analysis and strategy engine.

WHEN TO USE:
- Before solving any non-trivial math problem
- When unsure about the solution approach
- For complex problems requiring multiple steps
- For olympiad or competition-level problems

WHEN NOT TO USE: For direct computation (use compute) or verification (use verify).

Provides problem classification, solution strategy, and a tool usage plan.
```

### 2.2 Router Preprocessing Pipeline

Add a preprocessing layer before routing in `compute`:

**Pipeline:** `input → preprocess → route → dispatch → postprocess → format`

**Preprocessing rules:**

| Pattern | Transform | Reason |
|---------|-----------|--------|
| `\|x\|` | `abs(x)` | Giac does not support pipe notation |
| `fibonacci(n)` | `((1+sqrt(5))/2)^n/sqrt(5) - ((1-sqrt(5))/2)^n/sqrt(5)` | Giac lacks fibonacci() |
| `π` | `pi` | Unicode normalization |
| `²`, `³` | `^2`, `^3` | Unicode superscript normalization |
| `×` | `*` | Unicode multiplication |
| `÷` | `/` | Unicode division |
| `...` | Range detection | Ellipsis in sequences |
| `mod(a,b)` | `irem(a,b)` | Giac modulus function |

**Implementation location:** New file `src/server/tools/compute/preprocess.ts` called from `computeHandler` before router.

### 2.3 CAS Engine Gap Fixes

**Known Giac gaps to work around:**

| Gap | Workaround |
|-----|-----------|
| `abs(x)` in solve fails sometimes | Try `sqrt(x^2)` substitution |
| `seq()` returns empty | Use `makelist()` instead |
| `fibonacci()` not recognized | Binet's formula |
| Complex inequality systems | Split into individual inequalities |
| `domain: "numeric"` routes to Newton-Raphson incorrectly | Fix router priority rules |

---

## Section 3: Verification Layer + Structured Output Format

### 3.1 Structured Output Format

All tools (`compute`, `verify`, `plot`, `analyze`) return structured JSON:

```typescript
interface ToolResponse {
  answer: string           // Short, clear answer: "4" or "x = 2, x = -2"
  answer_latex?: string    // LaTeX format: "x = 2, x = -2"
  answer_numeric?: number  // Numeric value (if applicable): 4
  steps: string[]          // Intermediate steps
  confidence: 'high' | 'medium' | 'low'
  alternatives?: string[]  // Alternative expressions (e.g., ["sqrt(2)/2", "1/sqrt(2)"])
  warnings?: string[]      // Cautions
}
```

**MCP response format stays the same:**
```json
{
  "content": [{"type": "text", "text": "{...JSON...}"}],
  "isError": false
}
```

**Key rules:**
- `answer` always appears first in the JSON string — LLM reads left-to-right
- `answer` is always the simplest form: integer > fraction > decimal > expression
- `alternatives` includes all equivalent forms the grader might expect
- `confidence` is determined by verification success

### 3.2 Enhanced `verify` Tool

**New parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `claim` | string | Yes | Claim to verify |
| `method` | enum | No | Verification method: numeric/symbolic/both (default both) |
| `expected_range` | [number, number] | No | Expected value range for sanity check |
| `context` | string | No | Original problem text for contextual checks |

**New verification strategies:**

1. **Boundary value check:** Verify result falls within expected range
   - Probability: [0, 1]
   - Count: non-negative integer
   - Area: positive
   - Solutions: satisfy original equation

2. **Cross-validation:** Compare symbolic + numeric results
   - Symbolic: `int(x^2, x, 0, 2)` → `8/3`
   - Numeric: Simpson's rule → `2.6667`
   - Check: `|8/3 - 2.6667| < epsilon`

3. **Consistency detection:** Find contradictions in intermediate steps
   - Model claims "x=2" but substituting into equation doesn't satisfy

**Reflexion loop on failure:**

```json
{
  "verified": false,
  "reason": "Symbolic result 8/3 does not match claim 3",
  "suggestion": "Recompute the integral. Try: compute({problem: 'int(x^2, x, 0, 2)'})",
  "confidence": "low"
}
```

---

## Section 4: Benchmark & Grader Improvements

### 4.1 Answer Normalizer

Module at `benchmark/graders/normalizer.ts`:

```typescript
interface NormalizedResult {
  canonical: string     // Standard form: "sqrt(2)/2"
  latex: string         // LaTeX: "\frac{\sqrt{2}}{2}"
  decimal: number       // Numeric: 0.70710678118...
  is_exact: boolean     // Is exact integer/fraction?
}
```

**Normalization rules:**

1. `\frac{a}{b}` → `a/b`
2. `\sqrt{n}` → `sqrt(n)`
3. `\left(`, `\right)` → `()`
4. `^{2}` → `^2`
5. Unicode symbols: `²` → `^2`, `π` → `pi`
6. Trigonometric: `sin^2(x)` → `(sin(x))^2`
7. Remove LaTeX formatting: `\dfrac`, `\text`, `\mathrm`
8. Normalize whitespace

### 4.2 Enhanced Grader

Extended comparison pipeline in `benchmark/graders/grader.ts`:

```typescript
function grade(expected: string, actual: string): boolean {
  // 1. Exact string match (existing)
  // 2. Numeric tolerance (existing)
  // 3. Set matching for multi-answer (existing)
  // 4. NEW: LaTeX normalization + string match
  // 5. NEW: Symbolic equivalence via Giac
  //    simplify(expected - actual) === 0
  // 6. NEW: Numeric evaluation at multiple test points
  //    evaluate(expected, x=1.7) ≈ evaluate(actual, x=1.7)
}
```

**Symbolic equivalence check (most impactful addition):**
- Both expressions sent to Giac: `simplify(expr1 - expr2)`
- If result is `0`, expressions are equivalent
- Handles: `3*x^2` vs `3x^2`, `sqrt(2)/2` vs `1/sqrt(2)`

**Multi-point numeric evaluation:**
- For expressions with variables, evaluate at 3-5 random test points
- If all match within tolerance, expressions are equivalent
- Handles cases where Giac simplify fails

### 4.3 Regression Analysis Tool

New benchmark command: `npm run benchmark:analyze`

**Behavior:**
- Reads latest benchmark results (JSON + JSONL)
- Compares baseline vs tool-augmented per problem
- Classifies each regression into categories:

| Category | Description | Detection |
|----------|-------------|-----------|
| `NO_TOOL_CALL` | Model did not call any tools | Check tool call count = 0 |
| `WRONG_TOOL_CALL` | Model called wrong tool or with wrong params | Analyze tool calls vs expected |
| `OUTPUT_PARSE_ERROR` | Answer correct in tool output but model extracted wrong | Compare tool output to model's final answer |
| `GRADER_MISMATCH` | Answer correct but grader couldn't match | Manual review or normalizer check |
| `WRONG_ANSWER` | Genuinely incorrect result | None of the above |

**Output:** Markdown report with per-category counts, examples, and improvement suggestions.

---

## Section 5: File Changes Summary

### New Files

| File | Purpose |
|------|---------|
| `src/server/tools/analyze/index.ts` | `analyze` tool handler |
| `src/server/tools/analyze/schema.ts` | Zod schema for analyze |
| `src/server/tools/analyze/classifier.ts` | Problem classification rules |
| `src/server/tools/analyze/strategy-templates.ts` | Strategy templates per domain |
| `src/server/tools/analyze/tool-planner.ts` | Tool usage plan generator |
| `src/server/tools/compute/preprocess.ts` | Input preprocessing pipeline |
| `src/server/tools/response-formatter-v2.ts` | Structured JSON response formatter |
| `benchmark/graders/normalizer.ts` | Answer normalization module |
| `benchmark/analyze.ts` | Regression analysis command |
| `test/analyze.test.ts` | Tests for analyze tool |
| `test/normalizer.test.ts` | Tests for answer normalizer |
| `test/preprocess.test.ts` | Tests for preprocessing pipeline |
| `test/response-formatter-v2.test.ts` | Tests for structured output |

### Modified Files

| File | Changes |
|------|---------|
| `src/server/index.ts` | Register `analyze` tool, update tool descriptions |
| `src/server/tools/compute/index.ts` | Add preprocessing step, use structured output |
| `src/server/tools/verify/index.ts` | Add new verification strategies, structured output |
| `src/server/tools/plot/index.ts` | Use structured output format |
| `src/server/tools/response-formatter.ts` | Add structured JSON formatting |
| `src/server/prompts/index.ts` | Add 3 new prompt templates |
| `src/server/tools/compute/router.ts` | Fix routing priority rules |
| `benchmark/graders/grader.ts` | Add symbolic equivalence + multi-point numeric checks |
| `benchmark/graders/answer-parser.ts` | Use normalizer for extraction |
| `benchmark/index.ts` | Add `analyze` command |

### Success Metrics

| Metric | Current | Target |
|--------|---------|--------|
| MATH L3 accuracy | 80% (+MCP) | 85% |
| MATH L4 accuracy | 62% (+MCP) | 72% |
| MATH L5 accuracy | 52% (+MCP) | 62% |
| Omni-MATH >=7 | 0% | 10%+ |
| CAS problems | 26.7% (+MCP) | 45%+ |
| Regression rate | 8 per 360 problems | < 4 per 360 |
| Tool call rate | 30-70% | > 85% |
| GSM8K | 98% | 99% |

### Implementation Phases

**Phase 1 — Foundation (Structured Output + Preprocessing):**
- Structured output format across all tools
- Router preprocessing pipeline
- Smart tool descriptions
- Target: Eliminate output parse errors and grader mismatches

**Phase 2 — Intelligence (Strategy Layer):**
- `analyze` tool with classifier + strategy templates
- Tool usage plan generator
- New prompt templates (structured-solve, olympiad-solve, step-verify)
- Target: Increase tool call rate to > 85%

**Phase 3 — Verification (Enhanced verify):**
- Cross-validation strategy
- Boundary checks
- Reflexion loop
- Regression analysis tool
- Enhanced grader with symbolic equivalence
- Answer normalizer
- Target: Reduce regression rate by 50%+

**Phase 4 — Olympiad:**
- Olympiad strategy extensions in analyze
- Competition problem templates
- Exhaustive search capabilities
- Multi-step verification pipeline
- Target: Omni-MATH > 10%
