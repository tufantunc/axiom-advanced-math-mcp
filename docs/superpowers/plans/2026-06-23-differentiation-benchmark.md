# Differentiation Benchmark Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A standalone `benchmark/differentiation/` subsystem that runs the same problem sets through four arms (pure-model, code-exec, SymPy MCP, Axiom MCP) on one model (Sonnet 4.6 via claude-code), plus a dedicated verify task set, and emits a side-by-side comparison artifact — without touching the existing benchmark's behavior.

**Architecture:** Reuse the existing dataset loaders, `grade()`, and the claude-code pure helpers (`buildCliArgs`, `buildMcpConfig`, `parseClaudeCodeStream`) by import. The only existing-file change is an additive, backward-compatible extension to `buildCliArgs` (allow/deny tool flags). All arm orchestration, the verify set/scorer, and the aggregator are new files under `benchmark/differentiation/`.

**Tech Stack:** TypeScript, vitest, `child_process.spawn`, Claude Code CLI ≥ 2.x.

**Spec:** `docs/superpowers/specs/2026-06-23-differentiation-benchmark-design.md`

**Execution context:** Isolated git worktree (standing instruction — parallel sessions share this checkout). Branch: `differentiation-benchmark`; symlink `node_modules` from the main checkout.

**Probe-verified facts (trust these):**
- The CLI supports `--allowed-tools <tools...>` and `--disallowed-tools <tools...>` (allowlist/denylist), `--mcp-config`, `--strict-mcp-config`, `--setting-sources`.
- claude-code provider exports the pure helpers `buildCliArgs(CliArgOptions)`, `buildMcpConfig(serverCmd, basedir)`, and `parseClaudeCodeStream(lines)`; the provider's own `run()` has a `settled` guard. `CliArgOptions` currently has `{model, maxTurns, mcpConfigPath?, appendSystemPrompt?}`.
- Two SymPy MCP candidates exist: `sdiehl/sympy-mcp` (Python, `uvx`) and `codeprimate/math-mcp` (Docker; indirect `math`/`math_ls` tool interface). Task 1 pins one.

**File map:**
- `benchmark/differentiation/arms.ts` — Arm definitions + SymPy MCP launch command (NEW)
- `benchmark/providers/claude-code.ts` — additive `allowedTools`/`disallowedTools` in `buildCliArgs` (MODIFY)
- `benchmark/differentiation/arm-runner.ts` — `armCliArgs()` (pure) + `runArm()` (spawn) (NEW)
- `benchmark/differentiation/verify-set.ts` — verify claim dataset (NEW)
- `benchmark/differentiation/verify-scorer.ts` — pure verdict scorer (NEW)
- `benchmark/differentiation/compare.ts` — metric rollup + side-by-side table (NEW)
- `benchmark/differentiation/run.ts` — orchestrator entry script (NEW)
- `test/differentiation-*.test.ts` — unit tests (NEW)

**Binding constraint:** the existing 629-test suite must stay green UNMODIFIED. If any pre-existing test fails after a change, STOP and report.

---

### Task 1: Probe + pin SymPy MCP and tool-restriction semantics; write `arms.ts`

**Files:**
- Create: `benchmark/differentiation/arms.ts`
- Test: `test/differentiation-arms.test.ts` (new)

This task resolves the two CLI unknowns by direct probe, then encodes the result.

- [ ] **Step 1.1: Probe tool-restriction semantics**

Run (from an empty temp dir) to confirm `--allowed-tools` is an allowlist and that an unattached MCP name yields zero tools (pure-model trick):

```bash
cd "$(mktemp -d)" && claude -p "List your available tools, then stop." \
  --model claude-haiku-4-5 --output-format stream-json --verbose \
  --dangerously-skip-permissions --setting-sources project --strict-mcp-config \
  --allowed-tools mcp__none 2>&1 | grep -o '"tools":\[[^]]*\]' | head -1
```

Expected: the init event's allowed tool set is empty/none (proving `--allowed-tools mcp__none` = pure model). Record the result. If `mcp__none` errors, fall back to `--disallowed-tools Bash WebSearch WebFetch Read Write Edit Glob Grep Task` for the pure-model arm and note it.

- [ ] **Step 1.2: Probe + pin the SymPy MCP server**

Try the Python server first (lighter than Docker-image-build):

```bash
cd "$(mktemp -d)" && cat > sympy-mcp.json <<'JSON'
{"mcpServers":{"sympy":{"command":"uvx","args":["sympy-mcp"]}}}
JSON
claude -p "Use the sympy MCP server to compute the derivative of x^3. Then stop." \
  --model claude-haiku-4-5 --output-format stream-json --verbose \
  --dangerously-skip-permissions --setting-sources project --strict-mcp-config \
  --mcp-config sympy-mcp.json --allowed-tools mcp__sympy 2>&1 | grep -iE 'mcp__sympy|3.?x|error' | head
```

Expected: a `mcp__sympy__*` tool call appears and the result contains `3*x^2` (or `3x^2`). If `uvx sympy-mcp` is not resolvable, fall back to the Docker server: `{"command":"docker","args":["run","-i","--rm","math-mcp"]}` (build per its README first) whose primary tool is `mcp__math-mcp__math` (execute-by-name) — and set the arm's allowed tool to `mcp__math-mcp` accordingly. **Record the exact working launch command and server name.**

