# Claude Code CLI Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A `claude-code` benchmark provider that runs problems through headless Claude Code (`claude -p`) — vanilla as baseline, with the Axiom MCP server attached as the tool condition — with full tool telemetry and zero grader/report changes.

**Architecture:** A pure stream-json parser module + a provider class that spawns the CLI per problem in an isolated temp cwd with `--setting-sources project --strict-mcp-config` (probe-verified: prevents user-level hooks/plugins/MCP leakage), plus small harness wiring (provider registry, CLI flag, skip the harness-side MCP proxy, product-scenario report caveat).

**Tech Stack:** TypeScript, vitest, `child_process.spawn`, Claude Code CLI ≥ 2.x.

**Spec:** `docs/superpowers/specs/2026-06-11-claude-code-provider-design.md`

**Execution context:** Work in an isolated git worktree (standing instruction — parallel sessions share this checkout). Branch name: `claude-code-provider`; symlink `node_modules` from the main checkout.

**Probe-verified stream-json facts** (shapes below are from a real `claude -p ... --output-format stream-json --verbose` run; trust these over guesses):
- `{"type":"system","subtype":"init", "tools":[...], "mcp_servers":[...], "plugins":[...]}` — first useful event.
- `{"type":"assistant","message":{"content":[{"type":"thinking",...}|{"type":"text","text":...}|{"type":"tool_use","id":...,"name":...,"input":{...}}]}}` — may appear many times; thinking blocks are ignored.
- `{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":...,"content":<string | [{"type":"text","text":...}]>,"is_error":<bool?>}]}}`
- `{"type":"result","subtype":"success","is_error":false,"num_turns":N,"result":"<final text>","usage":{"input_tokens":N,"output_tokens":N,...},"total_cost_usd":...}` — final event; `usage` totals cover all iterations.
- Other event types (`rate_limit_event`, `system` subtypes, …) must be tolerated and skipped.

---

### Task 1: Pure stream parser — `parseClaudeCodeStream`

**Files:**
- Create: `benchmark/providers/claude-code-stream.ts`
- Test: `test/claude-code-stream.test.ts` (new)

- [ ] **Step 1.1: Write the failing tests**

Create `test/claude-code-stream.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { parseClaudeCodeStream } from '../benchmark/providers/claude-code-stream.js';

const init = JSON.stringify({ type: 'system', subtype: 'init', tools: ['Bash'] });
const assistantText = (text: string) =>
  JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
const assistantToolUse = (id: string, name: string, input: Record<string, unknown>) =>
  JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] } });
const toolResult = (id: string, content: unknown, isError = false) =>
  JSON.stringify({
    type: 'user',
    message: { content: [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }] },
  });
const result = (text: string, opts: Partial<{ is_error: boolean; num_turns: number }> = {}) =>
  JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: opts.is_error ?? false,
    num_turns: opts.num_turns ?? 1,
    result: text,
    usage: { input_tokens: 10, output_tokens: 20 },
  });

describe('parseClaudeCodeStream', () => {
  it('assembles text and usage from a tool-free run', () => {
    const r = parseClaudeCodeStream([init, assistantText('The answer is \\boxed{4}.'), result('The answer is \\boxed{4}.')]);
    expect(r.text).toContain('\\boxed{4}');
    expect(r.toolCalls).toEqual([]);
    expect(r.turns).toBe(1);
    expect(r.inputTokens).toBe(10);
    expect(r.outputTokens).toBe(20);
    expect(r.isError).toBe(false);
  });

  it('pairs tool_use with tool_result into ToolCallRecords (string and array content)', () => {
    const lines = [
      init,
      assistantToolUse('t1', 'mcp__axiom__compute', { problem: 'diff(x^3,x)' }),
      toolResult('t1', 'Result: 3*x^2'),
      assistantToolUse('t2', 'Bash', { command: 'python3 -c "print(1)"' }),
      toolResult('t2', [{ type: 'text', text: '1' }]),
      assistantText('Done: \\boxed{3x^2}'),
      result('Done: \\boxed{3x^2}', { num_turns: 3 }),
    ];
    const r = parseClaudeCodeStream(lines);
    expect(r.toolCalls).toHaveLength(2);
    expect(r.toolCalls[0]).toEqual({
      name: 'mcp__axiom__compute',
      args: { problem: 'diff(x^3,x)' },
      result: 'Result: 3*x^2',
      success: true,
    });
    expect(r.toolCalls[1].result).toBe('1');
    expect(r.turns).toBe(3);
  });

  it('marks failed tool calls and includes tool results in the text transcript', () => {
    const lines = [
      assistantToolUse('t1', 'Bash', { command: 'false' }),
      toolResult('t1', 'command failed', true),
      result('gave up'),
    ];
    const r = parseClaudeCodeStream(lines);
    expect(r.toolCalls[0].success).toBe(false);
    expect(r.text).toContain('[Tool result: command failed]');
  });

  it('propagates is_error and tolerates malformed/unknown lines', () => {
    const lines = ['not json', JSON.stringify({ type: 'rate_limit_event' }), result('boom', { is_error: true })];
    const r = parseClaudeCodeStream(lines);
    expect(r.isError).toBe(true);
    expect(r.text).toBe('boom');
  });

  it('reports a missing result event as an error', () => {
    const r = parseClaudeCodeStream([assistantText('partial')]);
    expect(r.isError).toBe(true);
  });
});
```

