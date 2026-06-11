# Claude Code CLI Provider — Product-Realistic Benchmark Scenario

**Date:** 2026-06-11
**Status:** DESIGN — approved, pending implementation plan

## Background

All benchmark runs so far drive models through direct APIs (openai-compat /
anthropic) with a hand-rolled agent loop. The next measurement target is the
**product-realistic scenario**: what does a developer gain by installing the
Axiom MCP server into Claude Code? That A/B is also the most persuasive demo
for the EdTech/copilot use cases, and running through the CLI bills against
the Max subscription instead of per-token API cost.

Decisions made during brainstorming:
- **Baseline = vanilla Claude Code** (built-in tools enabled, no Axiom). The
  honest product A/B — "what does installing Axiom add?"
- **Web stays ON in both conditions** (full vanilla). ⚠️ Reports from this
  provider must be labeled as a *product scenario*, not a capability
  measurement — MATH/GSM8K solutions are findable online, so search leakage
  can inflate scores in either condition.
- Approach A: spawn `claude -p` per problem and parse `--output-format
  stream-json` for full tool telemetry (option B's json-only output would
  lose the toolCalls records that the reports and regression diagnosis need;
  option C's Agent SDK adds a dependency for no benefit over CLI spawn).

## Goals

1. A `claude-code` provider that runs benchmark problems through headless
   Claude Code with zero changes to the grader/report layer.
2. Tool-augmented condition attaches the Axiom MCP server via the CLI's own
   MCP support; baseline runs vanilla.
3. Full tool telemetry: every tool call (built-in Bash AND `mcp__axiom__*`)
   recorded as `ToolCallRecord` — so reports show "vanilla reached for
   Bash/python N times vs Axiom condition chose compute M times", the core
   product-scenario insight.

**Non-goals:** sterile baseline (all tools off); disabling web; per-call
temperature/max_tokens control (the CLI owns these); parallel problem
execution; CI-run live tests.

## Component: `benchmark/providers/claude-code.ts`

`ClaudeCodeProvider implements LLMProvider` (`name: 'claude-code'`).

### Invocation (both conditions)

Per problem, spawn:

```
claude -p "<prompt>" --model <model> \
  --output-format stream-json --verbose \
  --dangerously-skip-permissions \
  --max-turns <maxAgentTurns>
```

- **cwd = empty temp directory** (created once per benchmark run): prevents
  the project's CLAUDE.md, memory, and repo files from leaking into context.
- **`--setting-sources project` + `--strict-mcp-config` in BOTH conditions**
  (probe-verified finding): without these, USER-level config leaks in —
  SessionStart hooks (superpowers, ~8.8K tokens), plugins, and the user's own
  MCP servers all load even in an empty cwd. With both flags the init event
  shows 0 mcp_servers, 0 plugins, no hook events, and auth still works. In
  the tool condition `--strict-mcp-config` additionally ensures ONLY our
  `--mcp-config` (Axiom) is attached.
- Existing prompt templates (incl. the boxed directive) are passed as the
  user prompt unchanged.
- `--dangerously-skip-permissions` is required for headless built-in tool
  use; inputs are our own math problems, so the risk is nil.
- `temperature` / `maxTokens` interface parameters are ignored (documented).
- `turns` comes from the final result event's `num_turns`; token usage from
  its `usage` field.

### Baseline (`runBaseline`)

No MCP config → vanilla Claude Code with its default toolset (Bash, file
tools, web). `BaselineResult` shape unchanged (no toolCalls field exists
there; built-in tool usage in baseline is visible in the console log only).

### Tool-augmented (`runWithTools`)

Adds `--mcp-config <tmpfile> --strict-mcp-config`. The temp MCP config JSON
is generated from the harness's existing `config.mcpServerCmd` (the CLI
spawns the Axiom server itself). The `tools` and `callTool` interface
parameters are deliberately ignored — the CLI owns the MCP connection — with
a doc-comment explaining why the contract still holds.

### Telemetry: stream-json parsing

A pure function `parseClaudeCodeStream(lines: string[])` (separately
exported for unit testing) walks the JSONL events:

- assistant events → collect text blocks; collect `tool_use` blocks
  (id, name, input).
- user events → match `tool_result` content to pending `tool_use` ids;
  produce `ToolCallRecord { name, args, result, success }`. ALL tools are
  recorded with their CLI names (`Bash`, `mcp__axiom__compute`, …).
- final `result` event → result text, `num_turns`, `usage`
  (input/output tokens), `is_error`.

## Harness integration

- `providers/index.ts`: `ProviderName` gains `'claude-code'`;
  `createProvider` returns `new ClaudeCodeProvider(model)` (no API key
  check — CLI handles auth via subscription/login).
- `config.ts`: `--claude-code` shorthand; default model
  `claude-sonnet-4-6` (overridable with `--model`).
- `index.ts`: when the provider is `claude-code`, the harness does NOT start
  its own MCP client; the tool definition list passed to `runWithTools` is
  empty.
- Report labeling: provider/model field renders as `claude-code/<model>`;
  the report header carries the product-scenario caveat (web enabled).

## Error handling

- Per-problem watchdog (default 10 min, env-overridable) → SIGKILL the child
  → throw; the existing `retry.ts` wrapper retries per its policy.
- Non-zero exit, unparseable stream, or `is_error: true` result → throw with
  the captured stderr/last events in the message.
- Temp dirs cleaned at process exit (best-effort).

## Testing strategy (TDD)

- **Unit:** `parseClaudeCodeStream` against fixture JSONL lines — text
  assembly, tool_use/tool_result pairing (incl. interleaved + multiple
  calls), usage extraction, `is_error` propagation, malformed-line tolerance.
- **Unit:** MCP-config generation from `mcpServerCmd`; CLI arg construction
  for both conditions (no `--mcp-config` in baseline; `--strict-mcp-config`
  present in tool condition).
- **Live smoke (gated):** one real `claude -p` round-trip per condition,
  enabled only when `CLAUDE_CODE_SMOKE=1` (skipped otherwise/CI).
- **Pre-run validation:** the plan includes a 3-5 problem mini-run command to
  verify end-to-end before a full quick set.

## Execution

Isolated git worktree (standing instruction), subagent-driven development,
merge back to main locally when green.