- [ ] **Step 1.3: Write the failing test**

Create `test/differentiation-arms.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { ARMS, SYMPY_MCP_CMD } from '../benchmark/differentiation/arms.js';

describe('differentiation arms', () => {
  it('defines exactly the four arms with distinct names', () => {
    expect(ARMS.map((a) => a.name).sort()).toEqual(['axiom', 'code-exec', 'pure-model', 'sympy']);
  });

  it('each arm has an allowlist and a declared mcp backend', () => {
    for (const arm of ARMS) {
      expect(Array.isArray(arm.allowedTools)).toBe(true);
      expect(arm.allowedTools.length).toBeGreaterThan(0);
      expect(['none', 'axiom', 'sympy']).toContain(arm.mcp);
    }
  });

  it('only the sympy/axiom arms attach an MCP backend', () => {
    expect(ARMS.find((a) => a.name === 'axiom')!.mcp).toBe('axiom');
    expect(ARMS.find((a) => a.name === 'sympy')!.mcp).toBe('sympy');
    expect(ARMS.find((a) => a.name === 'code-exec')!.mcp).toBe('none');
    expect(ARMS.find((a) => a.name === 'pure-model')!.mcp).toBe('none');
  });

  it('exposes a SymPy MCP launch command', () => {
    expect(SYMPY_MCP_CMD.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 1.4: Run to verify failure**

Run: `npx vitest run test/differentiation-arms.test.ts --reporter=verbose`
Expected: FAIL — module does not exist.

- [ ] **Step 1.5: Implement `arms.ts`** (fill `SYMPY_MCP_CMD` + pure-model allowlist with the values pinned in 1.1/1.2)

```ts
export type ArmName = 'pure-model' | 'code-exec' | 'sympy' | 'axiom';

export interface Arm {
  name: ArmName;
  /** Passed to claude `--allowed-tools` (allowlist). Restricts the arm to its
   *  intended backend so accuracy is attributable. */
  allowedTools: string[];
  /** Which MCP server to attach. */
  mcp: 'none' | 'axiom' | 'sympy';
}

/** SymPy MCP launch command, pinned by the Task 1 probe.
 *  Default: sdiehl/sympy-mcp via uvx. Fallback (Docker): ['docker','run','-i','--rm','math-mcp']
 *  with the arm allowlist set to 'mcp__math-mcp' instead of 'mcp__sympy'. */
export const SYMPY_MCP_CMD: string[] = ['uvx', 'sympy-mcp'];

/** Server name as it appears in claude tool names (mcp__<name>__<tool>). */
export const SYMPY_SERVER_NAME = 'sympy';

export const ARMS: Arm[] = [
  // 'mcp__none' is an unattached server → grants zero usable tools (pure model).
  { name: 'pure-model', allowedTools: ['mcp__none'], mcp: 'none' },
  { name: 'code-exec', allowedTools: ['Bash'], mcp: 'none' },
  { name: 'sympy', allowedTools: [`mcp__${SYMPY_SERVER_NAME}`], mcp: 'sympy' },
  { name: 'axiom', allowedTools: ['mcp__axiom'], mcp: 'axiom' },
];
```

- [ ] **Step 1.6: Run the test — passes**

Run: `npx vitest run test/differentiation-arms.test.ts --reporter=verbose`
Expected: 4/4 PASS.

- [ ] **Step 1.7: Commit**

```bash
git add benchmark/differentiation/arms.ts test/differentiation-arms.test.ts
git commit -m "feat(diff-bench): arm definitions + pinned SymPy MCP launch command"
```

---

### Task 2: Extend `buildCliArgs` with allow/deny tool flags (backward-compatible)

**Files:**
- Modify: `benchmark/providers/claude-code.ts`
- Test: `test/claude-code-provider.test.ts` (extend — do NOT modify existing tests)

- [ ] **Step 2.1: Write the failing tests**

Append to `test/claude-code-provider.test.ts` (reuse the existing `buildCliArgs` import at the top):

```ts
describe('buildCliArgs: tool allow/deny (diff-bench)', () => {
  it('omits allow/deny flags by default (unchanged behavior)', () => {
    const args = buildCliArgs({ model: 'claude-sonnet-4-6', maxTurns: 8 });
    expect(args).not.toContain('--allowed-tools');
    expect(args).not.toContain('--disallowed-tools');
  });

  it('passes --allowed-tools with each tool as its own arg', () => {
    const args = buildCliArgs({ model: 'claude-sonnet-4-6', maxTurns: 8, allowedTools: ['mcp__axiom', 'Bash'] });
    const i = args.indexOf('--allowed-tools');
    expect(i).toBeGreaterThan(-1);
    expect(args[i + 1]).toBe('mcp__axiom');
    expect(args[i + 2]).toBe('Bash');
  });

  it('passes --disallowed-tools when provided', () => {
    const args = buildCliArgs({ model: 'claude-sonnet-4-6', maxTurns: 8, disallowedTools: ['WebSearch'] });
    expect(args[args.indexOf('--disallowed-tools') + 1]).toBe('WebSearch');
  });
});
```

- [ ] **Step 2.2: Run to verify failure**

Run: `npx vitest run test/claude-code-provider.test.ts --reporter=verbose`
Expected: the two new flag tests FAIL.

- [ ] **Step 2.3: Implement**

In `benchmark/providers/claude-code.ts`, extend the `CliArgOptions` interface:

```ts
export interface CliArgOptions {
  model: string;
  maxTurns: number;
  mcpConfigPath?: string;
  appendSystemPrompt?: string;
  allowedTools?: string[];
  disallowedTools?: string[];
}
```

In `buildCliArgs`, after the existing `--mcp-config` / `--append-system-prompt` pushes (before `return args`), add:

```ts
  if (opts.allowedTools && opts.allowedTools.length > 0) {
    args.push('--allowed-tools', ...opts.allowedTools);
  }
  if (opts.disallowedTools && opts.disallowedTools.length > 0) {
    args.push('--disallowed-tools', ...opts.disallowedTools);
  }