- [ ] **Step 1.2: Run to verify failure**

Run: `npx vitest run test/claude-code-stream.test.ts --reporter=verbose`
Expected: FAIL — module does not exist.

- [ ] **Step 1.3: Implement**

Create `benchmark/providers/claude-code-stream.ts`:

```ts
import type { ToolCallRecord } from './types.js';

export interface ParsedClaudeCodeResult {
  /** Ordered transcript: assistant text blocks + "[Tool result: …]" snippets. */
  text: string;
  toolCalls: ToolCallRecord[];
  turns: number;
  inputTokens: number;
  outputTokens: number;
  isError: boolean;
}

const SNIPPET_LIMIT = 500;

function contentToText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => (b && typeof b === 'object' && (b as { type?: string }).type === 'text' ? (b as { text?: string }).text ?? '' : ''))
      .join('');
  }
  return '';
}

/**
 * Parse Claude Code's `--output-format stream-json --verbose` JSONL output.
 * Pure function — tolerates malformed lines and unknown event types. A run
 * with no final `result` event is reported as an error.
 */
export function parseClaudeCodeStream(lines: string[]): ParsedClaudeCodeResult {
  const parts: string[] = [];
  const toolCalls: ToolCallRecord[] = [];
  const pending = new Map<string, { name: string; args: Record<string, unknown> }>();
  let turns = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let isError = true; // until a result event proves otherwise
  let resultText = '';

  for (const line of lines) {
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const type = event.type;

    if (type === 'assistant' || type === 'user') {
      const message = event.message as { content?: unknown } | undefined;
      const content = Array.isArray(message?.content) ? (message.content as Record<string, unknown>[]) : [];
      for (const block of content) {
        if (type === 'assistant' && block.type === 'text' && typeof block.text === 'string') {
          parts.push(block.text);
        } else if (type === 'assistant' && block.type === 'tool_use') {
          pending.set(String(block.id), {
            name: String(block.name),
            args: (block.input as Record<string, unknown>) ?? {},
          });
        } else if (type === 'user' && block.type === 'tool_result') {
          const call = pending.get(String(block.tool_use_id));
          if (!call) continue;
          pending.delete(String(block.tool_use_id));
          const resultStr = contentToText(block.content);
          toolCalls.push({
            name: call.name,
            args: call.args,
            result: resultStr,
            success: block.is_error !== true,
          });
          parts.push(`[Tool result: ${resultStr.slice(0, SNIPPET_LIMIT)}]`);
        }
      }
    } else if (type === 'result') {
      isError = event.is_error === true;
      turns = typeof event.num_turns === 'number' ? event.num_turns : 0;
      resultText = typeof event.result === 'string' ? event.result : '';
      const usage = event.usage as { input_tokens?: number; output_tokens?: number } | undefined;
      inputTokens = usage?.input_tokens ?? 0;
      outputTokens = usage?.output_tokens ?? 0;
    }
  }

  // The final result text is normally the last assistant text; if the
  // transcript missed it (e.g. text-free run), fall back to result text.
  const text = parts.length > 0 ? parts.join('\n') : resultText;
  return { text: text || resultText, toolCalls, turns, inputTokens, outputTokens, isError };
}
```

