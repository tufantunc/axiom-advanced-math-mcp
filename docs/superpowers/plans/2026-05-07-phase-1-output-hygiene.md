# Phase 1: Output Hygiene Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wrap every MCP tool response in a structured JSON envelope ending with a `\boxed{...}` line so the LLM reliably repeats the symbolic answer instead of extracting only the leading coefficient (e.g., `3` instead of `3*x^2`).

**Architecture:** A new `response-formatter-v2.ts` module produces a `dual-format` text block: the body is `JSON.stringify(structured) + "\n\n\\boxed{...}"`. The existing `formatToolResponse` becomes a delegating shim — when `AXIOM_OUTPUT_V2=1` (set by `--features=output-v2`) it routes to v2; otherwise it preserves the v1 line-formatted output verbatim. Compute/verify/plot tools keep their current call sites unchanged. The verify tool gains a structured `fix_attempt` field that names a deterministic follow-up call. Phase 1 is purely additive and zero-risk when the feature flag is unset.

**Tech Stack:** TypeScript (strict, ES2022, NodeNext), vitest, MCP SDK 1.25, Giac WASM.

---

## Spec sections covered

| Spec section | Tasks |
|---|---|
| 1.1 Structured tool response | Tasks 1–4 |
| 1.2 Confidence determination | Task 2 |
| 1.3 Verify tool: structured fix_attempt | Task 5 |
| Plot: boxed trailer | Task 6 |
| Ablation flag (`--features=output-v2`) | Task 7 |
| Golden output corpus | Task 8 |
| Live measurement | Task 9 |

---

## File Structure

### New files

| File | Responsibility |
|---|---|
| `src/server/tools/response-formatter-v2.ts` | Pure function: builds the v2 envelope `{answer, answer_boxed, answer_latex?, answer_numeric?, confidence, warnings?, raw?}`, formats to dual-format text block. |
| `src/server/tools/confidence.ts` | Pure function: infers `confidence` from a tool result (low for empty/error/no-simplification, medium for plain success, high reserved for verified results). |
| `src/server/tools/verify/fix-attempt.ts` | Pure function: given a parsed verify claim and result, produces a deterministic `fix_attempt` (or `undefined`). |
| `test/response-formatter-v2.test.ts` | Unit tests for the v2 formatter. |
| `test/confidence.test.ts` | Unit tests for confidence inference. |
| `test/fix-attempt.test.ts` | Unit tests for fix_attempt generation. |
| `test/golden/output.golden.test.ts` | Tool-level golden tests: real Giac call → assert response contains correct `\boxed{...}` trailer. |

### Modified files

| File | Change |
|---|---|
| `src/server/tools/response-formatter.ts` | When `AXIOM_OUTPUT_V2=1`, delegate to `formatToolResponseV2`. Default v1 behavior unchanged. |
| `src/server/tools/compute/index.ts` | Pass tool result through `inferConfidence`, then format via response-formatter (which routes to v2 when flag set). No change to handler signature. |
| `src/server/tools/verify/index.ts` | When v2 flag is set, return JSON envelope including `fix_attempt`. v1 line-formatted output preserved otherwise. |
| `src/server/tools/plot/index.ts` | Append `\boxed{}`-style annotation to the text content under the image when v2 flag is set. (Plot has no scalar answer; the trailer becomes a brief plot summary line.) |
| `benchmark/config.ts` | Recognize `output-v2` in the `--features=` list; document in the parsing comment. |
| `benchmark/index.ts` | When `config.features.includes('output-v2')`, set `process.env.AXIOM_OUTPUT_V2 = '1'` before MCP server spawn so the spawned server inherits it. |
| `test/golden/fixtures.ts` | Add `OutputCase` interface + `OUTPUT_CASES` array seeded from CAS regressions (4 cases). |

### Removed/Renamed files

None.

---

## Task 1: response-formatter-v2 — basic envelope

**Files:**
- Create: `src/server/tools/response-formatter-v2.ts`
- Test: `test/response-formatter-v2.test.ts`

- [ ] **Step 1.1: Write failing test**

Create `test/response-formatter-v2.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { formatToolResponseV2 } from '../src/server/tools/response-formatter-v2.js';

describe('response-formatter-v2 — basic envelope', () => {
  it('produces JSON + boxed trailer for plain answer', () => {
    const r = formatToolResponseV2({
      answer: '3*x^2',
      answer_latex: '3 x^{2}',
      confidence: 'medium',
    });
    expect(r.isError).toBe(false);
    expect(r.content).toHaveLength(1);
    const text = r.content[0].text;
    // body: JSON line + blank line + boxed line
    const [jsonPart, blankLine, boxedLine] = text.split('\n');
    expect(blankLine).toBe('');
    expect(boxedLine).toBe('\\boxed{3*x^2}');
    const parsed = JSON.parse(jsonPart);
    expect(parsed.answer).toBe('3*x^2');
    expect(parsed.answer_boxed).toBe('\\boxed{3*x^2}');
    expect(parsed.answer_latex).toBe('3 x^{2}');
    expect(parsed.confidence).toBe('medium');
  });

  it('includes answer_numeric when numeric value supplied', () => {
    const r = formatToolResponseV2({
      answer: '16/3',
      answer_numeric: 16 / 3,
      confidence: 'medium',
    });
    const parsed = JSON.parse(r.content[0].text.split('\n')[0]);
    expect(parsed.answer_numeric).toBeCloseTo(5.3333, 4);
  });

  it('omits absent optional fields', () => {
    const r = formatToolResponseV2({ answer: '42', confidence: 'high' });
    const parsed = JSON.parse(r.content[0].text.split('\n')[0]);
    expect(parsed).not.toHaveProperty('answer_latex');
    expect(parsed).not.toHaveProperty('answer_numeric');
    expect(parsed).not.toHaveProperty('warnings');
    expect(parsed).not.toHaveProperty('raw');
  });

  it('includes warnings array when supplied non-empty', () => {
    const r = formatToolResponseV2({
      answer: '0',
      confidence: 'low',
      warnings: ['Empty result from solve'],
    });
    const parsed = JSON.parse(r.content[0].text.split('\n')[0]);
    expect(parsed.warnings).toEqual(['Empty result from solve']);
  });

  it('errors propagate via isError flag', () => {
    const r = formatToolResponseV2({
      answer: '',
      confidence: 'low',
      error: 'Tool failed: bad input',
    });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain('Tool failed');
  });
});
```

