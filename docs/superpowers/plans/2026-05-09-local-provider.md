# Local Model Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `local` provider to the benchmark system that supports LM Studio, Ollama, and any OpenAI-compatible local model runner via `LOCAL_BASE_URL` env var and `--local` CLI flag.

**Architecture:** New `providers/local.ts` factory reuses `OpenAICompatProvider`. Minimal changes to `providers/index.ts`, `config.ts`, `index.ts`, `.env.example`, and `AGENTS.md`.

**Tech Stack:** TypeScript (strict, ES2022, NodeNext), `openai` SDK (already a dependency), tsx for benchmark runtime.

---

## Spec sections covered

| Spec section | Tasks |
|---|---|
| New file `providers/local.ts` | Task 1 |
| `ProviderName` union + `createProvider` switch | Task 2 |
| CLI `--local` flag + model validation | Task 3 |
| `index.ts` validation + header comment | Task 4 |
| `.env.example` + `AGENTS.md` docs | Task 5 |

---

## File Structure

### New file (1)

| File | Responsibility |
|---|---|
| `benchmark/providers/local.ts` | Factory: reads `LOCAL_BASE_URL` + optional `LOCAL_API_KEY`, creates `OpenAICompatProvider` |

### Modified files (4)

| File | Change |
|---|---|
| `benchmark/providers/index.ts` | Add `local` to `ProviderName` union, import `createLocalProvider`, add switch case |
| `benchmark/config.ts` | Add `local: ''` to `DEFAULT_MODELS`, add `--local` flag parsing, add model-required validation |
| `benchmark/index.ts` | Update `requiredKey` map, update header comment |
| `benchmark/.env.example` | Add `LOCAL_BASE_URL` / `LOCAL_API_KEY` section |

### Doc files (1)

| File | Change |
|---|---|
| `AGENTS.md` | Add local model example to benchmark recipe section |

---

## Task 1: Create `providers/local.ts`

**Files:**
- Create: `benchmark/providers/local.ts`

- [ ] **Step 1: Create the local provider factory**

```typescript
import { OpenAICompatProvider } from './openai-compat.js';

export function createLocalProvider(model: string): OpenAICompatProvider {
  const baseURL = process.env.LOCAL_BASE_URL;
  if (!baseURL) throw new Error('LOCAL_BASE_URL environment variable is not set');

  const apiKey = process.env.LOCAL_API_KEY ?? 'not-needed';
  return new OpenAICompatProvider({ name: 'local', model, apiKey, baseURL });
}
```

- [ ] **Step 2: Commit**

```bash
git add benchmark/providers/local.ts
git commit -m "feat(benchmark): add local provider factory for LM Studio/Ollama"
```

---

## Task 2: Register `local` in provider index

**Files:**
- Modify: `benchmark/providers/index.ts`

- [ ] **Step 1: Update `providers/index.ts`**

Change the type, import, and switch case. The file currently reads:

```typescript
import type { LLMProvider } from './types.js';
import { AnthropicProvider } from './anthropic.js';
import { createZaiProvider } from './zai.js';
import { createOpenRouterProvider } from './openrouter.js';

export type ProviderName = 'anthropic' | 'zai' | 'openrouter';

export { type LLMProvider };

export function createProvider(provider: ProviderName, model: string): LLMProvider {
  switch (provider) {
    case 'anthropic': {
      const apiKey = process.env.ANTHROPIC_API_KEY;
      if (!apiKey) throw new Error('ANTHROPIC_API_KEY environment variable is not set');
      return new AnthropicProvider(model, apiKey);
    }
    case 'zai':
      return createZaiProvider(model);
    case 'openrouter':
      return createOpenRouterProvider(model);
    default:
      throw new Error(`Unknown provider: ${provider as string}`);
  }
}
```

Replace with:

```typescript
import type { LLMProvider } from './types.js';
import { AnthropicProvider } from './anthropic.js';
import { createZaiProvider } from './zai.js';
import { createOpenRouterProvider } from './openrouter.js';
import { createLocalProvider } from './local.js';

export type ProviderName = 'anthropic' | 'zai' | 'openrouter' | 'local';

export { type LLMProvider };

export function createProvider(provider: ProviderName, model: string): LLMProvider {
  switch (provider) {
    case 'anthropic': {
      const apiKey = process.env.ANTHROPIC_API_KEY;
      if (!apiKey) throw new Error('ANTHROPIC_API_KEY environment variable is not set');
      return new AnthropicProvider(model, apiKey);
    }
    case 'zai':
      return createZaiProvider(model);
    case 'openrouter':
      return createOpenRouterProvider(model);
    case 'local':
      return createLocalProvider(model);
    default:
      throw new Error(`Unknown provider: ${provider as string}`);
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add benchmark/providers/index.ts
git commit -m "feat(benchmark): register local provider in provider index"
```

---

## Task 3: Add `--local` CLI flag and model validation to `config.ts`

**Files:**
- Modify: `benchmark/config.ts`

- [ ] **Step 1: Update `DEFAULT_MODELS` map**

Find at line 33-37:

```typescript
const DEFAULT_MODELS: Record<ProviderName, string> = {
  anthropic: 'claude-sonnet-4-6',
  zai: 'glm-5.1',
  openrouter: 'meta-llama/llama-3.3-70b-instruct',
};
```

Replace with:

```typescript
const DEFAULT_MODELS: Record<ProviderName, string> = {
  anthropic: 'claude-sonnet-4-6',
  zai: 'glm-5.1',
  openrouter: 'meta-llama/llama-3.3-70b-instruct',
  local: '',
};
```

- [ ] **Step 2: Add `--local` shorthand and model validation**

Find the provider selection block (lines 141-153):

```typescript
  let provider: ProviderName = 'anthropic';
  if (args.includes('--zai')) {
    provider = 'zai';
  } else if (args.includes('--openrouter')) {
    provider = 'openrouter';
  } else {
    const providerIdx = args.indexOf('--provider');
    if (providerIdx !== -1) {
      const raw = args[providerIdx + 1];
      if (raw === 'anthropic' || raw === 'zai' || raw === 'openrouter') provider = raw;
      else throw new Error(`Unknown provider: "${raw}". Valid options: anthropic, zai, openrouter`);
    }
  }
```

Replace with:

```typescript
  let provider: ProviderName = 'anthropic';
  if (args.includes('--zai')) {
    provider = 'zai';
  } else if (args.includes('--openrouter')) {
    provider = 'openrouter';
  } else if (args.includes('--local')) {
    provider = 'local';
  } else {
    const providerIdx = args.indexOf('--provider');
    if (providerIdx !== -1) {
      const raw = args[providerIdx + 1];
      if (raw === 'anthropic' || raw === 'zai' || raw === 'openrouter' || raw === 'local') provider = raw;
      else throw new Error(`Unknown provider: "${raw}". Valid options: anthropic, zai, openrouter, local`);
    }
  }

  if (provider === 'local' && !args.includes('--model')) {
    throw new Error('--model <name> is required when using --local provider');
  }
```

- [ ] **Step 3: Commit**

```bash
git add benchmark/config.ts
git commit -m "feat(benchmark): add --local CLI flag and model validation"
```

---

## Task 4: Update `index.ts` validation and header comment

**Files:**
- Modify: `benchmark/index.ts`

- [ ] **Step 1: Update header comment**

Find lines 1-17:

```typescript
#!/usr/bin/env tsx
import 'dotenv/config';
/**
 * Axiom MCP Benchmark CLI
 *
 * Usage:
 *   tsx index.ts [--quick|--full|--gsm8k|--math|--olympiad|--cas]
 *                [--provider anthropic|zai|openrouter] [--model <name>]
 *                [--zai]         shorthand for --provider zai
 *                [--openrouter]  shorthand for --provider openrouter
 *
 * Examples:
 *   tsx index.ts --quick                                         Claude
 *   tsx index.ts --quick --zai                                   GLM
 *   tsx index.ts --cas --quick --zai                             CAS only
 *   tsx index.ts --quick --openrouter --model deepseek/deepseek-r1
 */
```

Replace with:

```typescript
#!/usr/bin/env tsx
import 'dotenv/config';
/**
 * Axiom MCP Benchmark CLI
 *
 * Usage:
 *   tsx index.ts [--quick|--full|--gsm8k|--math|--olympiad|--cas]
 *                [--provider anthropic|zai|openrouter|local] [--model <name>]
 *                [--zai]         shorthand for --provider zai
 *                [--openrouter]  shorthand for --provider openrouter
 *                [--local]       shorthand for --provider local (requires --model)
 *
 * Examples:
 *   tsx index.ts --quick                                         Claude
 *   tsx index.ts --quick --zai                                   GLM
 *   tsx index.ts --cas --quick --zai                             CAS only
 *   tsx index.ts --quick --openrouter --model deepseek/deepseek-r1
 *   LOCAL_BASE_URL=http://localhost:1234/v1 tsx index.ts --quick --local --model llama-3.2
 *   LOCAL_BASE_URL=http://localhost:11434/v1 tsx index.ts --quick --local --model llama3
 */
```

- [ ] **Step 2: Update `requiredKey` map**

Find lines 86-90:

```typescript
  const requiredKey: Record<string, string> = {
    anthropic: 'ANTHROPIC_API_KEY',
    zai: 'ZAI_API_KEY',
    openrouter: 'OPENROUTER_API_KEY',
  };
```

Replace with:

```typescript
  const requiredKey: Record<string, string> = {
    anthropic: 'ANTHROPIC_API_KEY',
    zai: 'ZAI_API_KEY',
    openrouter: 'OPENROUTER_API_KEY',
    local: 'LOCAL_BASE_URL',
  };
```

- [ ] **Step 3: Commit**

```bash
git add benchmark/index.ts
git commit -m "feat(benchmark): add local provider validation and usage docs"
```

---

## Task 5: Update `.env.example` and `AGENTS.md`

**Files:**
- Modify: `benchmark/.env.example`
- Modify: `AGENTS.md`

- [ ] **Step 1: Add local env vars to `.env.example`**

Append at end of file:

```

# ── Local models (LM Studio, Ollama, etc.) ─────────────
LOCAL_BASE_URL=http://localhost:1234/v1    # LM Studio default
# LOCAL_BASE_URL=http://localhost:11434/v1  # Ollama default
# LOCAL_API_KEY=not-needed                  # optional, rarely needed
```

- [ ] **Step 2: Add local model example to `AGENTS.md` benchmark recipe**

Find the benchmark recipe section in AGENTS.md (currently contains `cas:quick:zai`, `gsm8k:quick:zai`, `math:quick:zai` commands). After those lines, add:

```markdown
**Local models (LM Studio, Ollama):**

```bash
LOCAL_BASE_URL=http://localhost:1234/v1 npm run cas:quick:local   # won't exist as script; use directly:
LOCAL_BASE_URL=http://localhost:1234/v1 npx tsx index.ts --quick --local --model llama-3.2
```

Actually, since we decided not to add npm script shorthand, just add a note after the existing recipe:

Find the line containing `npm run math:quick:zai` and add after the recipe block:

```markdown

**Local models (LM Studio, Ollama, vLLM):**

Set `LOCAL_BASE_URL` in `.env` or inline, then run with `--local --model <name>`:

```bash
LOCAL_BASE_URL=http://localhost:1234/v1 tsx index.ts --quick --local --model llama-3.2    # LM Studio
LOCAL_BASE_URL=http://localhost:11434/v1 tsx index.ts --quick --local --model llama3      # Ollama
```
```

- [ ] **Step 3: Commit**

```bash
git add benchmark/.env.example AGENTS.md
git commit -m "docs: add local provider env vars and usage examples"
```

---

## Task 6: Typecheck and test

- [ ] **Step 1: Run typecheck from project root**

```bash
npm run typecheck
```

Expected: passes with no errors.

- [ ] **Step 2: Run tests from project root**

```bash
npm test
```

Expected: all tests pass (137 tests).

- [ ] **Step 3: Verify benchmark CLI help**

```bash
cd benchmark && LOCAL_BASE_URL=http://localhost:1234/v1 tsx index.ts --quick --local --model test-model 2>&1 | head -20
```

Expected: starts running (will fail on dataset load or connection — that's fine, we just want to verify CLI parsing and provider creation work).

- [ ] **Step 4: Final commit if any fixes needed**

```bash
git add -A && git commit -m "fix: address typecheck/test issues from local provider"
```
