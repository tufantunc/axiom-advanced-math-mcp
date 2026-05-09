# Local Model Provider — Design

**Date:** 2026-05-09
**Status:** Approved

## Goal

Add a `local` provider to the benchmark system so it can run against any OpenAI-compatible local model runner (LM Studio, Ollama, vLLM, etc.) by providing a base URL and model name via environment variables.

## Background

The benchmark system already has an `OpenAICompatProvider` that works with any OpenAI-compatible API. LM Studio (`localhost:1234/v1`) and Ollama (`localhost:11434/v1`) both expose OpenAI-compatible `/v1/chat/completions` endpoints. Adding a `local` provider requires minimal new code — it reuses the existing compat layer.

## Design

### 1. New file: `providers/local.ts`

Factory function that reads env vars and creates an `OpenAICompatProvider`:

- `LOCAL_BASE_URL` — **required**. The OpenAI-compatible base URL (e.g. `http://localhost:1234/v1` for LM Studio, `http://localhost:11434/v1` for Ollama).
- `LOCAL_API_KEY` — **optional**. Defaults to `"not-needed"` since local servers typically don't require authentication.

Provider name in reports: `"local"`.

### 2. Provider type expansion

- `ProviderName` union extended: `'anthropic' | 'zai' | 'openrouter' | 'local'`
- `DEFAULT_MODELS` map: `local` entry is `''` (empty string) — model must be provided via `--model` flag.
- `createProvider` switch gains a `local` case calling `createLocalProvider`.

### 3. CLI changes (`config.ts`)

- `--local` shorthand flag sets `provider = 'local'` (parallel to `--zai` and `--openrouter`).
- `--provider local` also works.
- Validation: when provider is `local`, `--model` must be provided; otherwise throw an error.

### 4. Validation changes (`index.ts`)

- `requiredKey` map: `local` maps to `'LOCAL_BASE_URL'` (base URL is the required env var, not an API key).
- Error message shown when `LOCAL_BASE_URL` is missing.

### 5. Documentation updates

- `.env.example`: new section for local models with LM Studio and Ollama default URLs.
- `index.ts` header comment: add `--local` flag and usage examples.
- `AGENTS.md`: add local model example to benchmark recipe section.

## Usage

```bash
# LM Studio
LOCAL_BASE_URL=http://localhost:1234/v1 tsx index.ts --quick --local --model llama-3.2

# Ollama
LOCAL_BASE_URL=http://localhost:11434/v1 tsx index.ts --quick --local --model llama3

# With .env file
tsx index.ts --cas --quick --local --model qwen2.5:7b
```

## Files changed

| File | Change |
|---|---|
| `benchmark/providers/local.ts` | **New** — factory function |
| `benchmark/providers/index.ts` | Add `local` to union, import, switch case |
| `benchmark/config.ts` | Add `local` to `DEFAULT_MODELS`, `--local` flag parsing, model validation |
| `benchmark/index.ts` | Update `requiredKey` map, update header comment |
| `benchmark/.env.example` | Add `LOCAL_BASE_URL` / `LOCAL_API_KEY` section |

## Out of scope

- npm script shorthand'leri (kullanıcı env var + `--local --model` ile çalıştırır).
- Auto-discovery of local model servers.
- Tool support validation (some local models may not support tool calling — this is the user's responsibility to verify).