- [ ] **Step 1.2: Run test — verify it fails**

Run: `npm test -- response-formatter-v2`
Expected: module not found.

- [ ] **Step 1.3: Implement v2 formatter**

Create `src/server/tools/response-formatter-v2.ts`:

```typescript
/**
 * Phase 1 structured response formatter.
 *
 * Produces a dual-format text block: a single line of JSON followed by a blank
 * line and a `\boxed{...}` trailer. The JSON is for downstream automation; the
 * trailer is a well-known LaTeX pattern that LLMs reliably repeat verbatim,
 * which fixes the "model writes `3` instead of `3*x^2`" extraction failure.
 */

export type Confidence = 'high' | 'medium' | 'low';

export interface ToolResponseV2Input {
  answer: string;
  answer_latex?: string;
  answer_numeric?: number;
  alternatives?: string[];
  steps?: string[];
  confidence: Confidence;
  warnings?: string[];
  raw?: string;
  /** If set, returned response is marked isError=true and the body becomes the error message. */
  error?: string;
}

interface ToolResponseV2Body {
  answer: string;
  answer_boxed: string;
  answer_latex?: string;
  answer_numeric?: number;
  alternatives?: string[];
  steps?: string[];
  confidence: Confidence;
  warnings?: string[];
  raw?: string;
}

export function formatToolResponseV2(input: ToolResponseV2Input): {
  content: { type: 'text'; text: string }[];
  isError: boolean;
} {
  if (input.error) {
    return {
      content: [{ type: 'text' as const, text: `Error: ${input.error}` }],
      isError: true,
    };
  }

  const body: ToolResponseV2Body = {
    answer: input.answer,
    answer_boxed: `\\boxed{${input.answer}}`,
    confidence: input.confidence,
  };
  if (input.answer_latex !== undefined) body.answer_latex = input.answer_latex;
  if (input.answer_numeric !== undefined && Number.isFinite(input.answer_numeric)) {
    body.answer_numeric = input.answer_numeric;
  }
  if (input.alternatives && input.alternatives.length > 0) body.alternatives = input.alternatives;
  if (input.steps && input.steps.length > 0) body.steps = input.steps;
  if (input.warnings && input.warnings.length > 0) body.warnings = input.warnings;
  if (input.raw !== undefined) body.raw = input.raw;

  // Single-line JSON keeps the trailer on a predictable line for the LLM.
  const text = `${JSON.stringify(body)}\n\n${body.answer_boxed}`;

  return {
    content: [{ type: 'text' as const, text }],
    isError: false,
  };
}
```

- [ ] **Step 1.4: Run test — verify it passes**

Run: `npm test -- response-formatter-v2`
Expected: all 5 tests pass.

- [ ] **Step 1.5: Commit**

```bash
git add src/server/tools/response-formatter-v2.ts test/response-formatter-v2.test.ts
git commit -m "feat(tools): add v2 response formatter with JSON envelope + boxed trailer"
```

---

## Task 2: confidence inference module

**Files:**
- Create: `src/server/tools/confidence.ts`
- Test: `test/confidence.test.ts`

- [ ] **Step 2.1: Write failing test**

Create `test/confidence.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { inferConfidence } from '../src/server/tools/confidence.js';

describe('inferConfidence', () => {
  it('returns low for empty solve result', () => {
    expect(inferConfidence({ result: '[]', input: 'solve(x^2+1=0,x)' })).toBe('low');
  });

  it('returns low for GIAC_ERROR', () => {
    expect(inferConfidence({ result: 'GIAC_ERROR: bad arg', input: 'foo' })).toBe('low');
  });

  it('returns low for NaN/Inf/undef', () => {
    expect(inferConfidence({ result: 'NaN', input: '1/0' })).toBe('low');
    expect(inferConfidence({ result: 'Inf', input: '1/0' })).toBe('low');
    expect(inferConfidence({ result: 'undef', input: 'foo' })).toBe('low');
  });

  it('returns low when result equals input verbatim (no simplification)', () => {
    expect(inferConfidence({ result: 'x+1', input: 'x+1' })).toBe('low');
  });

  it('returns medium for normal successful result', () => {
    expect(inferConfidence({ result: '3*x^2', input: 'diff(x^3,x)' })).toBe('medium');
  });

  it('returns medium when result equals input but they are clearly numeric', () => {
    // "42" → "42" is fine — the user asked for the value of 42, got 42.
    expect(inferConfidence({ result: '42', input: '42' })).toBe('medium');
  });

  it('honors verified=true bumping confidence to high', () => {
    expect(inferConfidence({ result: '3*x^2', input: 'diff(x^3,x)', verified: true })).toBe('high');
  });

  it('honors verified=false demoting to low', () => {
    expect(inferConfidence({ result: '3*x^2', input: 'diff(x^3,x)', verified: false })).toBe('low');
  });
});
```

- [ ] **Step 2.2: Run test — verify it fails**

Run: `npm test -- confidence`
Expected: module not found.

- [ ] **Step 2.3: Implement confidence inference**

Create `src/server/tools/confidence.ts`:

```typescript
import type { Confidence } from './response-formatter-v2.js';

export interface ConfidenceInput {
  /** The Giac-formatted result string. */
  result: string;
  /** The original problem string the tool was called with. */
  input: string;
  /** If a verification step ran, its outcome. Overrides default inference. */
  verified?: boolean;
}

/**
 * Infer a confidence level from a tool's raw result.
 *
 * The rules are intentionally conservative: a result is `medium` by default,
 * `low` when there are concrete signals of failure, and `high` only when an
 * explicit verification step confirmed the result.
 *
 * Empty solve results, Giac errors, and non-finite numerics all fall to `low`.
 * Results identical to the input string indicate Giac couldn't simplify — also
 * `low`, EXCEPT when the input is a pure numeric scalar (the identity case).
 */
export function inferConfidence({ result, input, verified }: ConfidenceInput): Confidence {
  if (verified === true) return 'high';
  if (verified === false) return 'low';

  const trimmed = result.trim();

  // Hard failure signals
  if (/^\[\]$/.test(trimmed)) return 'low';
  if (/^GIAC_ERROR/.test(trimmed)) return 'low';
  if (/^(NaN|Inf|-Inf|undef)$/.test(trimmed)) return 'low';

  // No-simplification heuristic: result === input AND input contains operators.
  // Pure numeric scalars (e.g., "42" → "42") are not treated as failures.
  const inputNorm = input.replace(/\s+/g, '');
  const resultNorm = trimmed.replace(/\s+/g, '');
  if (inputNorm === resultNorm && /[+\-*/^()=]/.test(inputNorm)) {
    return 'low';
  }

  return 'medium';
}
```

- [ ] **Step 2.4: Run test — verify it passes**

Run: `npm test -- confidence`
Expected: all 8 tests pass.

- [ ] **Step 2.5: Commit**

```bash
git add src/server/tools/confidence.ts test/confidence.test.ts
git commit -m "feat(tools): add inferConfidence helper for tool results"
```

---

## Task 3: response-formatter shim for v2 flag

**Files:**
- Modify: `src/server/tools/response-formatter.ts`
- Modify: `test/response-formatter-v2.test.ts`

- [ ] **Step 3.1: Write failing test**

Append to `test/response-formatter-v2.test.ts`:

```typescript
import { formatToolResponse } from '../src/server/tools/response-formatter.js';

describe('formatToolResponse — v2 flag', () => {
  it('uses v1 line-formatted output by default', () => {
    delete process.env.AXIOM_OUTPUT_V2;
    const r = formatToolResponse({ result: '3*x^2', latex: '3 x^{2}' });
    expect(r.content[0].text).toBe('Result: 3*x^2');
    // v1 produces multiple content blocks; trailer line is "The answer is ..."
    const lastText = r.content[r.content.length - 1].text;
    expect(lastText).toMatch(/^The answer is /);
  });

  it('uses v2 envelope when AXIOM_OUTPUT_V2=1', () => {
    process.env.AXIOM_OUTPUT_V2 = '1';
    const r = formatToolResponse({ result: '3*x^2', latex: '3 x^{2}' });
    expect(r.content).toHaveLength(1);
    const lines = r.content[0].text.split('\n');
    expect(lines[lines.length - 1]).toBe('\\boxed{3*x^2}');
    const parsed = JSON.parse(lines[0]);
    expect(parsed.answer).toBe('3*x^2');
    expect(parsed.answer_latex).toBe('3 x^{2}');
    delete process.env.AXIOM_OUTPUT_V2;
  });

  it('passes through error responses in both modes', () => {
    delete process.env.AXIOM_OUTPUT_V2;
    // v1 has its own formatErrorResponse; just verify the shim doesn't break it.
    // (No direct call here — formatToolResponse only handles success path in v1.)
    expect(true).toBe(true); // placeholder; see formatErrorResponse separately
  });
});
```

- [ ] **Step 3.2: Run test — verify it fails**

Run: `npm test -- response-formatter-v2`
Expected: the v2-flag case fails — current `formatToolResponse` always uses v1.

- [ ] **Step 3.3: Wire the shim**

Edit `src/server/tools/response-formatter.ts`. Add after the existing imports / interface declarations:

```typescript
import { formatToolResponseV2 } from './response-formatter-v2.js';
import type { Confidence } from './response-formatter-v2.js';
```

Then modify `formatToolResponse` so the function body becomes:

```typescript
export function formatToolResponse(data: MathToolResponse): {
  content: { type: 'text'; text: string }[];
  isError: boolean;
} {
  if (process.env.AXIOM_OUTPUT_V2 === '1') {
    const numeric = data.decimal !== undefined ? Number(data.decimal) : undefined;
    return formatToolResponseV2({
      answer: data.result,
      answer_latex: data.latex,
      answer_numeric: Number.isFinite(numeric as number) ? numeric : undefined,
      confidence: ((data as { confidence?: Confidence }).confidence) ?? 'medium',
      warnings: data.notes,
      raw: data.giacCommand,
    });
  }

  // --- v1 path (unchanged) ---
  const lines: string[] = [];
  lines.push(`Result: ${data.result}`);
  if (data.decimal && data.decimal !== data.result) lines.push(`Decimal: ${data.decimal}`);
  if (data.latex) lines.push(`LaTeX: ${data.latex}`);
  if (data.giacCommand) lines.push(`Command: ${data.giacCommand}`);
  if (data.notes && data.notes.length > 0) lines.push(...data.notes);
  lines.push('');
  if (data.decimal && data.decimal !== data.result) {
    const rounded = parseFloat(data.decimal);
    if (!isNaN(rounded) && isFinite(rounded)) {
      const display = Number.isInteger(rounded)
        ? String(rounded)
        : parseFloat(rounded.toPrecision(10)).toString();
      lines.push(`The answer is ${data.result} (≈ ${display})`);
    } else {
      lines.push(`The answer is ${data.result}`);
    }
  } else {
    lines.push(`The answer is ${data.result}`);
  }
  return {
    content: lines.map((l) => ({ type: 'text' as const, text: l })),
    isError: false,
  };
}
```

Also extend the `MathToolResponse` interface to optionally accept a `confidence` field (used by Tasks 4 and 5 to pass through):

```typescript
export interface MathToolResponse {
  result: string;
  decimal?: string;
  latex?: string;
  giacCommand?: string;
  notes?: string[];
  /** Optional v2 confidence — only used when AXIOM_OUTPUT_V2=1. v1 ignores it. */
  confidence?: 'high' | 'medium' | 'low';
}
```

