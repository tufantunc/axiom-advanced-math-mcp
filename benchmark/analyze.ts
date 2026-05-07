#!/usr/bin/env tsx
/**
 * Regression-classification CLI.
 *
 * Reads the most recent *-details.jsonl in ./results and writes a Markdown
 * report classifying every regression and "both wrong" record.
 *
 * Usage: tsx analyze.ts [path/to/details.jsonl]
 */
import { readFile, readdir, writeFile } from 'fs/promises';
import path from 'path';

interface ToolCall {
  name: string;
  args: Record<string, unknown>;
  result: string;
  success: boolean;
}

interface Detail {
  dataset: string;
  index: number;
  question: string;
  groundTruth: string;
  baseline: { extractedAnswer: string; correct: boolean; method: string };
  toolAugmented: {
    extractedAnswer: string;
    correct: boolean;
    method: string;
    toolCalls: ToolCall[];
    turns: number;
  };
  regression: boolean;
  improvement: boolean;
}

type Category =
  | 'NO_TOOL_CALL'
  | 'EMPTY_TOOL_RESULT'
  | 'OUTPUT_PARSE_ERROR'
  | 'GRADER_MISMATCH'
  | 'WRONG_TOOL_CALL'
  | 'WRONG_ANSWER';

function classify(d: Detail): Category {
  const tc = d.toolAugmented.toolCalls;
  if (tc.length === 0) return 'NO_TOOL_CALL';

  const empty = tc.some(
    (c) =>
      /Result:\s*\[\]/.test(c.result) ||
      /GIAC_ERROR/.test(c.result) ||
      /\bNaN\b|\bInf\b|\bundef\b/.test(c.result)
  );
  if (empty && !d.toolAugmented.correct) return 'EMPTY_TOOL_RESULT';

  // If any tool result contains the ground truth substring, model probably
  // saw the answer but failed to extract it.
  const gt = d.groundTruth.trim();
  const altGt = gt.replace(/\\frac\{(\d+)\}\{(\d+)\}/g, '$1/$2').trim();
  const containsAnswer = tc.some(
    (c) => c.result.includes(gt) || (altGt !== gt && c.result.includes(altGt))
  );
  if (containsAnswer && !d.toolAugmented.correct) return 'OUTPUT_PARSE_ERROR';

  // If grader-v2 (with the model's extracted answer) would have said yes, this is a grader miss.
  if (
    d.baseline.correct &&
    d.toolAugmented.extractedAnswer === d.baseline.extractedAnswer &&
    !d.toolAugmented.correct
  ) {
    return 'GRADER_MISMATCH';
  }

  return 'WRONG_ANSWER';
}

async function findLatestJsonl(dir: string): Promise<string | null> {
  const entries = await readdir(dir);
  const jsonls = entries.filter((f) => f.endsWith('-details.jsonl')).sort();
  return jsonls.length ? path.join(dir, jsonls[jsonls.length - 1]) : null;
}

async function main(): Promise<void> {
  const [arg] = process.argv.slice(2);
  let filepath: string;
  if (arg) {
    filepath = arg;
  } else {
    const found = await findLatestJsonl(path.resolve('results'));
    if (!found) throw new Error('No *-details.jsonl found in ./results');
    filepath = found;
  }

  const raw = await readFile(filepath, 'utf-8');
  const details: Detail[] = raw
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));

  const regressions = details.filter((d) => d.regression);
  const bothWrong = details.filter((d) => !d.baseline.correct && !d.toolAugmented.correct);

  const counts: Record<Category, number> = {
    NO_TOOL_CALL: 0,
    EMPTY_TOOL_RESULT: 0,
    OUTPUT_PARSE_ERROR: 0,
    GRADER_MISMATCH: 0,
    WRONG_TOOL_CALL: 0,
    WRONG_ANSWER: 0,
  };

  type Tagged = Detail & { category: Category };
  const taggedRegressions: Tagged[] = regressions.map((d) => {
    const c = classify(d);
    counts[c]++;
    return { ...d, category: c };
  });

  const lines: string[] = [];
  lines.push(`# Regression Analysis`);
  lines.push(``);
  lines.push(`**Source:** \`${path.basename(filepath)}\``);
  lines.push(`**Total problems:** ${details.length}`);
  lines.push(`**Regressions:** ${regressions.length}`);
  lines.push(`**Both wrong:** ${bothWrong.length}`);
  lines.push(``);
  lines.push(`## Regression categories`);
  lines.push(``);
  lines.push(`| Category | Count |`);
  lines.push(`|---|---|`);
  for (const [cat, n] of Object.entries(counts)) {
    lines.push(`| ${cat} | ${n} |`);
  }
  lines.push(``);
  lines.push(`## Examples`);
  for (const d of taggedRegressions.slice(0, 20)) {
    lines.push(``);
    lines.push(`### #${d.index} [${d.dataset}] — ${d.category}`);
    lines.push(`- Question: ${d.question.slice(0, 120)}...`);
    lines.push(`- Expected: \`${d.groundTruth}\``);
    lines.push(`- Baseline: \`${d.baseline.extractedAnswer}\` ✓`);
    lines.push(`- Tool: \`${d.toolAugmented.extractedAnswer}\` ✗`);
    if (d.toolAugmented.toolCalls.length > 0) {
      lines.push(`- Tool calls:`);
      for (const tc of d.toolAugmented.toolCalls.slice(0, 4)) {
        const summary = tc.result.split('\n').slice(0, 2).join(' | ').slice(0, 140);
        lines.push(`  - \`${tc.name}\` → ${summary}`);
      }
    }
  }

  const outPath = filepath.replace(/-details\.jsonl$/, '-regression-analysis.md');
  await writeFile(outPath, lines.join('\n') + '\n');
  console.log(`Wrote ${outPath}`);
  console.log(`Counts:`, counts);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