```

- [ ] **Step 2.4: Run tests — pass**

Run: `npx vitest run test/claude-code-provider.test.ts --reporter=verbose`
Expected: all PASS (existing + 3 new).

- [ ] **Step 2.5: Full suite (guardrail)**

Run: `npm test && npm run typecheck`
Expected: all green (existing behavior unaffected — defaults add no flags).

- [ ] **Step 2.6: Commit**

```bash
git add benchmark/providers/claude-code.ts test/claude-code-provider.test.ts
git commit -m "feat(bench): buildCliArgs gains backward-compatible allow/deny tool flags"
```

---

### Task 3: Arm CLI-arg builder + runner

**Files:**
- Create: `benchmark/differentiation/arm-runner.ts`
- Test: `test/differentiation-arm-runner.test.ts` (new)

- [ ] **Step 3.1: Write the failing tests** (pure arg-construction only; spawn is live-smoke in Task 7)

Create `test/differentiation-arm-runner.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { armCliArgs } from '../benchmark/differentiation/arm-runner.js';
import { ARMS } from '../benchmark/differentiation/arms.js';

const paths = { axiomMcpPath: '/tmp/axiom.json', sympyMcpPath: '/tmp/sympy.json' };

describe('armCliArgs', () => {
  it('axiom arm: attaches axiom mcp config + allows only mcp__axiom', () => {
    const arm = ARMS.find((a) => a.name === 'axiom')!;
    const args = armCliArgs('PROMPT', arm, { model: 'claude-sonnet-4-6', maxTurns: 8, ...paths });
    expect(args[0]).toBe('-p');
    expect(args[1]).toBe('PROMPT');
    expect(args[args.indexOf('--mcp-config') + 1]).toBe('/tmp/axiom.json');
    expect(args[args.indexOf('--allowed-tools') + 1]).toBe('mcp__axiom');
  });

  it('sympy arm: attaches sympy mcp config', () => {
    const arm = ARMS.find((a) => a.name === 'sympy')!;
    const args = armCliArgs('P', arm, { model: 'claude-sonnet-4-6', maxTurns: 8, ...paths });
    expect(args[args.indexOf('--mcp-config') + 1]).toBe('/tmp/sympy.json');
  });

  it('code-exec arm: no mcp config, allows only Bash', () => {
    const arm = ARMS.find((a) => a.name === 'code-exec')!;
    const args = armCliArgs('P', arm, { model: 'claude-sonnet-4-6', maxTurns: 8, ...paths });
    expect(args).not.toContain('--mcp-config');
    expect(args[args.indexOf('--allowed-tools') + 1]).toBe('Bash');
  });

  it('pure-model arm: no mcp config', () => {
    const arm = ARMS.find((a) => a.name === 'pure-model')!;
    const args = armCliArgs('P', arm, { model: 'claude-sonnet-4-6', maxTurns: 8, ...paths });
    expect(args).not.toContain('--mcp-config');
  });
});
```

- [ ] **Step 3.2: Run to verify failure**

Run: `npx vitest run test/differentiation-arm-runner.test.ts --reporter=verbose`
Expected: FAIL — module does not exist.

- [ ] **Step 3.3: Implement `arm-runner.ts`**

```ts
import { spawn } from 'child_process';
import { buildCliArgs } from '../providers/claude-code.js';
import { parseClaudeCodeStream } from '../providers/claude-code-stream.js';
import type { Arm } from './arms.js';

export interface ArmRunOptions {
  model: string;
  maxTurns: number;
  axiomMcpPath: string;
  sympyMcpPath: string;
  appendSystemPrompt?: string;
  cwd?: string;
  timeoutMs?: number;
}

/** Build the full `claude` argument list for one arm + prompt. Pure. */
export function armCliArgs(prompt: string, arm: Arm, opts: ArmRunOptions): string[] {
  const mcpConfigPath =
    arm.mcp === 'axiom' ? opts.axiomMcpPath : arm.mcp === 'sympy' ? opts.sympyMcpPath : undefined;
  return [
    '-p',
    prompt,
    ...buildCliArgs({
      model: opts.model,
      maxTurns: opts.maxTurns,
      mcpConfigPath,
      appendSystemPrompt: opts.appendSystemPrompt,
      allowedTools: arm.allowedTools,
    }),
  ];
}