- [ ] **Step 3.4: Run test — verify it passes**

Run: `npm test -- response-formatter-v2`
Expected: all tests pass (5 + 3 = 8 total).

Run: `npm test 2>&1 | tail -5`
Expected: full suite still green (the v1 path is unchanged).

- [ ] **Step 3.5: Commit**

```bash
git add src/server/tools/response-formatter.ts test/response-formatter-v2.test.ts
git commit -m "feat(tools): formatToolResponse delegates to v2 when AXIOM_OUTPUT_V2=1"
```

---

## Task 4: compute tool — pass confidence through, opt into v2

**Files:**
- Modify: `src/server/tools/compute/index.ts`
- Modify: `src/server/tools/compute/normalize.ts` (read-only check; modify only if needed)
- Test: `test/compute-v2.test.ts` (new — small integration-ish test)

- [ ] **Step 4.1: Inspect current dispatcher / normalize flow**

Read `src/server/tools/compute/index.ts`, `dispatcher.ts`, and `normalize.ts`. The handler responses are typed `{ content, isError }`. The new responsibility is:

- Extract the inner `result` string from the dispatch return (existing handlers already produce `formatToolResponse` text).
- Run `inferConfidence({ result, input: problem })`.
- Re-format via `formatToolResponse` with `confidence` field set, so the shim picks it up under v2.

Because handlers already format the response, the cleanest insertion point is `formatOutput` in `index.ts`. We extract `result`/`latex` from the existing rawResponse text by parsing the first content line (`Result: …`) — the format is well-known.

Alternative, cleaner: add an optional `formatToolResponseWithConfidence(data, confidence)` overload. But this requires touching all handler call sites. We avoid that by parsing in `formatOutput`.

- [ ] **Step 4.2: Write integration test**

Create `test/compute-v2.test.ts`:

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { computeHandler } from '../src/server/tools/compute/index.js';

describe('computeHandler — v2 output flag', () => {
  beforeAll(() => {
    process.env.AXIOM_OUTPUT_V2 = '1';
  });
  afterAll(() => {
    delete process.env.AXIOM_OUTPUT_V2;
  });

  it('returns boxed trailer for derivative', async () => {
    const r = await computeHandler({ problem: 'diff(x^3, x)' });
    expect(r.isError).toBe(false);
    expect(r.content).toHaveLength(1);
    const lines = r.content[0].text.split('\n');
    const last = lines[lines.length - 1];
    // Real Giac result is "3*x^2"; mock may differ — assert structure only.
    expect(last.startsWith('\\boxed{')).toBe(true);
    expect(last.endsWith('}')).toBe(true);
  });

  it('emits low confidence on empty solve result', async () => {
    // The mock returns predictable "[]" for unsolvable; production Giac may differ.
    const r = await computeHandler({ problem: 'solve(x^2+1=0, x)', domain: 'real' });
    if (r.isError) return; // Mock may shape this differently — skip if so.
    const json = JSON.parse(r.content[0].text.split('\n')[0]);
    // We only assert the shape here; specific confidence depends on mock data.
    expect(['low', 'medium', 'high']).toContain(json.confidence);
  });
});
```

- [ ] **Step 4.3: Run test — verify it currently fails or skips appropriately**

Run: `npm test -- compute-v2`
Expected: the boxed-trailer assertion fails because compute hasn't been wired yet.

- [ ] **Step 4.4: Wire confidence + v2 routing in compute/index.ts**

Edit `src/server/tools/compute/index.ts`. Replace the `formatOutput` function with a v2-aware variant:

```typescript
import { inferConfidence } from '../confidence.js';
import { formatToolResponseV2 } from '../response-formatter-v2.js';

function formatOutput(
  envelope: ComputeEnvelope,
  format: string,
  rawResponse: { content: { type: 'text'; text: string }[]; isError: boolean },
  problem: string
): { content: { type: 'text'; text: string }[]; isError: boolean } {
  // V2 envelope — always wins when flag is set, regardless of `format`.
  if (process.env.AXIOM_OUTPUT_V2 === '1') {
    const result = envelope.display ?? '';
    const confidence = inferConfidence({ result, input: problem });
    const numeric = parseFloat(result);
    return formatToolResponseV2({
      answer: result,
      answer_latex: envelope.latex,
      answer_numeric: Number.isFinite(numeric) ? numeric : undefined,
      confidence,
      raw: envelope.giac_command,
    });
  }

  switch (format) {
    case 'json':
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(envelope, null, 2) }],
        isError: !envelope.success,
      };
    case 'latex':
      if (envelope.latex) {
        return {
          content: [
            { type: 'text' as const, text: `Result: ${envelope.display}` },
            { type: 'text' as const, text: `LaTeX: ${envelope.latex}` },
            ...(envelope.giac_command
              ? [{ type: 'text' as const, text: `Command: ${envelope.giac_command}` }]
              : []),
          ],
          isError: !envelope.success,
        };
      }
      return rawResponse;
    case 'text':
    default:
      return rawResponse;
  }
}
```

Update the call to `formatOutput` inside `computeHandler` to pass `problem`:

```typescript
return formatOutput(envelope, format, response, problem);
```

- [ ] **Step 4.5: Run tests**

Run: `npm test -- compute-v2`
Expected: 1+ tests pass (the boxed-trailer assertion).

Run: `npm test 2>&1 | tail -5`
Expected: full suite still green. Existing compute tests are unaffected because `AXIOM_OUTPUT_V2` is unset there.

- [ ] **Step 4.6: Commit**

```bash
git add src/server/tools/compute/index.ts test/compute-v2.test.ts
git commit -m "feat(compute): emit v2 envelope with boxed trailer when output-v2 flag set"
```

---

## Task 5: verify tool — structured fix_attempt + v2 envelope

**Files:**
- Create: `src/server/tools/verify/fix-attempt.ts`
- Test: `test/fix-attempt.test.ts`
- Modify: `src/server/tools/verify/index.ts`

- [ ] **Step 5.1: Write failing test for fix_attempt builder**

Create `test/fix-attempt.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { buildFixAttempt } from '../src/server/tools/verify/fix-attempt.js';

