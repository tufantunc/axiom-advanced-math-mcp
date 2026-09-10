# CI — install benchmark deps before typecheck (failure class 1)

Date: 2026-09-04
Branch: `fix/ci-benchmark-deps` (from `main` 2b1ca54)

## Problem

Every CI run on main since 2026-09-02 (13 consecutive) fails the static
job's typecheck step: `benchmark/providers/anthropic.ts` TS2307 (cannot
find `@anthropic-ai/sdk`), `openai-compat.ts` TS2307 (`openai`), plus
cascading TS7006. Root cause: `tsc -p tsconfig.test.json` transitively
typechecks benchmark code because ~10 unit tests import
`../benchmark/*.js`, and the provider SDKs are declared only in
benchmark's own package.json. CI runs `npm ci` at the root only.
Invisible locally because every worktree installed benchmark deps too;
reproduced by moving benchmark/node_modules away and re-running.

## Fix

In the static job, after the root `npm ci`:

- `run: npm ci` with `working-directory: benchmark` (its lockfile is
  tracked), with a comment explaining the transitive-typecheck chain and
  why the deps never reach the root lockfile (benchmark is a separate
  project per AGENTS.md).
- Extend setup-node's npm cache to both lockfiles via
  `cache-dependency-path: '**/package-lock.json'` so the new install is
  cached like the root one.

The test job needs no change: unit tests import benchmark modules at
runtime only through type-only edges (`import type` is erased), so the
SDKs never load — verified by running the suite with
benchmark/node_modules removed. The remaining CI failures (resource-
bound input-bounds/handler-seam tests on slower runners) are a separate
failure class, out of scope here.

## Verification

Local CI simulation (clean benchmark install → typecheck passes), the
runtime-import proof above, the five gates, then push and watch the
static job go green. Review: a single correctness pass over the YAML
(no mutation matrix — workflow-only change).
