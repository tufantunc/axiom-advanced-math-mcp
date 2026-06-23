# Differentiation Benchmark — Axiom vs SymPy MCP vs Code-Execution vs Pure Model

**Date:** 2026-06-23
**Status:** DESIGN — approved, pending implementation plan

## Background

The internal pitch (`docs/business/2026-06-internal-pitch.md`) has one critical
evidence gap: there is no *measured* answer to "why Axiom over the free SymPy MCP,
or over just letting the model run sympy in code execution?" The market research
established the category is crowded with free alternatives; the differentiation
must be **verification + LLM-ergonomics**, likely **not raw accuracy**. This
benchmark produces the data to prove (or honestly disprove) that wedge.

Decisions made during brainstorming:
- **Arms:** pure model (no tools), code-execution (bash/python), SymPy MCP, Axiom
  MCP. **Wolfram deferred** (needs API key; can be added as a later arm).
- **Driver:** the `claude-code` provider, **Sonnet 4.6, same model across all arms**
  — the comparison is "same model, different tool backend." Runs on subscription
  (no API token cost). claude-code can host any MCP via `--mcp-config`, and its
  vanilla bash is the code-execution arm.
- **Verify:** a dedicated true/false claim set with a verify-specific scorer — the
  strongest differentiation evidence.
- **Constraint:** must NOT break the existing benchmark (629 tests stay green).

## Goals

1. Side-by-side metrics across all four arms on the same problem instances, same
   model, same grader.
2. A dedicated verify task set measuring confirm-true / reject-false rates per arm.
3. A comparison artifact (markdown + JSON) ready to drop into the pitch.

**Non-goals:** Wolfram arm (deferred); changing the existing benchmark's behavior;
API-provider arms (all arms go through claude-code); statistical significance at
large N (quick-set sizes for cost — report N honestly).

## Architecture: additive subsystem

All new code lives under `benchmark/differentiation/` with its own entry script
`differentiation/run.ts`. The existing `index.ts` flow is untouched. Reuse by
**import**: dataset loaders (`loadCAS`, `loadMATH`), `grade()`, the claude-code
stream parser, and prompt templates.

**Non-breaking guarantee:** new directory + the existing 629-test suite stays green
unmodified. The one shared file that may change is the claude-code provider — see
below — and only via backward-compatible optional parameters.

### Arms

All four arms run through `claude-code` + Sonnet 4.6; only the tool surface changes.
Each arm restricts to its intended tool so accuracy is attributable to that backend:

| Arm | Tool surface (allow / deny) | MCP |
|---|---|---|
| `pure-model` | all tools disabled | none |
| `code-exec` | allow Bash only; deny MCP, web | none |
| `sympy` | allow `mcp__sympy__*` only; deny Bash, web | SymPy MCP |
| `axiom` | allow `mcp__axiom__*` only; deny Bash, web | Axiom MCP |

### claude-code provider extension (backward-compatible)

The provider's run path gains optional parameters: an explicit allowed/denied tool
list and which MCP config to attach (none / a given config path). Defaults preserve
the current behavior exactly (existing tests unaffected). The differentiation runner
passes per-arm tool restrictions. CLI flags: `--allowed-tools` / `--disallowed-tools`
(verify exact flag names against the installed CLI with a probe before relying on
them — same lesson as the prior arc; the implementation plan includes the probe).

## Measurement blocks

### Block 1 — Accuracy + efficiency

Run the existing CAS + MATH L4/L5 quick sets through each arm, graded by the existing
`grade()` (shared → fair). Per-arm metrics, all derivable from the claude-code stream
parser output already in hand:
- **Accuracy** per dataset.
- **Tool-call success rate.**
- **Avg turns** and **avg tokens** (LLM-ergonomics proxy — a cleaner tool needs fewer
  turns / less re-parsing).
- **Extraction-clean rate** — fraction of responses that produced a parseable
  `\boxed{}` answer (ergonomics proxy; derivable from the stored response).

### Block 2 — Dedicated verify set

A new dataset: a list of `{ claim, isTrue }` pairs spanning math domains (derivatives,
integrals, algebraic identities, eigenvalues, series), balanced true/false. Example:
`d/dx x^3 = 3x^2` → true; `d/dx x^3 = 2x^2` → false.

Each arm gets the SAME prompt ("verify this claim; answer TRUE or FALSE"). The backend
differs: the axiom arm uses `verify`, others use sympy/bash to check. A verify-specific
scorer extracts the stated verdict and scores against `isTrue`. Reported separately:
- **Confirm-true rate** (of true claims, how many correctly TRUE).
- **Reject-false rate** (of false claims, how many correctly FALSE) — the key
  discriminator; a backend without real verification tends to rubber-stamp TRUE.
- **Combined verify accuracy.**

The verify scorer is a pure function (true/false extraction from response text),
unit-tested independently.

## Comparison artifact

A `differentiation/compare.ts` aggregator reads each arm's result file and emits a
side-by-side markdown table (+ JSON) across every metric in both blocks. This is the
file that goes into the pitch.

## Fairness controls

Same model (Sonnet 4.6), same prompts, same grader, same problem instances, same
isolation (temp cwd + `--setting-sources project` + `--strict-mcp-config`), per-arm
tool restriction for clean attribution.

## SymPy MCP selection

Pick a concrete SymPy MCP server at implementation start via a probe:
- `codeprimate/math-mcp` (Node) — likely lighter setup, no Python env.
- `sdiehl/sympy-mcp` (Python) — closer to "pure SymPy".
The plan includes a probe step to confirm the server's real tool names/shapes and
generate its `--mcp-config`. Prefer the Node option if it covers the needed ops.

## Honest expectation (documented up front)

Likely outcome: raw accuracy roughly comparable across axiom / sympy / code-exec (all
can compute). Axiom's edges should appear in: verify (packaged verdict, esp.
reject-false), ergonomics (fewer turns / cleaner extraction from LLM-tuned output),
and reliability (tool-call success / no-hang). If code-execution matches Axiom on
accuracy AND verify, that is honest signal that the wedge is narrower than hoped —
better surfaced now than after launch.

## Testing strategy (TDD)

- **Unit:** verify-scorer (verdict extraction, true/false/ambiguous cases); arm-config
  generator (tool allow/deny lists per arm); comparison aggregator (reads N result
  files → correct side-by-side table).
- **Unit:** claude-code provider tool-restriction arg construction (allow/deny flags
  present per arm; defaults unchanged).
- **Probe (implementation start):** confirm CLI `--allowed-tools`/`--disallowed-tools`
  flag names; confirm chosen SymPy MCP tool names.
- **Live smoke (gated `CLAUDE_CODE_SMOKE=1`):** one problem per arm end-to-end; assert
  each arm's tool restriction holds (axiom arm calls `mcp__axiom__*` and not Bash).
- **Guardrail:** existing 629-test suite stays green unmodified.
- **Mini validation run:** a 3-5 problem matrix across all arms before the full run.

## Execution

Isolated git worktree (standing instruction), subagent-driven development, merge back
to main locally when green.