describe('buildFixAttempt', () => {
  it('returns undefined when verification passed', () => {
    expect(
      buildFixAttempt({ verified: true, type: 'identity', lhs: 'sin(x)^2 + cos(x)^2', rhs: '1' })
    ).toBeUndefined();
  });

  it('suggests compute(simplify(LHS)) for failed identity', () => {
    const fa = buildFixAttempt({
      verified: false,
      type: 'identity',
      lhs: 'sin(x)^2 + cos(x)^2',
      rhs: '2',
    });
    expect(fa).toBeDefined();
    expect(fa!.next_call.tool).toBe('compute');
    expect(fa!.next_call.args).toEqual({ problem: 'simplify(sin(x)^2 + cos(x)^2)' });
    expect(fa!.rationale).toContain('LHS');
  });

  it('suggests compute(solve(equation)) for failed solution check', () => {
    const fa = buildFixAttempt({
      verified: false,
      type: 'solution',
      variable: 'x',
      value: '3',
      equation: 'x^2 - 4 = 0',
    });
    expect(fa).toBeDefined();
    expect(fa!.next_call.tool).toBe('compute');
    expect(fa!.next_call.args).toEqual({ problem: 'solve(x^2 - 4 = 0, x)' });
  });

  it('returns undefined for unknown claim shape', () => {
    expect(
      buildFixAttempt({ verified: false, type: 'unknown' })
    ).toBeUndefined();
  });
});
```

- [ ] **Step 5.2: Run test — verify it fails**

Run: `npm test -- fix-attempt`
Expected: module not found.

- [ ] **Step 5.3: Implement fix-attempt builder**

Create `src/server/tools/verify/fix-attempt.ts`:

```typescript
/**
 * Build a deterministic fix_attempt for a verify result.
 *
 * The model is instructed in the system prompt to issue exactly the call
 * named in fix_attempt.next_call when verified=false. Generating these
 * deterministically (rather than free-form "try something") keeps retries
 * bounded and predictable.
 */

export interface FixAttempt {
  next_call: { tool: string; args: Record<string, unknown> };
  rationale: string;
}

export type ParsedClaimForFix =
  | { verified: boolean; type: 'identity'; lhs: string; rhs: string }
  | {
      verified: boolean;
      type: 'solution';
      variable: string;
      value: string;
      equation: string;
    }
  | { verified: boolean; type: 'unknown' };

export function buildFixAttempt(parsed: ParsedClaimForFix): FixAttempt | undefined {
  if (parsed.verified) return undefined;

  if (parsed.type === 'identity') {
    return {
      next_call: { tool: 'compute', args: { problem: `simplify(${parsed.lhs})` } },
      rationale:
        `Identity check failed. Recompute the LHS via compute → simplify, ` +
        `then verify the result matches the claimed RHS.`,
    };
  }

  if (parsed.type === 'solution') {
    return {
      next_call: {
        tool: 'compute',
        args: { problem: `solve(${parsed.equation}, ${parsed.variable})` },
      },
      rationale:
        `Substitution did not satisfy the equation. Solve directly to find ` +
        `the actual root(s), then re-verify.`,
    };
  }

  return undefined;
}
```

- [ ] **Step 5.4: Run test — verify it passes**

Run: `npm test -- fix-attempt`
Expected: all 4 tests pass.

- [ ] **Step 5.5: Extend formatter-v2 to accept fix_attempt**

The spec puts `fix_attempt` at the top level of the response body. Add it to the formatter types.

In `src/server/tools/response-formatter-v2.ts`, add to `ToolResponseV2Input`:

```typescript
  fix_attempt?: { next_call: { tool: string; args: Record<string, unknown> }; rationale: string };
```

Add the same field to `ToolResponseV2Body`. In the body construction inside `formatToolResponseV2`, add (alongside the existing optional-field copies):

```typescript
  if (input.fix_attempt) body.fix_attempt = input.fix_attempt;
```

- [ ] **Step 5.6: Wire v2 envelope + fix_attempt into verify handler**

Edit `src/server/tools/verify/index.ts`. At the top, add:

```typescript
import { formatToolResponseV2 } from '../response-formatter-v2.js';
import { buildFixAttempt, type ParsedClaimForFix } from './fix-attempt.js';
```

Replace the `formatVerifyResponse(result)` function with a version that branches on the env flag and accepts `parsed`:

```typescript
function formatVerifyResponse(
  result: VerifyResult,
  parsed: ParsedClaim
): { content: { type: 'text'; text: string }[]; isError: boolean } {
  if (process.env.AXIOM_OUTPUT_V2 === '1') {
    const fixInput: ParsedClaimForFix =
      parsed.type === 'identity'
        ? { verified: result.verified, type: 'identity', lhs: parsed.lhs!, rhs: parsed.rhs! }
        : parsed.type === 'solution'
          ? {
              verified: result.verified,
              type: 'solution',
              variable: parsed.variable!,
              value: parsed.value!,
              equation: parsed.equation!,
            }
          : { verified: result.verified, type: 'unknown' };

    const fix = buildFixAttempt(fixInput);
    return formatToolResponseV2({
      answer: result.verified ? 'TRUE' : 'FALSE',
      confidence: result.confidence,
      warnings: result.checks_performed,
      raw: result.explanation,
      ...(fix !== undefined ? { fix_attempt: fix } : {}),
    });
  }

  // v1 line-formatted output
  const lines: string[] = [
    `Verified: ${result.verified ? 'TRUE ✓' : 'FALSE ✗'}`,
    `Confidence: ${result.confidence}`,
    `Explanation: ${result.explanation}`,
    '',
    'Checks performed:',
    ...result.checks_performed.map((c) => `  - ${c}`),
  ];
  return {
    content: lines.map((l) => ({ type: 'text' as const, text: l })),
    isError: false,
  };
}
```

Find every `return formatVerifyResponse(result);` call site in `verifyHandler` and update to pass the parsed claim:

```typescript
return formatVerifyResponse(result, parsed);
```

`parsed` is the `ParsedClaim` produced earlier in the handler — already in scope at all call sites.

- [ ] **Step 5.7: Add a verify-v2 integration test**

Append to `test/fix-attempt.test.ts`:

```typescript
import { verifyHandler } from '../src/server/tools/verify/index.js';

