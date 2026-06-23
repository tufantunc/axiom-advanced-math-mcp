import { writeFile, mkdir } from 'fs/promises';
import path from 'path';
import type { BenchmarkConfig } from '../config.js';
import type { ProblemDetail } from '../problem-detail.js';
import { diagnoseRegression, type RegressionCause } from '../problem-detail.js';

export interface DatasetResult {
  name: string;
  total: number;
  baselineCorrect: number;
  toolCorrect: number;
  baselineAccuracy: number;
  toolAccuracy: number;
  delta: number;
}

export interface ToolStats {
  name: string;
  calls: number;
  successes: number;
  successRate: number;
}

export interface CategoryResult {
  category: string;
  total: number;
  baselineCorrect: number;
  toolCorrect: number;
  baselineAccuracy: number;
  toolAccuracy: number;
  delta: number;
}

export interface BenchmarkReport {
  date: string;
  model: string;
  mode: string;
  totalProblems: number;
  datasets: DatasetResult[];
  toolStats: ToolStats[];
  mathCategories: CategoryResult[];
  problemDetails: ProblemDetail[];
  totalBaselineTokens: number;
  totalToolTokens: number;
  totalDurationMs: number;
}

export async function generateReport(
  report: BenchmarkReport,
  config: BenchmarkConfig,
): Promise<{ jsonPath: string; mdPath: string; detailPath: string }> {
  await mkdir(config.outputDir, { recursive: true });

  const dateSlug = report.date.replace(/[T:]/g, '-').slice(0, 19);
  const slug = `${dateSlug}-${config.provider}-${config.mode}`;
  const jsonPath = path.join(config.outputDir, `${slug}.json`);
  const mdPath = path.join(config.outputDir, `${slug}.md`);
  const detailPath = path.join(config.outputDir, `${slug}-details.jsonl`);

  // Write main report (without bulky problemDetails)
  const { problemDetails, ...reportSummary } = report;
  await writeFile(jsonPath, JSON.stringify(reportSummary, null, 2));
  await writeFile(mdPath, renderMarkdown(report));

  // Write per-problem JSONL for deep debugging
  const jsonl = problemDetails.map(d => JSON.stringify(d)).join('\n') + '\n';
  await writeFile(detailPath, jsonl);

  return { jsonPath, mdPath, detailPath };
}

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

function delta(d: number): string {
  return `${d >= 0 ? '+' : ''}${(d * 100).toFixed(1)}%`;
}