export interface ArmRunResult {
  text: string;
  toolCalls: { name: string; success: boolean }[];
  turns: number;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
  ok: boolean;
}

const DEFAULT_TIMEOUT_MS = Number(process.env.AXIOM_DIFF_TIMEOUT_MS ?? 600_000);

/** Run one prompt through one arm via the claude CLI. Resolves with a result
 *  (ok=false on failure) — never rejects, so one bad call can't abort a matrix. */
export function runArm(prompt: string, arm: Arm, opts: ArmRunOptions): Promise<ArmRunResult> {
  const args = armCliArgs(prompt, arm, opts);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const start = Date.now();
  return new Promise((resolve) => {
    const child = spawn('claude', args, {
      cwd: opts.cwd ?? process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let settled = false;
    const finish = (r: ArmRunResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish({ text: '', toolCalls: [], turns: 0, inputTokens: 0, outputTokens: 0, durationMs: Date.now() - start, ok: false });
    }, timeoutMs);
    child.stdout.on('data', (d: Buffer) => {
      stdout += d.toString();
    });
    child.on('error', () =>
      finish({ text: '', toolCalls: [], turns: 0, inputTokens: 0, outputTokens: 0, durationMs: Date.now() - start, ok: false })
    );
    child.on('close', (code) => {
      const p = parseClaudeCodeStream(stdout.split('\n').filter((l) => l.trim()));
      finish({
        text: p.text,
        toolCalls: p.toolCalls.map((t) => ({ name: t.name, success: t.success })),
        turns: p.turns,
        inputTokens: p.inputTokens,
        outputTokens: p.outputTokens,
        durationMs: Date.now() - start,
        ok: code === 0 && !p.isError,
      });
    });
  });
}
```

- [ ] **Step 3.4: Run the tests — pass**

Run: `npx vitest run test/differentiation-arm-runner.test.ts --reporter=verbose`
Expected: 4/4 PASS.

- [ ] **Step 3.5: Commit**

```bash
git add benchmark/differentiation/arm-runner.ts test/differentiation-arm-runner.test.ts
git commit -m "feat(diff-bench): per-arm claude CLI arg builder + runner"
```

---

### Task 4: Verify task set + verify scorer

**Files:**
- Create: `benchmark/differentiation/verify-set.ts`
- Create: `benchmark/differentiation/verify-scorer.ts`
- Test: `test/differentiation-verify.test.ts` (new)

- [ ] **Step 4.1: Write the failing tests**

Create `test/differentiation-verify.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { VERIFY_SET } from '../benchmark/differentiation/verify-set.js';
import { scoreVerify } from '../benchmark/differentiation/verify-scorer.js';

describe('VERIFY_SET', () => {
  it('is balanced true/false and non-trivial in size', () => {
    expect(VERIFY_SET.length).toBeGreaterThanOrEqual(12);
    const trues = VERIFY_SET.filter((c) => c.isTrue).length;
    const falses = VERIFY_SET.length - trues;
    expect(Math.abs(trues - falses)).toBeLessThanOrEqual(1); // balanced
  });
});

describe('scoreVerify', () => {
  it('extracts an explicit TRUE verdict', () => {
    expect(scoreVerify('After checking, the claim is TRUE.', true)).toEqual({ verdict: 'true', correct: true });
    expect(scoreVerify('Verdict: TRUE', false)).toEqual({ verdict: 'true', correct: false });
  });

  it('extracts an explicit FALSE verdict', () => {
    expect(scoreVerify('This is FALSE.', false)).toEqual({ verdict: 'false', correct: true });
  });

  it('reads the tool-style "Verified: TRUE/FALSE" line', () => {
    expect(scoreVerify('Verified: FALSE ✗\nConfidence: high', false)).toEqual({ verdict: 'false', correct: true });
  });

  it('returns ambiguous (incorrect) when no clear verdict', () => {
    expect(scoreVerify('Let me think about this problem.', true)).toEqual({ verdict: 'ambiguous', correct: false });
  });

  it('takes the LAST explicit verdict when both words appear', () => {
    expect(scoreVerify('It might be false, but actually the final answer is TRUE.', true)).toEqual({ verdict: 'true', correct: true });
  });
});
```

- [ ] **Step 4.2: Run to verify failure**

Run: `npx vitest run test/differentiation-verify.test.ts --reporter=verbose`
Expected: FAIL — modules do not exist.

- [ ] **Step 4.3: Implement `verify-set.ts`**

```ts
export interface VerifyCase {
  claim: string;
  isTrue: boolean;
  domain: string;
}

/** Balanced true/false math claims across domains. The false cases are
 *  plausible-but-wrong (the discriminator for real verification). */
export const VERIFY_SET: VerifyCase[] = [
  { claim: 'd/dx (x^3) = 3*x^2', isTrue: true, domain: 'derivative' },
  { claim: 'd/dx (x^3) = 2*x^2', isTrue: false, domain: 'derivative' },
  { claim: 'integral of 2*x dx = x^2 + C', isTrue: true, domain: 'integral' },
  { claim: 'integral of 2*x dx = 2*x^2 + C', isTrue: false, domain: 'integral' },
  { claim: '(x+1)^2 = x^2 + 2*x + 1', isTrue: true, domain: 'algebra' },
  { claim: '(x+1)^2 = x^2 + 1', isTrue: false, domain: 'algebra' },
  { claim: 'sin(x)^2 + cos(x)^2 = 1', isTrue: true, domain: 'identity' },
  { claim: 'sin(x)^2 - cos(x)^2 = 1', isTrue: false, domain: 'identity' },
  { claim: 'the eigenvalues of [[2,0],[0,3]] are 2 and 3', isTrue: true, domain: 'linear-algebra' },
  { claim: 'the eigenvalues of [[2,0],[0,3]] are 1 and 6', isTrue: false, domain: 'linear-algebra' },
  { claim: 'limit of (sin(x)/x) as x->0 is 1', isTrue: true, domain: 'limit' },
  { claim: 'limit of (sin(x)/x) as x->0 is 0', isTrue: false, domain: 'limit' },
  { claim: 'x^2 - 5*x + 6 factors as (x-2)*(x-3)', isTrue: true, domain: 'factor' },
  { claim: 'x^2 - 5*x + 6 factors as (x-1)*(x-6)', isTrue: false, domain: 'factor' },
];
```

- [ ] **Step 4.4: Implement `verify-scorer.ts`**

```ts
export interface VerifyScore {
  verdict: 'true' | 'false' | 'ambiguous';
  correct: boolean;
}

/** Extract a TRUE/FALSE verdict from a response. Takes the LAST explicit
 *  verdict token (the model's final conclusion), tolerating tool output like
 *  "Verified: FALSE". Returns 'ambiguous' (scored incorrect) when neither
 *  appears. */
export function scoreVerify(responseText: string, isTrue: boolean): VerifyScore {
  const upper = responseText.toUpperCase();
  // Find last standalone TRUE / FALSE (word-boundaried).
  let lastTrue = -1;
  let lastFalse = -1;
  for (const m of upper.matchAll(/\bTRUE\b/g)) lastTrue = m.index ?? lastTrue;
  for (const m of upper.matchAll(/\bFALSE\b/g)) lastFalse = m.index ?? lastFalse;

  let verdict: VerifyScore['verdict'];
  if (lastTrue === -1 && lastFalse === -1) verdict = 'ambiguous';
  else verdict = lastTrue > lastFalse ? 'true' : 'false';

  const correct = (verdict === 'true' && isTrue) || (verdict === 'false' && !isTrue);
  return { verdict, correct };
}
```

Note: `\bFALSE\b` is matched independently of `\bTRUE\b`, so "FALSE" never trips the TRUE matcher (word boundaries). The last-index comparison resolves responses that mention both.

- [ ] **Step 4.5: Run the tests — pass**

Run: `npx vitest run test/differentiation-verify.test.ts --reporter=verbose`
Expected: all PASS.

- [ ] **Step 4.6: Commit**

```bash
git add benchmark/differentiation/verify-set.ts benchmark/differentiation/verify-scorer.ts test/differentiation-verify.test.ts
git commit -m "feat(diff-bench): verify claim set + verdict scorer"
```

---

### Task 5: Metric rollup + comparison aggregator

**Files:**
- Create: `benchmark/differentiation/compare.ts`
- Test: `test/differentiation-compare.test.ts` (new)

- [ ] **Step 5.1: Write the failing tests**

Create `test/differentiation-compare.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { rollupArm, renderComparison } from '../benchmark/differentiation/compare.js';
import type { ArmProblemRecord, ArmVerifyRecord } from '../benchmark/differentiation/compare.js';

const problems: ArmProblemRecord[] = [
  { correct: true, toolCalls: [{ name: 'mcp__axiom__compute', success: true }], turns: 2, outputTokens: 100, extractionClean: true },
  { correct: false, toolCalls: [{ name: 'mcp__axiom__compute', success: false }], turns: 3, outputTokens: 200, extractionClean: false },
];
const verifies: ArmVerifyRecord[] = [
  { isTrue: true, correct: true },
  { isTrue: false, correct: true },
  { isTrue: false, correct: false },
];

describe('rollupArm', () => {
  it('computes accuracy, tool-success, avg turns/tokens, extraction-clean', () => {
    const r = rollupArm('axiom', problems, verifies);
    expect(r.accuracy).toBeCloseTo(0.5);
    expect(r.toolSuccessRate).toBeCloseTo(0.5);
    expect(r.avgTurns).toBeCloseTo(2.5);
    expect(r.avgOutputTokens).toBeCloseTo(150);
    expect(r.extractionCleanRate).toBeCloseTo(0.5);
  });

  it('computes confirm-true and reject-false separately', () => {
    const r = rollupArm('axiom', problems, verifies);
    expect(r.confirmTrueRate).toBeCloseTo(1); // 1 true claim, got it
    expect(r.rejectFalseRate).toBeCloseTo(0.5); // 2 false claims, 1 correct
    expect(r.verifyAccuracy).toBeCloseTo(2 / 3);
  });

  it('handles zero tool calls without NaN', () => {
    const r = rollupArm('pure-model', [{ correct: true, toolCalls: [], turns: 1, outputTokens: 50, extractionClean: true }], []);
    expect(r.toolSuccessRate).toBe(0);
    expect(r.verifyAccuracy).toBe(0);
  });
});

describe('renderComparison', () => {
  it('renders a markdown table with one row per arm', () => {
    const a = rollupArm('axiom', problems, verifies);
    const b = rollupArm('sympy', problems, verifies);
    const md = renderComparison([a, b]);
    expect(md).toContain('| axiom |');
    expect(md).toContain('| sympy |');
    expect(md).toContain('Reject-false');
  });
});
```

- [ ] **Step 5.2: Run to verify failure**

Run: `npx vitest run test/differentiation-compare.test.ts --reporter=verbose`
Expected: FAIL — module does not exist.

- [ ] **Step 5.3: Implement `compare.ts`**

```ts
import type { ArmName } from './arms.js';

export interface ArmProblemRecord {
  correct: boolean;
  toolCalls: { name: string; success: boolean }[];
  turns: number;
  outputTokens: number;
  extractionClean: boolean;
}

export interface ArmVerifyRecord {
  isTrue: boolean;
  correct: boolean;
}

export interface ArmRollup {
  arm: ArmName | string;
  n: number;
  accuracy: number;
  toolSuccessRate: number;
  avgTurns: number;
  avgOutputTokens: number;
  extractionCleanRate: number;
  confirmTrueRate: number;
  rejectFalseRate: number;
  verifyAccuracy: number;
}

const rate = (num: number, den: number): number => (den === 0 ? 0 : num / den);
const mean = (xs: number[]): number => (xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length);

export function rollupArm(
  arm: ArmName | string,
  problems: ArmProblemRecord[],
  verifies: ArmVerifyRecord[]
): ArmRollup {
  const allToolCalls = problems.flatMap((p) => p.toolCalls);
  const trueClaims = verifies.filter((v) => v.isTrue);
  const falseClaims = verifies.filter((v) => !v.isTrue);
  return {
    arm,
    n: problems.length,
    accuracy: rate(problems.filter((p) => p.correct).length, problems.length),
    toolSuccessRate: rate(allToolCalls.filter((t) => t.success).length, allToolCalls.length),
    avgTurns: mean(problems.map((p) => p.turns)),
    avgOutputTokens: mean(problems.map((p) => p.outputTokens)),
    extractionCleanRate: rate(problems.filter((p) => p.extractionClean).length, problems.length),
    confirmTrueRate: rate(trueClaims.filter((v) => v.correct).length, trueClaims.length),
    rejectFalseRate: rate(falseClaims.filter((v) => v.correct).length, falseClaims.length),
    verifyAccuracy: rate(verifies.filter((v) => v.correct).length, verifies.length),
  };
}

const pct = (x: number): string => `${(x * 100).toFixed(1)}%`;

export function renderComparison(rows: ArmRollup[]): string {
  const header =
    '| Arm | N | Accuracy | Tool-success | Avg turns | Avg out-tok | Extraction-clean | Confirm-true | Reject-false | Verify-acc |\n' +
    '|---|---|---|---|---|---|---|---|---|---|';
  const body = rows
    .map(
      (r) =>
        `| ${r.arm} | ${r.n} | ${pct(r.accuracy)} | ${pct(r.toolSuccessRate)} | ${r.avgTurns.toFixed(1)} | ` +
        `${r.avgOutputTokens.toFixed(0)} | ${pct(r.extractionCleanRate)} | ${pct(r.confirmTrueRate)} | ` +
        `${pct(r.rejectFalseRate)} | ${pct(r.verifyAccuracy)} |`
    )
    .join('\n');
  return `${header}\n${body}\n`;
}
```

- [ ] **Step 5.4: Run the tests — pass**

Run: `npx vitest run test/differentiation-compare.test.ts --reporter=verbose`
Expected: all PASS.

- [ ] **Step 5.5: Commit**

```bash
git add benchmark/differentiation/compare.ts test/differentiation-compare.test.ts
git commit -m "feat(diff-bench): per-arm metric rollup + side-by-side comparison table"
```

---

### Task 6: Orchestrator `run.ts`

**Files:**
- Create: `benchmark/differentiation/run.ts`
- No test (integration entry script; exercised by the gated smoke + mini run in Task 7). Keep logic thin — all computation lives in the unit-tested modules.

- [ ] **Step 6.1: Implement `run.ts`**

This wires everything, reusing existing modules. **Confirmed exact exports (use these verbatim):** `loadCAS(limit)` from `../datasets/cas-problems.js`; CAS problem fields are `.problem` and `.answer`; `grade(modelResponse, groundTruth): Promise<GradeResult>` (GradeResult has `.correct`) from `../graders/grader.js`; `BASELINE_SYSTEM_PROMPT` from `../providers/prompts.js`; `buildMcpConfig(serverCmd, basedir)` from `../providers/claude-code.js`.

**Fairness — same prompt across all arms:** all arms get the SAME neutral system prompt (`BASELINE_SYSTEM_PROMPT` + a one-line "use any available tools to ensure correctness"); the raw problem is the `-p` message. Do NOT use a tool-advertising prompt — it would mismatch the pure-model arm (no tools) and bias attribution. Each arm differs ONLY in which tools are available; Claude Code surfaces the arm's tools to the model regardless of the prompt.

```ts
#!/usr/bin/env tsx
/**
 * Differentiation benchmark: same problems + verify set across four arms
 * (pure-model, code-exec, sympy, axiom), one model (Sonnet 4.6 via claude-code),
 * one grader. Emits a side-by-side comparison artifact.
 *
 * Usage:
 *   AXIOM_GRADER_V3=1 npx tsx benchmark/differentiation/run.ts [--limit N]
 */
import { mkdtempSync, writeFileSync, symlinkSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { ARMS, SYMPY_MCP_CMD } from './arms.js';
import { runArm } from './arm-runner.js';
import { VERIFY_SET } from './verify-set.js';
import { scoreVerify } from './verify-scorer.js';
import { rollupArm, renderComparison, type ArmProblemRecord, type ArmVerifyRecord } from './compare.js';
import { buildMcpConfig } from '../providers/claude-code.js';
import { grade } from '../graders/grader.js';
import { BASELINE_SYSTEM_PROMPT } from '../providers/prompts.js';
import { loadCAS } from '../datasets/cas-problems.js';

const MODEL = 'claude-sonnet-4-6';
const MAX_TURNS = 8;
// Same neutral prompt for every arm — fairness. Arms differ only in tools.
const SYSTEM_PROMPT = `${BASELINE_SYSTEM_PROMPT}\nUse any tools available to you to ensure your answer is correct.`;

function parseLimit(): number {
  const i = process.argv.indexOf('--limit');
  return i !== -1 ? Number(process.argv[i + 1]) : 20;
}

/** A clean answer is extractable (has a \boxed{...}). */
function isExtractionClean(text: string): boolean {
  return /\\boxed\{/.test(text);
}

async function main(): Promise<void> {
  const limit = parseLimit();
  const workdir = mkdtempSync(path.join(tmpdir(), 'axiom-diff-'));
  // tsx re-resolves itself from the child cwd; symlink node_modules so MCP servers launch.
  const nm = path.join(process.cwd(), 'node_modules');
  if (existsSync(nm)) {
    try {
      symlinkSync(nm, path.join(workdir, 'node_modules'));
    } catch {
      /* best-effort */
    }
  }

  // Write the two MCP configs (absolute paths; CLI runs in workdir).
  const axiomCfg = path.join(workdir, 'axiom.json');
  const sympyCfg = path.join(workdir, 'sympy.json');
  writeFileSync(axiomCfg, JSON.stringify(buildMcpConfig(['tsx', 'src/cli.ts'], process.cwd())));
  writeFileSync(sympyCfg, JSON.stringify({ mcpServers: { sympy: { command: SYMPY_MCP_CMD[0], args: SYMPY_MCP_CMD.slice(1) } } }));

  const problems = loadCAS(limit);
  const runOpts = { model: MODEL, maxTurns: MAX_TURNS, axiomMcpPath: axiomCfg, sympyMcpPath: sympyCfg, cwd: workdir };

  const rollups = [];
  for (const arm of ARMS) {
    console.log(`\n=== Arm: ${arm.name} ===`);

    // Block 1: accuracy + efficiency on CAS problems.
    const problemRecords: ArmProblemRecord[] = [];
    for (const p of problems) {
      const r = await runArm(p.problem, arm, { ...runOpts, appendSystemPrompt: SYSTEM_PROMPT });
      const g = r.ok ? await grade(r.text, String(p.answer)) : { correct: false };
      problemRecords.push({
        correct: g.correct,
        toolCalls: r.toolCalls,
        turns: r.turns,
        outputTokens: r.outputTokens,
        extractionClean: isExtractionClean(r.text),
      });
      console.log(`  ${p.problem.slice(0, 40)} → ${g.correct ? '✓' : '✗'} (${r.turns}t)`);
    }

    // Block 2: verify set.
    const verifyRecords: ArmVerifyRecord[] = [];
    for (const c of VERIFY_SET) {
      const prompt = `Verify whether this mathematical claim is correct: "${c.claim}". End your response with exactly one word: TRUE or FALSE.`;
      const r = await runArm(prompt, arm, { ...runOpts });
      const s = r.ok ? scoreVerify(r.text, c.isTrue) : { verdict: 'ambiguous' as const, correct: false };
      verifyRecords.push({ isTrue: c.isTrue, correct: s.correct });
    }

    rollups.push(rollupArm(arm.name, problemRecords, verifyRecords));
  }

  const md = renderComparison(rollups);
  const outPath = path.join(process.cwd(), 'benchmark', 'results', `differentiation-${MODEL}.md`);
  writeFileSync(outPath, `# Differentiation Benchmark — ${MODEL}\n\nN(problems)=${limit}, verify N=${VERIFY_SET.length}\n\n${md}\n`);
  console.log(`\n${md}\nWrote ${outPath}`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
```

Note: `appendSystemPrompt: SYSTEM_PROMPT` is the same neutral prompt for every arm (fairness); the `-p` message is the raw problem. This mirrors how the claude-code provider places templates as system prompts.

- [ ] **Step 6.2: Typecheck**

Run: `npm run typecheck`
Expected: clean (after reconciling the real import names). If a name is wrong, fix to the actual export.

- [ ] **Step 6.3: Lint + full suite (guardrail)**

Run: `npm run lint && npm test`
Expected: all green (no new unit tests here; existing 629 + the diff-bench unit tests from Tasks 1-5 pass).

- [ ] **Step 6.4: Commit**

```bash
git add benchmark/differentiation/run.ts
git commit -m "feat(diff-bench): orchestrator — four arms x (accuracy + verify) -> comparison artifact"
```

---

### Task 7: Gated live smoke + mini validation + final gates

**Files:**
- Create: `test/differentiation-smoke.test.ts` (gated)

- [ ] **Step 7.1: Gated live smoke for arm tool-restriction**

Create `test/differentiation-smoke.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, symlinkSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { ARMS } from '../benchmark/differentiation/arms.js';
import { runArm } from '../benchmark/differentiation/arm-runner.js';
import { buildMcpConfig } from '../benchmark/providers/claude-code.js';

const SMOKE = process.env.CLAUDE_CODE_SMOKE === '1';

describe.skipIf(!SMOKE)('differentiation live smoke (CLAUDE_CODE_SMOKE=1)', () => {
  const workdir = mkdtempSync(path.join(tmpdir(), 'axiom-diff-smoke-'));
  const nm = path.join(process.cwd(), 'node_modules');
  if (existsSync(nm)) {
    try { symlinkSync(nm, path.join(workdir, 'node_modules')); } catch { /* */ }
  }
  const axiomCfg = path.join(workdir, 'axiom.json');
  writeFileSync(axiomCfg, JSON.stringify(buildMcpConfig(['tsx', 'src/cli.ts'], process.cwd())));
  const sympyCfg = path.join(workdir, 'sympy.json'); // axiom-only smoke; sympy path required by type
  writeFileSync(sympyCfg, '{"mcpServers":{}}');
  const opts = { model: 'claude-haiku-4-5', maxTurns: 8, axiomMcpPath: axiomCfg, sympyMcpPath: sympyCfg, cwd: workdir };

  it('axiom arm uses an mcp__axiom__ tool (and not Bash)', async () => {
    const arm = ARMS.find((a) => a.name === 'axiom')!;
    const r = await runArm('Use your tools to compute the derivative of x^3. End with \\boxed{...}.', arm, opts);
    expect(r.ok).toBe(true);
    expect(r.toolCalls.some((t) => t.name.startsWith('mcp__axiom__'))).toBe(true);
    expect(r.toolCalls.some((t) => t.name === 'Bash')).toBe(false);
  }, 300000);

  it('pure-model arm makes no tool calls', async () => {
    const arm = ARMS.find((a) => a.name === 'pure-model')!;
    const r = await runArm('What is the derivative of x^3? End with \\boxed{...}.', arm, opts);
    expect(r.toolCalls.length).toBe(0);
  }, 300000);
});
```

- [ ] **Step 7.2: Run WITHOUT gate — skipped**

Run: `npx vitest run test/differentiation-smoke.test.ts --reporter=verbose`
Expected: skipped; suite green.

- [ ] **Step 7.3: Run WITH gate — live**

Run: `CLAUDE_CODE_SMOKE=1 npx vitest run test/differentiation-smoke.test.ts --reporter=verbose`
Expected: both pass — proves tool restriction holds (axiom arm calls axiom, not Bash; pure-model calls nothing). If the axiom arm still calls Bash, the `--allowed-tools` allowlist is not restricting as expected → revisit Task 1's flag semantics (try `--disallowed-tools Bash` additionally).

- [ ] **Step 7.4: Mini validation run (3 problems, all arms)**

Run: `AXIOM_GRADER_V3=1 npx tsx benchmark/differentiation/run.ts --limit 3`
Expected: completes; prints the comparison table with 4 rows; writes `benchmark/results/differentiation-claude-sonnet-4-6.md`. Sanity-check: axiom/sympy/code-exec arms show tool usage; pure-model shows none; verify columns populated. Report the table.

- [ ] **Step 7.5: Full quality gates**

Run: `npm test && npm run typecheck && npm run lint`
Expected: all green (629 existing + diff-bench unit tests; smoke skipped without the env var).

- [ ] **Step 7.6: Commit**

```bash
git add test/differentiation-smoke.test.ts
git commit -m "test(diff-bench): gated live smoke proving per-arm tool restriction"
```

- [ ] **Step 7.7: Record the user-facing full-run command (no code)**

The full differentiation run (from repo root, uses the subscription, ~30-60 min depending on `--limit`):

```bash
AXIOM_GRADER_V3=1 npx tsx benchmark/differentiation/run.ts --limit 30
```

Report this as the command the user runs to produce the pitch artifact; note that the verify-set always runs in full (14 claims × 4 arms) regardless of `--limit`.
