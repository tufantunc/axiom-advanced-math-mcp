# S3776 — decompose parseArgs (cli/parse.ts, complexity 73)

Date: 2026-09-04
Branch: `fix/s3776-cli-parse` (from `main` e10d256)

## Problem

`parseArgs` (src/cli/parse.ts:226) scores 73 against Sonar's threshold of
15: one function owns entry dispatch (server/help/version/unknown command,
help-before-`--`), a shared scan loop (`--` sentinel, positional, a
ten-case flag switch whose cases each nest kind-guards and validation), and
per-kind command assembly (plus plot's -q-requires-o rule).

## Design

Decomposition into naturally-bounded units, each targeting <15:

1. `parseArgs` keeps only the entry dispatch (empty→server, -h/-V, unknown
   command, help-before-sentinel) and delegates to a per-kind parser.
2. `parseComputeArgs` / `parseVerifyArgs` / `parsePlotArgs` each own a
   switch over ONLY their own flags — all seven `if (kind !== …) throw`
   guards disappear, and flag/kind drift becomes structurally impossible.
3. `classifyArg(sawDoubleDash, arg)` centralizes the sentinel/positional/
   flag decision; `takePositional(current, arg)` owns the extra-argument
   error. Shared mechanics stay DRY across the three parsers.
4. `FLAG_OWNER: Record<flag, kind>` consulted in each default case keeps
   every current "… is only valid for …" message byte-identical when a
   foreign flag is passed, and gives the flag/kind axis the same
   single-source-of-truth drift guard RANGE_FIELDS gives range flags.
5. Validation helpers (requireValue, parseNumber, DOMAINS/METHODS, the
   precision 1-50 window, plot's -q-requires-o rule) move with their
   parsers unchanged.

The exported surface (parseArgs signature, Command types, USAGE strings)
does not change. Behavior contract: identical Command output and identical
UsageError messages for every argv — pinned by test/cli-parse.test.ts and
the subprocess-level test/cli-contract.test.ts.

## Verification

Five gates; an old-vs-new equivalence harness comparing the parsed Command
(or thrown UsageError message) across a curated + fuzzed argv corpus; then
review-pro with the correctness reviewer first and the mutation tests
reviewer last and alone. One commit.
