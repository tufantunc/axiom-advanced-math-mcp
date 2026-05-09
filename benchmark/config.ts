import type { ProviderName } from './providers/index.js';
import { DEFAULT_RETRY_OPTIONS } from './providers/retry.js';
import type { RetryOptions } from './providers/retry.js';

export type { ProviderName };
export type { RetryOptions };

export interface DatasetLimits {
  gsm8k: number;
  mathLevel3: number;
  mathLevel4: number;
  mathLevel5: number;
  omniMath: number;
  cas: number;
}

export interface BenchmarkConfig {
  mode: string;
  provider: ProviderName;
  model: string;
  maxTokens: number;
  maxAgentTurns: number;
  limits: DatasetLimits;
  mcpServerCmd: string[];
  outputDir: string;
  cacheDir: string;
  retryOptions: RetryOptions;
  features: string[];
  selfConsistency: { N: number; temperature: number } | null;
}

// Default models per provider
const DEFAULT_MODELS: Record<ProviderName, string> = {
  anthropic: 'claude-sonnet-4-6',
  zai: 'glm-5.1',
  openrouter: 'meta-llama/llama-3.3-70b-instruct',
  local: '',
};

// Sample sizes per size mode
const QUICK_SIZES: DatasetLimits = {
  gsm8k: 100,
  mathLevel3: 50,
  mathLevel4: 50,
  mathLevel5: 50,
  omniMath: 50,
  cas: 60,
};

const FULL_SIZES: DatasetLimits = {
  gsm8k: 1319,
  mathLevel3: 635,
  mathLevel4: 635,
  mathLevel5: 635,
  omniMath: 400,
  cas: 240,
};

function parseMcpServerCmd(): string[] {
  const envCmd = process.env.MCP_SERVER_CMD;
  if (envCmd) {
    return envCmd.trim().split(/\s+/);
  }
  // Default: look for cli.ts relative to benchmark dir
  return ['tsx', '../src/cli.ts'];
}

/**
 * Parse CLI arguments and build config.
 *
 * Size flags (mutually exclusive, default --quick):
 *   --quick              small sample sizes for fast iteration
 *   --full               full dataset sizes
 *
 * Dataset flags (combinable, default = all datasets):
 *   --gsm8k              run GSM8K only
 *   --math               run MATH L3-5 only
 *   --olympiad           run Omni-MATH only
 *   --cas                run CAS problems only
 *
 * Can be combined: --gsm8k --quick  →  GSM8K with quick sample size
 *
 * Provider / model flags:
 *   --provider anthropic|zai|openrouter
 *   --zai                shorthand for --provider zai
 *   --openrouter         shorthand for --provider openrouter
 *   --model <name>       model override
 */
export function buildConfig(): BenchmarkConfig {
  const args = process.argv.slice(2);

  // --- Size mode --------------------------------------------------------
  // --full uses full dataset sizes; otherwise default to quick
  const isQuickSize = !args.includes('--full');
  const sizes = isQuickSize ? QUICK_SIZES : FULL_SIZES;

  // --- Dataset selection ------------------------------------------------
  const hasDatasetFlag =
    args.includes('--gsm8k') ||
    args.includes('--math') ||
    args.includes('--math-l3') ||
    args.includes('--math-l4') ||
    args.includes('--math-l5') ||
    args.includes('--olympiad') ||
    args.includes('--cas');

  const runGsm8k = !hasDatasetFlag || args.includes('--gsm8k');
  const runMathAll = !hasDatasetFlag || args.includes('--math');
  const runL3 = runMathAll || args.includes('--math-l3');
  const runL4 = runMathAll || args.includes('--math-l4');
  const runL5 = runMathAll || args.includes('--math-l5');
  const runOlympiad = !hasDatasetFlag || args.includes('--olympiad');
  const runCas = !hasDatasetFlag || args.includes('--cas');

  const limits: DatasetLimits = {
    gsm8k: runGsm8k ? sizes.gsm8k : 0,
    mathLevel3: runL3 ? sizes.mathLevel3 : 0,
    mathLevel4: runL4 ? sizes.mathLevel4 : 0,
    mathLevel5: runL5 ? sizes.mathLevel5 : 0,
    omniMath: runOlympiad ? sizes.omniMath : 0,
    cas: runCas ? sizes.cas : 0,
  };

  // --- Mode label (used in output filenames) ----------------------------
  let mode: string;
  if (!hasDatasetFlag) {
    mode = isQuickSize ? 'quick' : 'full';
  } else {
    const parts: string[] = [];
    if (args.includes('--gsm8k')) parts.push('gsm8k');
    if (args.includes('--math')) parts.push('math');
    if (args.includes('--math-l3')) parts.push('math-l3');
    if (args.includes('--math-l4')) parts.push('math-l4');
    if (args.includes('--math-l5')) parts.push('math-l5');
    if (args.includes('--olympiad')) parts.push('olympiad');
    if (args.includes('--cas')) parts.push('cas');
    if (isQuickSize) parts.push('quick');
    mode = parts.join('-');
  }

  // --- Provider ---------------------------------------------------------
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

  // --- Model (explicit --model overrides the default) -------------------
  let model = DEFAULT_MODELS[provider];
  const modelIdx = args.indexOf('--model');
  if (modelIdx !== -1 && args[modelIdx + 1]) {
    model = args[modelIdx + 1];
  }

  // --- Features --------------------------------------------------------
  // --features=v2,foo,bar — comma-separated feature flags (e.g., enables grader-v2)
  let features: string[] = [];
  const featuresArg = args.find((a) => a.startsWith('--features='));
  if (featuresArg) features = featuresArg.slice('--features='.length).split(',').filter(Boolean);

  // --- Self-consistency ----------------------------------------------------
  // Activated by --features=self-consistency.
  // N defaults to 3, temperature to 0.7. Both can be overridden via
  // AXIOM_SC_N and AXIOM_SC_TEMP env vars (useful for ablation).
  let selfConsistency: { N: number; temperature: number } | null = null;
  if (features.includes('self-consistency')) {
    const nRaw = process.env.AXIOM_SC_N;
    const tRaw = process.env.AXIOM_SC_TEMP;
    const N = nRaw ? parseInt(nRaw, 10) : 3;
    const temperature = tRaw ? parseFloat(tRaw) : 0.7;
    if (Number.isFinite(N) && N >= 1 && Number.isFinite(temperature) && temperature >= 0) {
      selfConsistency = { N, temperature };
    } else {
      throw new Error(
        `Invalid self-consistency config: N=${nRaw}, temperature=${tRaw}`
      );
    }
  }

  return {
    mode,
    provider,
    model,
    maxTokens: 4096,
    maxAgentTurns: 8,
    limits,
    mcpServerCmd: parseMcpServerCmd(),
    outputDir: './results',
    cacheDir: './cache',
    retryOptions: DEFAULT_RETRY_OPTIONS,
    features,
    selfConsistency,
  };
}
