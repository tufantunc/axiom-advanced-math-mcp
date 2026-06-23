# Differentiation Benchmark — Findings

## Purpose

A three-arm differentiation benchmark that compares how a single model
performs the same math problems under three tool regimes, each run through
headless Claude Code (`claude -p`):

- **pure-model** — no usable tools (model answers from its own reasoning).
- **code-exec** — built-in `Bash` only (model may shell out, e.g. to Python).
- **axiom** — the Axiom math MCP server only (model is meant to call the
  `mcp__axiom__*` tools).

The intent is to attribute accuracy differences to the backend each arm is
confined to.

## Finding 1 — flag: use `--tools`, not `--allowed-tools`

`--allowed-tools` is a **permission** list (auto-approve); it does **not**
restrict the set of tools available to the model. Proven live: the axiom arm
configured with `--allowed-tools mcp__axiom` still called `Bash`.

The **restriction** flag is `--tools <tools...>`. Proven live:
`--tools mcp__axiom` yields an init payload with `tools: []` (built-ins
suppressed) and the model cannot call `Bash`.

Fix applied: each arm's tool list now drives `--tools` (see
`arm-runner.ts` → `armCliArgs`, and the `tools?: string[]` option in
`buildCliArgs`, `benchmark/providers/claude-code.ts`).

## Finding 2 — claude-code MCP-timing artifact

`claude -p` does **not** block the first model turn on the MCP connection
completing. Even with a warm/instant HTTP Axiom server, the session init shows
`axiom: pending`, and the model answers solvable problems in turn 1 — before
the MCP tools are connected — without ever calling `mcp__axiom__*`.

Critically, **built-in `Bash` is available on turn 1, but MCP tools are not.**
This asymmetry means this Claude Code harness **cannot fairly compare the MCP
(axiom) arm against the code-exec (Bash) arm**: the Bash arm gets its tool
immediately while the axiom arm's tool arrives late (or after the answer is
already produced).

This is a **Claude Code client artifact, not a product flaw.** The hosted
Axiom product keeps the MCP connection warm/persistent for the duration of the
user's session, so the tool is available when the model wants it.

Consequence for the smoke test: the assertion "axiom arm calls `mcp__axiom__`"
cannot reliably hold and was removed. The smoke test now asserts only what is
true and reliable — that the `--tools mcp__axiom` restriction holds (the arm
**never** falls back to `Bash`) and the run completes ok.

## Finding 3 — strong models don't reach for the tool

Sonnet 4.6 does **not** call the math tool even when the server is warm and the
prompt explicitly says "you MUST use a tool" — it solves the problem directly.
The value of an external math tool concentrates on **weaker/cheaper models**
that cannot reliably do the symbolic work themselves.

## Recommendation

To measure **"Axiom vs no-tool"**, use the **original benchmark**
(`benchmark/index.ts`). It owns a persistent, warm MCP proxy and exercises the
tools correctly — proven: glm-5.1 on MATH Level 5 went **56% → 82% (+26pp)**
with Axiom attached.

Use this claude-code subsystem only for **built-in-tool arms** (code-exec) or
for future work once a warm/persistent MCP connection is available to the
`claude -p` path. It is not a fair venue for MCP-vs-builtin comparisons today.