function renderMarkdown(r: BenchmarkReport): string {
  const lines: string[] = [];

  lines.push('# Axiom MCP Benchmark Results');
  lines.push('');
  lines.push(
    `**Date:** ${r.date.slice(0, 10)} | **Model:** ${r.model} | **Mode:** ${r.mode} (${r.totalProblems} problems)`,
  );
  lines.push('');

  // Summary table
  lines.push('## Summary');
  lines.push('');
  lines.push('| Dataset | N | Baseline | +MCP | Delta |');
  lines.push('|---------|---|----------|------|-------|');
  for (const d of r.datasets) {
    lines.push(
      `| ${d.name} | ${d.total} | ${pct(d.baselineAccuracy)} | ${pct(d.toolAccuracy)} | **${delta(d.delta)}** |`,
    );
  }
  lines.push('');

  // Tool usage
  if (r.toolStats.length > 0) {
    lines.push('## Tool Usage (tool-augmented condition)');
    lines.push('');
    lines.push('| Tool | Calls | Success Rate |');
    lines.push('|------|-------|-------------|');
    for (const t of r.toolStats.sort((a, b) => b.calls - a.calls)) {
      lines.push(`| ${t.name} | ${t.calls} | ${pct(t.successRate)} |`);
    }
    lines.push('');
  }

  // MATH category breakdown
  if (r.mathCategories.length > 0) {
    lines.push('## MATH Category Breakdown');
    lines.push('');
    lines.push('| Category | N | Baseline | +MCP | Delta |');
    lines.push('|----------|---|----------|------|-------|');
    for (const c of r.mathCategories.sort((a, b) => b.delta - a.delta)) {
      lines.push(
        `| ${c.category} | ${c.total} | ${pct(c.baselineAccuracy)} | ${pct(c.toolAccuracy)} | **${delta(c.delta)}** |`,
      );
    }
    lines.push('');
  }

  // Self-consistency aggregate (only when at least one record has it)
  const scTool: { agreement: number; N: number; temperature: number }[] = [];
  const scBaseline: { agreement: number }[] = [];
  for (const d of r.problemDetails) {
    if (d.toolAugmented.selfConsistency) {
      scTool.push({
        agreement: d.toolAugmented.selfConsistency.agreement,
        N: d.toolAugmented.selfConsistency.N,
        temperature: d.toolAugmented.selfConsistency.temperature,
      });
    }
    if (d.baseline.selfConsistency) {
      scBaseline.push({ agreement: d.baseline.selfConsistency.agreement });
    }
  }

  if (scTool.length > 0) {
    const N = scTool[0].N;
    const temperature = scTool[0].temperature;
    const avgToolAg =
      scTool.reduce((s, r) => s + r.agreement, 0) / scTool.length;
    const avgBaseAg = scBaseline.length
      ? scBaseline.reduce((s, r) => s + r.agreement, 0) / scBaseline.length
      : null;

    // Distribution buckets (only for the tool-augmented condition)
    const unanimous = scTool.filter((r) => r.agreement >= 0.99).length;
    const strongMaj = scTool.filter((r) => r.agreement >= 0.6 && r.agreement < 0.99).length;
    const allDiff = scTool.filter((r) => r.agreement < 0.4).length;

    lines.push('');
    lines.push('## Self-Consistency');
    lines.push('');
    lines.push(`- Configuration: N=${N}, temperature=${temperature}`);
    lines.push(
      `- Average agreement (tool-augmented): ${avgToolAg.toFixed(3)} (n=${scTool.length} problems)`
    );
    if (avgBaseAg !== null) {
      lines.push(
        `- Average agreement (baseline): ${avgBaseAg.toFixed(3)} (n=${scBaseline.length} problems)`
      );
    }
    lines.push('- Tool-augmented agreement distribution:');
    lines.push(`  - Unanimous (all ${N} agree): ${unanimous}`);
    lines.push(`  - Strong majority (≥60% agree): ${strongMaj}`);
    lines.push(`  - All-different / weak (<40%): ${allDiff}`);
    lines.push('');
  }

  // Regression analysis
  const regressions = r.problemDetails.filter(d => d.regression);
  const improvements = r.problemDetails.filter(d => d.improvement);

  if (regressions.length > 0 || improvements.length > 0) {
    lines.push('## Regression Analysis');
    lines.push('');
    lines.push(`- **Regressions** (baseline ✓ → tool ✗): **${regressions.length}**`);
    lines.push(`- **Improvements** (baseline ✗ → tool ✓): **${improvements.length}**`);
    lines.push(`- Net effect: ${improvements.length - regressions.length >= 0 ? '+' : ''}${improvements.length - regressions.length}`);
    lines.push('');

    if (regressions.length > 0) {
      // Diagnose cause breakdown
      const causes = new Map<RegressionCause, number>();
      for (const d of regressions) {
        const cause = diagnoseRegression(d);
        causes.set(cause, (causes.get(cause) ?? 0) + 1);
      }

      const causeLabels: Record<RegressionCause, string> = {
        tool_error: 'Tool call failed/errored',
        wrong_tool_result: 'Tool succeeded but gave wrong answer',
        no_tools_used: 'Model used no tools (performed worse alone)',
        extraction_mismatch: 'Tool had correct answer but grader missed it',
        wrong_formula: 'Model sent wrong formula to tool',
        wrong_tool_selected: 'Model selected wrong tool',
      };

      lines.push('### Regression Causes');
      lines.push('');
      lines.push('| Cause | Count | % |');
      lines.push('|-------|-------|---|');
      for (const [cause, count] of [...causes.entries()].sort((a, b) => b[1] - a[1])) {
        lines.push(
          `| ${causeLabels[cause]} | ${count} | ${((count / regressions.length) * 100).toFixed(0)}% |`,
        );
      }
      lines.push('');

      // Show top 10 regressions with details
      lines.push('### Sample Regressions (up to 10)');
      lines.push('');
      for (const d of regressions.slice(0, 10)) {
        const q = d.question.length > 80 ? d.question.slice(0, 80) + '…' : d.question;
        const cause = diagnoseRegression(d);
        const toolSummary =
          d.toolAugmented.toolCalls.length > 0
            ? d.toolAugmented.toolCalls
                .map(tc => `\`${tc.name}\`→${tc.success ? '✓' : '✗'}`)
                .join(', ')
            : '_no tools called_';

        lines.push(`**#${d.index}** [${d.dataset}] — ${causeLabels[cause]}`);
        lines.push(`> ${q}`);
        lines.push(`- Expected: \`${d.groundTruth}\``);
        lines.push(`- Baseline extracted: \`${d.baseline.extractedAnswer}\` ✓`);
        lines.push(`- Tool extracted: \`${d.toolAugmented.extractedAnswer}\` ✗`);
        lines.push(`- Tools: ${toolSummary}`);
        if (d.toolAugmented.toolCalls.length > 0) {
          for (const tc of d.toolAugmented.toolCalls) {
            const argsStr = JSON.stringify(tc.args).slice(0, 100);
            const resStr = tc.result.length > 60 ? tc.result.slice(0, 60) + '…' : tc.result;
            lines.push(`  - \`${tc.name}(${argsStr})\` → \`${resStr}\``);
          }
        }
        lines.push('');
      }
    }
  }

  // Token usage
  lines.push('## Token Usage');
  lines.push('');
  lines.push(`- Baseline total: ${r.totalBaselineTokens.toLocaleString()} tokens`);
  lines.push(`- Tool-augmented total: ${r.totalToolTokens.toLocaleString()} tokens`);
  lines.push(
    `- Total duration: ${(r.totalDurationMs / 1000 / 60).toFixed(1)} minutes`,
  );
  lines.push('');

  lines.push('---');
  lines.push('*Generated by axiom-mcp-benchmark*');
  lines.push('');

  return lines.join('\n');
}