Note for the test `propagates is_error...`: `text` must equal `'boom'` — the transcript is empty so the result-text fallback applies.

- [ ] **Step 1.4: Run the tests — all pass**

Run: `npx vitest run test/claude-code-stream.test.ts --reporter=verbose`
Expected: 5/5 PASS.

- [ ] **Step 1.5: Commit**

```bash
git add benchmark/providers/claude-code-stream.ts test/claude-code-stream.test.ts
git commit -m "feat(bench): stream-json parser for the claude-code provider"
```

---

### Task 2: The provider — `ClaudeCodeProvider`

**Files:**
- Create: `benchmark/providers/claude-code.ts`
- Test: `test/claude-code-provider.test.ts` (new — pure arg/config construction tests; live smoke comes in Task 4)

- [ ] **Step 2.1: Write the failing tests**

Create `test/claude-code-provider.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { buildCliArgs, buildMcpConfig } from '../benchmark/providers/claude-code.js';

describe('claude-code provider: CLI arg construction', () => {
  it('baseline args: isolation flags present, no --mcp-config', () => {
    const args = buildCliArgs({ model: 'claude-sonnet-4-6', maxTurns: 8 });
    expect(args).toContain('--setting-sources');
    expect(args[args.indexOf('--setting-sources') + 1]).toBe('project');
    expect(args).toContain('--strict-mcp-config');
    expect(args).toContain('--dangerously-skip-permissions');
    expect(args).toContain('--output-format');
    expect(args[args.indexOf('--output-format') + 1]).toBe('stream-json');
    expect(args).toContain('--verbose');
    expect(args[args.indexOf('--model') + 1]).toBe('claude-sonnet-4-6');
    expect(args[args.indexOf('--max-turns') + 1]).toBe('8');
    expect(args).not.toContain('--mcp-config');
  });

  it('tool-condition args add --mcp-config with the given path', () => {
    const args = buildCliArgs({ model: 'claude-sonnet-4-6', maxTurns: 8, mcpConfigPath: '/tmp/x.json' });
    expect(args[args.indexOf('--mcp-config') + 1]).toBe('/tmp/x.json');
  });
});

describe('claude-code provider: MCP config generation', () => {
  it('resolves relative paths in mcpServerCmd to absolute (CLI runs in a temp cwd)', () => {
    const cfg = buildMcpConfig(['tsx', '../src/cli.ts'], '/repo/benchmark');
    const axiom = cfg.mcpServers.axiom;
    expect(axiom.command).toBe('/repo/benchmark/node_modules/.bin/tsx');
    expect(axiom.args).toEqual(['/repo/src/cli.ts']);
  });

  it('keeps absolute commands and non-path args as-is', () => {
    const cfg = buildMcpConfig(['/usr/local/bin/node', 'dist/cli.js', '--flag'], '/repo/benchmark');
    expect(cfg.mcpServers.axiom.command).toBe('/usr/local/bin/node');
    expect(cfg.mcpServers.axiom.args).toEqual(['/repo/benchmark/dist/cli.js', '--flag']);
  });
});
```

(Path-resolution rule the implementation must follow: the command resolves through `<cwd>/node_modules/.bin/<cmd>` when `cmd` is a bare name — fall back to the bare name if that file does not exist at runtime, but `buildMcpConfig` itself is pure: it takes the basedir and constructs the `.bin` path unconditionally for bare names; args that contain a `/` or start with `.` are resolved with `path.resolve(basedir, arg)`, flags starting with `-` and bare words pass through.)

NOTE: with the rule above, `'dist/cli.js'` (contains `/`) resolves to `/repo/benchmark/dist/cli.js` and `'--flag'` passes through — matching the second test.