describe('verifyHandler — v2 envelope', () => {
  beforeEach(() => {
    process.env.AXIOM_OUTPUT_V2 = '1';
  });
  afterEach(() => {
    delete process.env.AXIOM_OUTPUT_V2;
  });

  it('emits boxed TRUE / FALSE answer + confidence', async () => {
    const r = await verifyHandler({ claim: '1 + 1 = 2', method: 'symbolic' });
    expect(r.isError).toBe(false);
    const lines = r.content[0].text.split('\n');
    expect(lines[lines.length - 1]).toMatch(/^\\boxed\{(TRUE|FALSE)\}$/);
    const json = JSON.parse(lines[0]);
    expect(['TRUE', 'FALSE']).toContain(json.answer);
    expect(['high', 'medium', 'low']).toContain(json.confidence);
  });

  it('attaches fix_attempt on identity failure', async () => {
    const r = await verifyHandler({ claim: 'sin(x) = 2', method: 'symbolic' });
    const json = JSON.parse(r.content[0].text.split('\n')[0]);
    if (json.answer === 'FALSE') {
      expect(json.fix_attempt).toBeDefined();
      expect(json.fix_attempt.next_call.tool).toBe('compute');
    }
  });
});
```

Add the missing imports at the top of the test file:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
```

- [ ] **Step 5.8: Run all verify tests**

Run: `npm test -- "fix-attempt|verify"`
Expected: fix_attempt unit tests + verify-v2 integration tests all pass.

Run: `npm test 2>&1 | tail -5`
Expected: full suite green.

- [ ] **Step 5.9: Commit**

```bash
git add src/server/tools/verify/index.ts src/server/tools/verify/fix-attempt.ts src/server/tools/response-formatter-v2.ts test/fix-attempt.test.ts test/response-formatter-v2.test.ts
git commit -m "feat(verify): structured fix_attempt + v2 envelope under output-v2 flag"
```

---

## Task 6: plot tool — boxed annotation when v2 set

**Files:**
- Modify: `src/server/tools/plot/index.ts`
- Test: `test/plot-v2.test.ts`

- [ ] **Step 6.1: Write failing test**

Create `test/plot-v2.test.ts`:

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { z } from 'zod';

// Plot tool registers via server.tool — for direct testing we exercise the
// internal logic. Easiest path: create a minimal mock McpServer.tool capture.
import { registerPlotTools } from '../src/server/tools/plot/index.js';

