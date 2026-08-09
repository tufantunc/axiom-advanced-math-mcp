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

import { writeFile, mkdir } from 'fs/promises';
import path from 'path';
import { buildConfig } from './config.js';
import { collectProvenance } from './provenance.js';
import { createProvider } from './providers/index.js';
import { loadGSM8K } from './datasets/gsm8k.js';
import { loadMATH, activeMathLevels } from './datasets/math.js';
import { loadOmniMATH } from './datasets/omni-math.js';
import { loadCAS } from './datasets/cas-problems.js';
import { gradeNumeric, grade } from './graders/grader.js';
import { runBaseline } from './runners/baseline.js';
import type { BaselineResult } from './runners/baseline.js';
import { runToolAugmented } from './runners/tool-augmented.js';
import type { ToolAugmentedResult } from './runners/tool-augmented.js';
import { voteBaseline, voteToolAugmented } from './runners/self-consistency.js';
import type { SelfConsistencyData } from './runners/self-consistency.js';
import { createMCPProxy } from './runners/mcp-proxy.js';
import { generateReport } from './report/generator.js';
import type { ProblemDetail } from './problem-detail.js';
import { diagnoseRegression } from './problem-detail.js';
import type {
  BenchmarkReport,
  DatasetResult,
  ToolStats,
  CategoryResult,
} from './report/generator.js';

// ── Log buffer — captures all output for file persistence ──────────
const logLines: string[] = [];
let logPath: string | null = null;

/** Log to both console and buffer. */
function log(...args: unknown[]): void {
  const line = args.map((a) => (typeof a === 'string' ? a : String(a))).join(' ');
  logLines.push(line);
  console.log(...args);
}

/** Flush accumulated log buffer to disk. */
async function flushLog(): Promise<void> {
  if (!logPath) return;
  await writeFile(logPath, logLines.join('\n') + '\n');
}