- [ ] **Step 2.2: Run to verify failure**

Run: `npx vitest run test/claude-code-provider.test.ts --reporter=verbose`
Expected: FAIL — module does not exist.

- [ ] **Step 2.3: Implement**

Create `benchmark/providers/claude-code.ts`:

```ts
import { spawn } from 'child_process';
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import type {
  LLMProvider,
  NeutralTool,
  BaselineResult,
  ToolAugmentedResult,
  ToolCallRecord,
} from './types.js';
import { parseClaudeCodeStream } from './claude-code-stream.js';

const DEFAULT_TIMEOUT_MS = Number(process.env.AXIOM_CC_TIMEOUT_MS ?? 600_000);

export interface CliArgOptions {
  model: string;
  maxTurns: number;
  mcpConfigPath?: string;
}

/** Build the claude CLI argument list (prompt is passed separately via -p). */
export function buildCliArgs(opts: CliArgOptions): string[] {
  const args = [
    '--model', opts.model,
    '--output-format', 'stream-json',
    '--verbose',
    '--max-turns', String(opts.maxTurns),
    '--dangerously-skip-permissions',
    // Isolation (probe-verified): without these, user-level hooks, plugins
    // and MCP servers leak into the session even in an empty cwd.
    '--setting-sources', 'project',
    '--strict-mcp-config',
  ];
  if (opts.mcpConfigPath) {
    args.push('--mcp-config', opts.mcpConfigPath);
  }
  return args;
}

export interface McpConfig {
  mcpServers: Record<string, { command: string; args: string[] }>;
}

/** Translate the harness's mcpServerCmd into a Claude Code MCP config.
 *  The CLI runs in a temp cwd, so every path must be absolute. */
export function buildMcpConfig(serverCmd: string[], basedir: string): McpConfig {
  const [cmd, ...rest] = serverCmd;
  const command = cmd.includes('/') || cmd.startsWith('.')
    ? path.resolve(basedir, cmd)
    : path.join(basedir, 'node_modules', '.bin', cmd);
  const args = rest.map((a) =>
    a.startsWith('-') ? a : a.includes('/') || a.startsWith('.') ? path.resolve(basedir, a) : a
  );
  return { mcpServers: { axiom: { command, args } } };
}

/**
 * Runs benchmark problems through headless Claude Code. Product-realistic
 * scenario: baseline is vanilla Claude Code (built-in tools incl. web),
 * the tool condition attaches the Axiom MCP server via --mcp-config.
 * The CLI owns the agent loop AND the MCP connection, so runWithTools
 * deliberately ignores the `tools` and `callTool` parameters.
 */
export class ClaudeCodeProvider implements LLMProvider {
  readonly name = 'claude-code';
  private readonly workdir: string;
  private readonly mcpConfigPath: string;

  constructor(
    readonly model: string,
    mcpServerCmd: string[],
    private readonly timeoutMs = DEFAULT_TIMEOUT_MS
  ) {
    this.workdir = mkdtempSync(path.join(tmpdir(), 'axiom-cc-bench-'));
    const config = buildMcpConfig(mcpServerCmd, process.cwd());
    // Fall back to the bare command if the .bin shim doesn't exist (e.g. global tsx)
    const axiom = config.mcpServers.axiom;
    if (axiom.command.includes('/node_modules/') && !existsSync(axiom.command)) {
      axiom.command = path.basename(axiom.command);
    }
    this.mcpConfigPath = path.join(this.workdir, 'mcp-config.json');
    writeFileSync(this.mcpConfigPath, JSON.stringify(config));
    // Best-effort temp-dir cleanup (spec) — the OS reaps tmpdir leftovers anyway.
    process.once('exit', () => {
      try {
        rmSync(this.workdir, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    });
  }

  private run(prompt: string, maxTurns: number, withMcp: boolean): Promise<ReturnType<typeof parseClaudeCodeStream> & { durationMs: number }> {
    const args = ['-p', prompt, ...buildCliArgs({
      model: this.model,
      maxTurns,
      mcpConfigPath: withMcp ? this.mcpConfigPath : undefined,
    })];
    const start = Date.now();
    return new Promise((resolve, reject) => {
      const child = spawn('claude', args, { cwd: this.workdir, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error(`claude-code timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);
      child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
      child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
      child.on('error', (err) => { clearTimeout(timer); reject(err); });
      child.on('close', (code) => {
        clearTimeout(timer);
        const parsed = parseClaudeCodeStream(stdout.split('\n').filter((l) => l.trim()));
        if (code !== 0 || parsed.isError) {
          reject(new Error(
            `claude-code failed (exit ${code}, isError ${parsed.isError}): ${stderr.slice(0, 500) || parsed.text.slice(0, 500)}`
          ));
          return;
        }
        resolve({ ...parsed, durationMs: Date.now() - start });
      });
    });
  }

  async runBaseline(problem: string, _maxTokens: number, _temperature?: number): Promise<BaselineResult> {
    // Vanilla Claude Code: built-in tools on, no Axiom. maxTokens/temperature
    // are owned by the CLI and intentionally ignored.
    const r = await this.run(problem, 8, false);
    return { text: r.text, inputTokens: r.inputTokens, outputTokens: r.outputTokens, durationMs: r.durationMs };
  }

  async runWithTools(
    problem: string,
    _tools: NeutralTool[],
    _callTool: (name: string, args: Record<string, unknown>) => Promise<string>,
    _maxTokens: number,
    maxTurns: number,
    _temperature?: number
  ): Promise<ToolAugmentedResult> {
    // The CLI spawns and talks to the Axiom MCP server itself; the harness's
    // tools/callTool are unused here by design (see the class doc comment).
    const r = await this.run(problem, maxTurns, true);
    const toolCalls: ToolCallRecord[] = r.toolCalls;
    return {
      text: r.text,
      toolCalls,
      turns: r.turns,
      inputTokens: r.inputTokens,
      outputTokens: r.outputTokens,
      durationMs: r.durationMs,
    };
  }
}
```

`runBaseline` uses a fixed `8` for maxTurns because the interface does not pass maxTurns to baselines; vanilla Claude Code may use several turns for built-in tools. (Document this in the code comment.)

- [ ] **Step 2.4: Run the tests — all pass**

Run: `npx vitest run test/claude-code-provider.test.ts --reporter=verbose`
Expected: 4/4 PASS.

- [ ] **Step 2.5: Run the full suite + typecheck**

Run: `npm test && npm run typecheck`
Expected: all green.

- [ ] **Step 2.6: Commit**

```bash
git add benchmark/providers/claude-code.ts test/claude-code-provider.test.ts
git commit -m "feat(bench): ClaudeCodeProvider — headless claude -p with isolated cwd and MCP config"
```

---

### Task 3: Harness wiring — registry, CLI flag, proxy skip, report caveat

**Files:**
- Modify: `benchmark/providers/index.ts`
- Modify: `benchmark/config.ts`
- Modify: `benchmark/index.ts`
- Test: `test/config.test.ts` (extend — check existing patterns first; do NOT modify existing tests)

- [ ] **Step 3.1: Write the failing test**

Read `test/config.test.ts` to match its existing style for invoking `parseConfig`/CLI args (it exists — follow whatever export it tests). Append:

```ts
describe('claude-code provider flag', () => {
  it('--claude-code selects the provider with the sonnet default model', () => {
    const cfg = parseArgsToConfig(['--cas', '--quick', '--claude-code']);
    expect(cfg.provider).toBe('claude-code');
    expect(cfg.model).toBe('claude-sonnet-4-6');
  });

  it('--model overrides the default', () => {
    const cfg = parseArgsToConfig(['--cas', '--quick', '--claude-code', '--model', 'claude-haiku-4-5']);
    expect(cfg.model).toBe('claude-haiku-4-5');
  });
});
```

(`parseArgsToConfig` is a stand-in name — use the actual exported config-building function from `config.ts` exactly as the existing tests in `test/config.test.ts` do, including how they pass argv.)

- [ ] **Step 3.2: Run to verify failure**

Run: `npx vitest run test/config.test.ts --reporter=verbose`
Expected: the two new tests FAIL (unknown flag / wrong provider).

- [ ] **Step 3.3: Implement the wiring**

(a) `benchmark/providers/index.ts`:

```ts
import { ClaudeCodeProvider } from './claude-code.js';