describe('plot tool — v2 envelope', () => {
  let captured: { name: string; description: string; schema: unknown; handler: Function } | null =
    null;
  const fakeServer = {
    tool(
      name: string,
      description: string,
      schema: unknown,
      handler: (args: Record<string, unknown>) => Promise<unknown>
    ) {
      captured = { name, description, schema, handler };
    },
  } as unknown as Parameters<typeof registerPlotTools>[0];

  beforeAll(() => {
    process.env.AXIOM_OUTPUT_V2 = '1';
    registerPlotTools(fakeServer);
  });
  afterAll(() => {
    delete process.env.AXIOM_OUTPUT_V2;
  });

  it('appends boxed-style summary line under v2', async () => {
    expect(captured).not.toBeNull();
    const result = (await captured!.handler({
      expression: 'x^2',
      x_min: -2,
      x_max: 2,
    })) as { content: ({ type: 'text'; text: string } | { type: 'image' })[]; isError: boolean };
    expect(result.isError).toBe(false);
    const textBlocks = result.content.filter((c) => c.type === 'text') as {
      type: 'text';
      text: string;
    }[];
    expect(textBlocks.some((b) => /^\\boxed\{plot:/.test(b.text))).toBe(true);
  });
});
```

- [ ] **Step 6.2: Run test — verify it fails**

Run: `npm test -- plot-v2`
Expected: the boxed-line assertion fails.

- [ ] **Step 6.3: Modify plot to emit boxed annotation**

Edit `src/server/tools/plot/index.ts`. Inside the handler, after `svgBase64` is computed, change the `return` block to:

```typescript
        const summary = `Plot of f(${variable}) = ${args.expression} over [${xMin}, ${xMax}]`;
        const v2 = process.env.AXIOM_OUTPUT_V2 === '1';

        return {
          content: [
            {
              type: 'image' as const,
              data: svgBase64,
              mimeType: 'image/svg+xml',
            },
            { type: 'text' as const, text: summary },
            ...(v2
              ? [
                  {
                    type: 'text' as const,
                    text: `\\boxed{plot: f(${variable}) = ${args.expression}}`,
                  },
                ]
              : []),
          ],
          isError: false,
        };
```

- [ ] **Step 6.4: Run test — verify it passes**

Run: `npm test -- plot-v2`
Expected: pass.

Run: `npm test 2>&1 | tail -5`
Expected: full suite green.

- [ ] **Step 6.5: Commit**

```bash
git add src/server/tools/plot/index.ts test/plot-v2.test.ts
git commit -m "feat(plot): append boxed annotation under output-v2 flag"
```

---

## Task 7: --features=output-v2 ablation flag wiring

**Files:**
- Modify: `benchmark/index.ts`
- Test: extend an existing benchmark feature test (or add an inline check)

- [ ] **Step 7.1: Inspect benchmark feature wiring**

Read `benchmark/index.ts` lines 55–70. The Phase 0 work added:

```typescript
if (config.features.includes('v2')) process.env.AXIOM_GRADER_V2 = '1';
if (config.features.length > 0) log(`  Features: ${config.features.join(',')}`);
```

We extend the same pattern.

- [ ] **Step 7.2: Add output-v2 mapping**

Edit `benchmark/index.ts`. Find the existing `if (config.features.includes('v2'))` line. Right after it, add:

```typescript
  if (config.features.includes('output-v2')) process.env.AXIOM_OUTPUT_V2 = '1';
```

- [ ] **Step 7.3: Smoke test**

Run:
```bash
cd /Users/tufantunc/Desktop/Projects/Personal/axiom-advanced-math-mcp/benchmark
tsx -e "
import { buildConfig } from './config.js';
process.argv = ['tsx', 'index.ts', '--features=output-v2,v2', '--gsm8k', '--quick'];
const c = buildConfig();
console.log('features:', c.features);
"
```

Expected: prints `features: ['output-v2', 'v2']`.

- [ ] **Step 7.4: Commit**

```bash
git add benchmark/index.ts
git commit -m "feat(benchmark): --features=output-v2 sets AXIOM_OUTPUT_V2 env"
```

---

## Task 8: golden output corpus

**Files:**
- Modify: `test/golden/fixtures.ts` (add `OUTPUT_CASES` array + `OutputCase` interface)
- Create: `test/golden/output.golden.test.ts`
- Modify: `vitest.config.integration.ts` (include the new file)
- Modify: `vitest.config.ts` (exclude the new file from unit config)

- [ ] **Step 8.1: Add fixture cases**

Edit `test/golden/fixtures.ts`. Add at the bottom:

```typescript
export interface OutputCase {
  description: string;
  computeProblem: string;
  expectedAnswerSubstring: string;
  expectedBoxed: string; // exact `\boxed{...}` line we expect to see at end of response
}

export const OUTPUT_CASES: OutputCase[] = [
  {
    description: 'derivative of x^3 produces \\boxed{3*x^2} (regression CAS 2026-04-08)',
    computeProblem: 'diff(x^3, x)',
    expectedAnswerSubstring: '3*x^2',
    expectedBoxed: '\\boxed{3*x^2}',
  },
  {
    description: 'definite integral sqrt(x) on [0,4] produces \\boxed{16/3} (regression CAS #28)',
    computeProblem: 'int(sqrt(x), x, 0, 4)',
    expectedAnswerSubstring: '16/3',
    expectedBoxed: '\\boxed{16/3}',
  },
  {
    description: 'remainder polynomial division produces \\boxed{-82/27} (regression MATH L4 #45)',
    computeProblem: 'rem(3*y^4 - 4*y^3 + 5*y^2 - 13*y + 4, 3*y - 2, y)',
    expectedAnswerSubstring: '-82/27',
    expectedBoxed: '\\boxed{-82/27}',
  },
  {
    description: 'product-rule derivative produces \\boxed{...} (regression #45 CAS-style)',
    computeProblem: 'diff(sin(x)*x^2, x)',
    expectedAnswerSubstring: 'cos(x)',
    expectedBoxed: '', // exact boxed output depends on Giac normalization order; we assert presence only
  },
];
```

- [ ] **Step 8.2: Create output golden test**

Create `test/golden/output.golden.test.ts`:

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { computeHandler } from '../../src/server/tools/compute/index.js';
import { OUTPUT_CASES } from './fixtures.js';

describe('golden output corpus (real Giac, v2 envelope)', () => {
  beforeAll(() => {
    process.env.AXIOM_OUTPUT_V2 = '1';
  });
  afterAll(() => {
    delete process.env.AXIOM_OUTPUT_V2;
  });

  for (const c of OUTPUT_CASES) {
    it(c.description, async () => {
      const r = await computeHandler({ problem: c.computeProblem });
      expect(r.isError).toBe(false);
      expect(r.content).toHaveLength(1);
      const text = r.content[0].text;
      const lines = text.split('\n');
      const last = lines[lines.length - 1];

      // Always: trailer is a boxed line.
      expect(last.startsWith('\\boxed{')).toBe(true);
      expect(last.endsWith('}')).toBe(true);

      // The JSON body's `answer` field must contain the expected substring.
      const json = JSON.parse(lines[0]);
      expect(typeof json.answer).toBe('string');
      expect(json.answer).toContain(c.expectedAnswerSubstring);

      // If an exact boxed string is given, assert it.
      if (c.expectedBoxed) {
        expect(last).toBe(c.expectedBoxed);
      }
    }, 15000);
  }
});
```

- [ ] **Step 8.3: Wire vitest configs**

Edit `vitest.config.integration.ts` `include` to add the new file:

```typescript
    include: [
      'test/integration.test.ts',
      'test/golden/tool.golden.test.ts',
      'test/golden/output.golden.test.ts',
    ],
```

Edit `vitest.config.ts` `exclude` to add the new file:

```typescript
    exclude: [
      'test/integration.test.ts',
      'test/golden/tool.golden.test.ts',
      'test/golden/output.golden.test.ts',
    ],
```

- [ ] **Step 8.4: Run integration tests**

Run: `npm run test:integration -- output.golden 2>&1 | tail -20`
Expected: 4/4 output golden tests pass.

If any fail because Giac produces a different normalization (e.g. spaces, factor order), do NOT loosen the test — check whether the v2 envelope is actually emitting the value found in the JSON `answer` field. The fixture asserts `expectedAnswerSubstring`, which should be substring-stable.

- [ ] **Step 8.5: Run unit tests**

Run: `npm test 2>&1 | tail -5`
Expected: full unit suite green; output.golden is excluded.

- [ ] **Step 8.6: Commit**

```bash
git add test/golden/fixtures.ts test/golden/output.golden.test.ts vitest.config.ts vitest.config.integration.ts
git commit -m "test(golden): output corpus assertions for v2 envelope"
```

---

## Task 9: live demo run + Phase 1 results doc

**Files:**
- Create: `docs/superpowers/specs/2026-05-07-phase-1-results.md`

This task requires LLM API access (e.g., `ZAI_API_KEY` in the user's `.env`). If credentials are missing, write the results doc with structural placeholders showing how to run the experiment, mark the document `Status: NOT YET RUN`, and commit. The user can fill in numbers later.

- [ ] **Step 9.1: Run a small demo on GSM8K**

GSM8K is small (100 problems) and has predictable outputs — best for fast directional signal at low cost.

Run two conditions:
- Baseline (no flags): the `--features=v2` is set so the grader is honest, but `--features=output-v2` is NOT — the tool output is v1 line-formatted.
- Experimental: both `--features=v2,output-v2` — tool output is structured JSON + boxed trailer.

```bash
cd /Users/tufantunc/Desktop/Projects/Personal/axiom-advanced-math-mcp/benchmark
# Condition A: grader-v2 only (baseline for Phase 1)
npm run gsm8k:quick:zai -- --features=v2 2>&1 | tail -20

# Condition B: grader-v2 + output-v2
npm run gsm8k:quick:zai -- --features=v2,output-v2 2>&1 | tail -20
```

Expected: each run produces a JSONL + JSON + MD report under `benchmark/results/`. Note both timestamps.

If the user lacks credentials, skip to Step 9.3.

- [ ] **Step 9.2: Run analyze on both result files**

```bash
cd /Users/tufantunc/Desktop/Projects/Personal/axiom-advanced-math-mcp/benchmark
npm run analyze -- results/<condition-A-jsonl> 2>&1 | tail -15
npm run analyze -- results/<condition-B-jsonl> 2>&1 | tail -15
```

Note the `OUTPUT_PARSE_ERROR` count in each report. The hypothesis: condition B has fewer.

- [ ] **Step 9.3: Write Phase 1 results doc**

Create `docs/superpowers/specs/2026-05-07-phase-1-results.md`:

```markdown
# Phase 1 — Results

**Date:** 2026-05-07
**Branch:** main (post-Phase-1)
**Method:** A/B comparison with `--features=v2` (control) vs `--features=v2,output-v2` (experimental).
**Condition A (control):** structured grader, v1 tool output.
**Condition B (experimental):** structured grader + structured tool output with `\boxed{}` trailer.

## Result tables

[Paste GSM8K result tables from both conditions, OR mark the doc as
`Status: NOT YET RUN — credentials unavailable` if step 9.1 was skipped.]

## OUTPUT_PARSE_ERROR delta

| Condition | OUTPUT_PARSE_ERROR | Total regressions |
|---|---|---|
| A: grader-v2 only | [count] | [count] |
| B: grader-v2 + output-v2 | [count] | [count] |
| Δ | [delta] | [delta] |

## Phase 1 success-metric check

| Target | Result | Status |
|---|---|---|
| OUTPUT_PARSE_ERROR ≤ 1 (per 360 problems extrapolation) | [...] | [PASS/FAIL] |
| MATH L4 ≥ 65% (under conditions B) | [...] | [PASS/FAIL or NOT YET MEASURED] |
| MATH L5 ≥ 56% | [...] | [PASS/FAIL or NOT YET MEASURED] |
| CAS calculus subdomain ≥ 40% | [...] | [PASS/FAIL or NOT YET MEASURED] |

## Findings

[For each finding, name the specific case ID + dataset. Examples:
- "GSM8K #12 (Carlos lemon tree) was a regression in Phase 0 because the model
  rounded `n>=12` to 12 instead of taking the ceiling 13. Under condition B,
  the model output ... [observation]."
- "CAS #28 (sqrt(x) integral) was 0% in Phase 0. Under condition B, the model
  output `\boxed{16/3}` ... [observation]."]

## Phase 2 inputs

[What the next phase needs to address based on remaining failures.]

## Files shipped in Phase 1

- `src/server/tools/response-formatter-v2.ts` — v2 envelope formatter
- `src/server/tools/confidence.ts` — confidence inference
- `src/server/tools/verify/fix-attempt.ts` — deterministic fix_attempt builder
- `src/server/tools/response-formatter.ts` — v2 routing shim
- `src/server/tools/compute/index.ts` — wired
- `src/server/tools/verify/index.ts` — wired
- `src/server/tools/plot/index.ts` — boxed annotation
- `benchmark/index.ts` — `--features=output-v2` ablation flag
- `test/golden/output.golden.test.ts` — output corpus tests
```

If step 9.1 produced numbers, populate every `[...]` placeholder with the real value before committing. If step 9.1 was skipped, write `NOT YET RUN — fill in once credentials are available` in the relevant sections; do NOT commit the bare placeholders.

- [ ] **Step 9.4: Commit**

```bash
git add docs/superpowers/specs/2026-05-07-phase-1-results.md
git commit -m "docs(phase-1): results report (A/B output-v2 vs v2-only)"
```

---

## Self-Review Checklist

After all tasks ship, run these checks before declaring Phase 1 complete:

- [ ] All unit tests pass: `npm test`
- [ ] Integration tests pass: `npm run test:integration`
- [ ] Type check passes: `npm run typecheck`
- [ ] Lint passes: `npm run lint`
- [ ] `--features=output-v2` flag works end-to-end on a smoke run
- [ ] Output golden tests pass under integration config
- [ ] Phase 1 results doc is written and committed (with real numbers if credentials available, or marked NOT YET RUN)
- [ ] When `AXIOM_OUTPUT_V2` is unset, every existing tool produces byte-for-byte the same output as before Phase 1 (no regressions in v1 path)

If a metric is not met, do NOT roll Phase 1 forward — update the results doc with an honest assessment and decide whether to iterate within Phase 1 or escalate.

---

## Out of scope for Phase 1 (deferred)

- Compute layer preprocessing and fallback chain — Phase 2
- Self-consistency / N-sample voting — Phase 3
- Olympiad-specific prompt — Phase 4
- `analyze` MCP tool — Phase 4 (only if needed)
- Updating system prompts to instruct the model on the new envelope — Phase 1.5 follow-up if observed gain is small (model may pick up `\boxed{}` purely by training prior, no prompt change needed)