async function main(): Promise<void> {
  const config = buildConfig();
  if (config.features.includes('output-hygiene')) process.env.AXIOM_COMPUTE_HYGIENE = '1';
  if (config.features.includes('grader-v3')) process.env.AXIOM_GRADER_V3 = '1';

  // ── Compute log path early so incremental flushes work ─────────
  const runDate = new Date().toISOString();
  const dateSlug = runDate.replace(/[T:]/g, '-').slice(0, 19);
  const logSlug = `${dateSlug}-${config.provider}-${config.mode}`;
  await mkdir(config.outputDir, { recursive: true });
  logPath = path.join(config.outputDir, `${logSlug}.log`);

  log(`\nAxiom MCP Benchmark`);
  log(`  Mode:     ${config.mode}`);
  log(`  Provider: ${config.provider}`);
  log(`  Model:    ${config.model}`);
  log(`  MCP:      ${config.mcpServerCmd.join(' ')}`);
  if (config.features.length > 0) log(`  Features: ${config.features.join(',')}`);
  if (config.selfConsistency) {
    log(`  Self-consistency: N=${config.selfConsistency.N}, temperature=${config.selfConsistency.temperature}`);
  }
  log('');

  // Validate required API keys
  const requiredKey: Record<string, string> = {
    anthropic: 'ANTHROPIC_API_KEY',
    zai: 'ZAI_API_KEY',
    openrouter: 'OPENROUTER_API_KEY',
    local: 'LOCAL_BASE_URL',
  };
  const keyName = requiredKey[config.provider];
  if (keyName && !process.env[keyName]) {
    console.error(`Error: ${keyName} environment variable is not set`);
    process.exit(1);
  }

  // ── Create LLM provider ────────────────────────────────────────
  const provider = createProvider(config.provider, config.model);

  // ── Load datasets ──────────────────────────────────────────────
  log('Loading datasets…');
  const mathSel = activeMathLevels(config.limits);
  const [gsm8kProblems, mathProblems, omniProblems] = await Promise.all([
    loadGSM8K(config.limits.gsm8k, config.cacheDir),
    loadMATH(mathSel.levels, mathSel.limitPerLevel, config.cacheDir),
    loadOmniMATH(config.limits.omniMath, config.cacheDir),
  ]);
  const casProblems = loadCAS(config.limits.cas);

  log(
    `  GSM8K: ${gsm8kProblems.length}, MATH L3-5: ${mathProblems.length}, Omni-MATH: ${omniProblems.length}, CAS: ${casProblems.length}`
  );

  // ── Create MCP proxy ───────────────────────────────────────────
  log('\nConnecting to MCP server…');
  const proxy = await createMCPProxy(config.mcpServerCmd);
  log(`  Tools available: ${proxy.tools.length} (${proxy.tools.map((t) => t.name).join(', ')})`);

  // ── Tool usage tracking ────────────────────────────────────────
  const toolCallMap = new Map<string, { calls: number; successes: number }>();
  for (const tool of proxy.tools) {
    toolCallMap.set(tool.name, { calls: 0, successes: 0 });
  }

  // ── Run benchmarks ─────────────────────────────────────────────
  const datasets: DatasetResult[] = [];
  const allDetails: ProblemDetail[] = [];
  const mathCategoryMap = new Map<string, { total: number; baselineOk: number; toolOk: number }>();
  let totalBaselineTokens = 0;
  let totalToolTokens = 0;
  let totalDurationMs = 0;

  async function runDataset<P extends { question?: string; problem?: string }>(
    problems: P[],
    datasetName: string,
    getAnswer: (p: P) => string | number,
    getText: (p: P) => string,
    category?: (p: P) => string
  ): Promise<void> {
    if (problems.length === 0) return;

    log(`\nRunning ${datasetName} (${problems.length} problems)…`);
    let baselineCorrect = 0;
    let toolCorrect = 0;

    for (let i = 0; i < problems.length; i++) {
      const p = problems[i];

      const problemText = getText(p);
      const groundTruth = getAnswer(p);
      const groundTruthStr = String(groundTruth);

      // ── Baseline ─────────────────────────────────────────
      let baselineOk = false;
      let baselineExtracted = '';
      let baselineMethod = '';
      let baselineError: string | undefined;
      let br: (BaselineResult & { selfConsistency?: SelfConsistencyData }) | undefined;
      try {
        br = config.selfConsistency
          ? await voteBaseline(
              problemText,
              provider,
              config.selfConsistency.N,
              config.selfConsistency.temperature,
              config.maxTokens,
              config.retryOptions
            )
          : await runBaseline(problemText, provider, config.maxTokens, config.retryOptions);
        totalBaselineTokens += br.inputTokens + br.outputTokens;
        totalDurationMs += br.durationMs;

        const result =
          typeof groundTruth === 'number'
            ? gradeNumeric(br.text, groundTruth)
            : await grade(br.text, groundTruthStr);
        baselineOk = result.correct;
        baselineExtracted = result.predicted;
        baselineMethod = result.method;
        if (baselineOk) baselineCorrect++;
      } catch (err) {
        baselineError = err instanceof Error ? err.message : String(err);
      }

      // ── Tool-augmented ───────────────────────────────────
      let toolOk = false;
      let toolExtracted = '';
      let toolMethod = '';
      let toolError: string | undefined;
      let toolCalls: ProblemDetail['toolAugmented']['toolCalls'] = [];
      let turns = 0;
      let tr: (ToolAugmentedResult & { selfConsistency?: SelfConsistencyData }) | undefined;
      try {
        tr = config.selfConsistency
          ? await voteToolAugmented(
              problemText,
              provider,
              proxy,
              config.selfConsistency.N,
              config.selfConsistency.temperature,
              config.maxTokens,
              config.maxAgentTurns,
              config.retryOptions
            )
          : await runToolAugmented(
              problemText,
              provider,
              proxy,
              config.maxTokens,
              config.maxAgentTurns,
              config.retryOptions
            );
        totalToolTokens += tr.inputTokens + tr.outputTokens;
        totalDurationMs += tr.durationMs;
        toolCalls = tr.toolCalls;
        turns = tr.turns;

        for (const call of tr.toolCalls) {
          const stats = toolCallMap.get(call.name) ?? { calls: 0, successes: 0 };
          stats.calls++;
          if (call.success) stats.successes++;
          toolCallMap.set(call.name, stats);
        }

        const result =
          typeof groundTruth === 'number'
            ? gradeNumeric(tr.text, groundTruth)
            : await grade(tr.text, groundTruthStr);
        toolOk = result.correct;
        toolExtracted = result.predicted;
        toolMethod = result.method;
        if (toolOk) toolCorrect++;
      } catch (err) {
        toolError = err instanceof Error ? err.message : String(err);
      }

      // ── Collect detail ───────────────────────────────────
      const detail: ProblemDetail = {
        dataset: datasetName,
        index: i,
        question: problemText,
        groundTruth: groundTruthStr,
        baseline: {
          extractedAnswer: baselineExtracted,
          correct: baselineOk,
          method: baselineMethod,
          error: baselineError,
          response: br?.text,
          ...(br && 'selfConsistency' in br && br.selfConsistency ? { selfConsistency: br.selfConsistency } : {}),
        },
        toolAugmented: {
          extractedAnswer: toolExtracted,
          correct: toolOk,
          method: toolMethod,
          toolCalls,
          turns,
          error: toolError,
          response: tr?.text,
          ...(tr && 'selfConsistency' in tr && tr.selfConsistency ? { selfConsistency: tr.selfConsistency } : {}),
        },
        regression: baselineOk && !toolOk,
        improvement: !baselineOk && toolOk,
      };
      allDetails.push(detail);

      // ── Per-problem log (always) ─────────────────────────
      const bMark = baselineOk ? '✓' : '✗';
      const tMark = toolOk ? '✓' : '✗';
      let tag = '    ';
      if (detail.regression) tag = 'REG ';
      else if (detail.improvement) tag = 'IMP ';

      const toolsSummary =
        toolCalls.length > 0
          ? toolCalls.map((tc) => `${tc.name}→${tc.success ? '✓' : '✗'}`).join(', ')
          : 'no tools';

      log(
        `  #${String(i).padStart(3)} ${tag} ${bMark}→${tMark}  expected: ${groundTruthStr.slice(0, 20).padEnd(20)} | base: ${baselineExtracted.slice(0, 15).padEnd(15)} | tool: ${toolExtracted.slice(0, 15).padEnd(15)} | ${toolsSummary}`
      );

      // Print regression tool details
      if (detail.regression && toolCalls.length > 0) {
        for (const tc of toolCalls) {
          const argsStr = JSON.stringify(tc.args).slice(0, 80);
          const resStr = tc.result.slice(0, 60);
          log(`         ↳ ${tc.name}(${argsStr}) → ${resStr}`);
        }
      }

      await flushLog();

      // Category tracking
      if (category) {
        const cat = category(p);
        const existing = mathCategoryMap.get(cat) ?? { total: 0, baselineOk: 0, toolOk: 0 };
        existing.total++;
        if (baselineOk) existing.baselineOk++;
        if (toolOk) existing.toolOk++;
        mathCategoryMap.set(cat, existing);
      }
    }

    const n = problems.length;
    const regressionCount = allDetails.filter(
      (d) => d.dataset === datasetName && d.regression
    ).length;
    const improvementCount = allDetails.filter(
      (d) => d.dataset === datasetName && d.improvement
    ).length;

    datasets.push({
      name: datasetName,
      total: n,
      baselineCorrect,
      toolCorrect,
      baselineAccuracy: baselineCorrect / n,
      toolAccuracy: toolCorrect / n,
      delta: (toolCorrect - baselineCorrect) / n,
    });

    log(`  Baseline: ${baselineCorrect}/${n} (${((baselineCorrect / n) * 100).toFixed(1)}%)`);
    log(`  +MCP:     ${toolCorrect}/${n} (${((toolCorrect / n) * 100).toFixed(1)}%)`);
    log(
      `  Delta:    ${toolCorrect - baselineCorrect >= 0 ? '+' : ''}${toolCorrect - baselineCorrect} (${(((toolCorrect - baselineCorrect) / n) * 100).toFixed(1)}%)`
    );
    log(`  Regressions: ${regressionCount}, Improvements: ${improvementCount}`);

    await flushLog();
  }

  // GSM8K
  await runDataset(
    gsm8kProblems,
    `GSM8K (${gsm8kProblems.length})`,
    (p) => p.numericAnswer,
    (p) => p.question
  );

  // MATH by level
  const mathL3 = mathProblems.filter((p) => p.level === 3);
  const mathL4 = mathProblems.filter((p) => p.level === 4);
  const mathL5 = mathProblems.filter((p) => p.level === 5);

  await runDataset(
    mathL3,
    `MATH L3 (${mathL3.length})`,
    (p) => p.answer,
    (p) => p.problem,
    (p) => p.type
  );
  await runDataset(
    mathL4,
    `MATH L4 (${mathL4.length})`,
    (p) => p.answer,
    (p) => p.problem,
    (p) => p.type
  );
  await runDataset(
    mathL5,
    `MATH L5 (${mathL5.length})`,
    (p) => p.answer,
    (p) => p.problem,
    (p) => p.type
  );

  // Omni-MATH
  await runDataset(
    omniProblems,
    `Omni-MATH ≥7 (${omniProblems.length})`,
    (p) => p.answer,
    (p) => p.problem
  );

  // CAS
  await runDataset(
    casProblems,
    `CAS (${casProblems.length})`,
    (p) => p.answer,
    (p) => p.problem,
    (p) => p.category
  );

  // ── Close MCP proxy ────────────────────────────────────────────
  await proxy.close();

  // ── Build tool stats ───────────────────────────────────────────
  const toolStats: ToolStats[] = [];
  for (const [name, stats] of toolCallMap.entries()) {
    if (stats.calls > 0) {
      toolStats.push({
        name,
        calls: stats.calls,
        successes: stats.successes,
        successRate: stats.successes / stats.calls,
      });
    }
  }

  // ── Build category results ─────────────────────────────────────
  const mathCategories: CategoryResult[] = [];
  for (const [cat, stats] of mathCategoryMap.entries()) {
    mathCategories.push({
      category: cat,
      total: stats.total,
      baselineCorrect: stats.baselineOk,
      toolCorrect: stats.toolOk,
      baselineAccuracy: stats.baselineOk / stats.total,
      toolAccuracy: stats.toolOk / stats.total,
      delta: (stats.toolOk - stats.baselineOk) / stats.total,
    });
  }

  // ── Generate report ────────────────────────────────────────────
  const totalProblems = datasets.reduce((s, d) => s + d.total, 0);
  const report: BenchmarkReport = {
    date: runDate,
    model: `${config.provider}/${config.model}`,
    mode: config.mode,
    provenance: collectProvenance(config.features, config.selfConsistency),
    totalProblems,
    datasets,
    toolStats,
    mathCategories,
    problemDetails: allDetails,
    totalBaselineTokens,
    totalToolTokens,
    totalDurationMs,
  };

  const { jsonPath, mdPath, detailPath } = await generateReport(report, config);

  // ── Regression summary (always show) ───────────────────────────
  const totalReg = allDetails.filter((d) => d.regression).length;
  const totalImp = allDetails.filter((d) => d.improvement).length;
  if (totalReg > 0) {
    log('\n── Regression Diagnosis ─────────────────────────────────');
    const causes = new Map<string, number>();
    for (const d of allDetails.filter((d) => d.regression)) {
      const cause = diagnoseRegression(d);
      causes.set(cause, (causes.get(cause) ?? 0) + 1);
    }
    for (const [cause, count] of [...causes.entries()].sort((a, b) => b[1] - a[1])) {
      log(`  ${cause}: ${count}`);
    }
  }

  log('\n── Results ──────────────────────────────────────────────');
  for (const d of datasets) {
    log(
      `  ${d.name}: Baseline ${(d.baselineAccuracy * 100).toFixed(1)}% → +MCP ${(d.toolAccuracy * 100).toFixed(1)}% (${d.delta >= 0 ? '+' : ''}${(d.delta * 100).toFixed(1)}%)`
    );
  }
  log(
    `  Regressions: ${totalReg}, Improvements: ${totalImp}, Net: ${totalImp - totalReg >= 0 ? '+' : ''}${totalImp - totalReg}`
  );

  log('');
  log(`Report saved to:`);
  log(`  ${mdPath}`);
  log(`  ${jsonPath}`);
  log(`  ${detailPath}  (per-problem JSONL)`);
  log(`  ${logPath}  (console log)`);
  log('');

  // Final flush
  await flushLog();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