export type ProviderName = 'anthropic' | 'zai' | 'openrouter' | 'local' | 'claude-code';
```

and in `createProvider` add a case (it needs the MCP server cmd — extend the signature with an optional param rather than importing config):

```ts
export function createProvider(
  provider: ProviderName,
  model: string,
  mcpServerCmd: string[] = []
): LLMProvider {
  switch (provider) {
    // ... existing cases unchanged ...
    case 'claude-code':
      return new ClaudeCodeProvider(model, mcpServerCmd);
```

Update the call site in `benchmark/index.ts` to pass `config.mcpServerCmd` as the third argument (harmless for other providers).

(b) `benchmark/config.ts`:
- In the default-models map (around line 32-35), add `'claude-code': 'claude-sonnet-4-6'`.
- In the provider-flag parsing block (around lines 142-156), add `--claude-code` as a shorthand (same pattern as `--zai`) and accept `claude-code` in the `--provider` validation list + error message.
- Update the usage comment block (`--provider anthropic|zai|openrouter`) to include `claude-code`.

(c) `benchmark/index.ts` — skip the harness MCP proxy for this provider. Replace the proxy creation block (around line 119-121):

```ts
  // ── Create MCP proxy ───────────────────────────────────────────
  // The claude-code provider lets the CLI spawn and talk to the MCP server
  // itself; the harness-side proxy is only for API providers.
  const useCliMcp = config.provider === 'claude-code';
  let proxy: Awaited<ReturnType<typeof createMCPProxy>> | null = null;
  if (!useCliMcp) {
    log('\nConnecting to MCP server…');
    proxy = await createMCPProxy(config.mcpServerCmd);
    log(`  Tools available: ${proxy.tools.length} (${proxy.tools.map((t) => t.name).join(', ')})`);
  } else {
    log('\nMCP server: attached by Claude Code CLI (--mcp-config), no harness proxy.');
  }
```

Then fix every downstream `proxy.` usage:
- The tool list passed to `runWithTools`: use `proxy?.tools ?? []`.
- The `callTool` callback passed to `runWithTools`: keep using the proxy when present; when `proxy` is null pass `async () => { throw new Error('callTool is unused with the claude-code provider'); }`.
- `toolCallMap` initialization: keep seeding from `proxy.tools` when present; ALSO make the per-record increment site tolerate unknown names (claude-code records arbitrary tool names like `Bash`). Find the increment with `grep -n "toolCallMap" benchmark/index.ts` and convert direct `.get(name)!`-style access to get-or-create:

```ts
  const entry = toolCallMap.get(tc.name) ?? { calls: 0, successes: 0 };
  entry.calls += 1;
  if (tc.success) entry.successes += 1;
  toolCallMap.set(tc.name, entry);
```

- `proxy.close()` at the end: `await proxy?.close();`.

(d) Report caveat. Find the markdown report builder with `grep -rn "Generated by axiom-mcp-benchmark\|## Summary" benchmark/` and, where the header/metadata lines are emitted, add:

```ts
  if (config.provider === 'claude-code') {
    lines.push(
      '> **Product scenario:** run through headless Claude Code CLI with built-in tools and web access enabled. ' +
        'Results measure the Claude Code + Axiom product experience, NOT bare-model capability (web search leakage possible).'
    );
  }
```

(Adapt the exact variable/line-array name to the report builder's local style; the sentence must appear near the top of the `.md` report.)

- [ ] **Step 3.4: Run tests — green**

Run: `npx vitest run test/config.test.ts --reporter=verbose && npm test && npm run typecheck && npm run lint`
Expected: all green.

- [ ] **Step 3.5: Commit**

```bash
git add benchmark/providers/index.ts benchmark/config.ts benchmark/index.ts test/config.test.ts
git commit -m "feat(bench): wire claude-code provider — flag, registry, proxy skip, product-scenario caveat"
```

---

### Task 4: Gated live smoke + validation evidence

**Files:**
- Modify: `test/claude-code-provider.test.ts` (append the gated describe)
- No other source changes.

- [ ] **Step 4.1: Append the gated live smoke tests**

```ts
import { ClaudeCodeProvider } from '../benchmark/providers/claude-code.js';

const SMOKE = process.env.CLAUDE_CODE_SMOKE === '1';

describe.skipIf(!SMOKE)('claude-code provider: live smoke (CLAUDE_CODE_SMOKE=1)', () => {
  const mcpCmd = ['tsx', '../src/cli.ts']; // matches parseMcpServerCmd default, resolved from benchmark/

  it('baseline answers a trivial problem', async () => {
    const p = new ClaudeCodeProvider('claude-haiku-4-5', mcpCmd);
    const r = await p.runBaseline('What is 2+2? Reply with just the number.', 4096);
    expect(r.text).toContain('4');
    expect(r.outputTokens).toBeGreaterThan(0);
  }, 300000);

  it('tool condition reaches the Axiom MCP server', async () => {
    const p = new ClaudeCodeProvider('claude-haiku-4-5', mcpCmd);
    const r = await p.runWithTools(
      'Use the axiom compute tool to find the derivative of x^3 with respect to x. Put the final answer in \\boxed{}.',
      [],
      async () => { throw new Error('unused'); },
      4096,
      8
    );
    expect(r.toolCalls.some((tc) => tc.name.startsWith('mcp__axiom__'))).toBe(true);
    expect(r.text).toContain('3');
  }, 300000);
});
```

IMPORTANT: the live smoke runs with cwd = the repo root when vitest runs, but `buildMcpConfig` resolves against `process.cwd()`. Vitest runs from the repo root, where `../src/cli.ts` would escape the repo. Fix the fixture: compute the cmd relative to the repo root instead:

```ts
const mcpCmd = ['tsx', 'src/cli.ts'];
```

(Verify `src/cli.ts` exists from the repo root — `ls src/cli.ts` — and that `node_modules/.bin/tsx` exists; adjust to the real MCP server entry if `parseMcpServerCmd`'s default points elsewhere. The non-smoke unit tests must stay green regardless.)

- [ ] **Step 4.2: Run WITHOUT the gate — skipped**

Run: `npx vitest run test/claude-code-provider.test.ts --reporter=verbose`
Expected: live describe shows as skipped; unit tests pass.

- [ ] **Step 4.3: Run WITH the gate — live round-trips**

Run: `CLAUDE_CODE_SMOKE=1 npx vitest run test/claude-code-provider.test.ts --reporter=verbose`
Expected: 6/6 pass (4 unit + 2 live). The tool-condition test proves: CLI starts, Axiom MCP attaches, `mcp__axiom__*` call recorded, parser maps telemetry. If the MCP attach fails, debug with a manual run:

```bash
cd $(mktemp -d) && claude -p "use the axiom compute tool to compute 2+2" \
  --model claude-haiku-4-5 --output-format stream-json --verbose \
  --dangerously-skip-permissions --setting-sources project --strict-mcp-config \
  --mcp-config '{"mcpServers":{"axiom":{"command":"<ABS>/node_modules/.bin/tsx","args":["<ABS>/src/cli.ts"]}}}' | tail -3
```

- [ ] **Step 4.4: Full gates + commit**

Run: `npm test && npm run typecheck && npm run lint`
Expected: all green (smoke skipped without the env var).

```bash
git add test/claude-code-provider.test.ts
git commit -m "test(bench): gated live smoke for the claude-code provider"
```

- [ ] **Step 4.5: Record the validation command for the user (no code)**

The end-to-end mini validation (run from `benchmark/`, ~5-10 min, uses the subscription):

```bash
npx tsx index.ts --cas --quick --claude-code --features=grader-v3
```

Report in the final summary that this is the user-facing command for the first product-scenario run, with `--model claude-haiku-4-5` / `claude-opus-4-8` as variants.
