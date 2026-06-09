#!/usr/bin/env tsx
/**
 * Offline re-grade of an existing *-details.jsonl with grader v2.
 * Outputs a comparison report (v1 vs v2 on the same model traces).
 *
 * Usage: tsx regrade.ts <path/to/details.jsonl>
 */
import { readFile, writeFile } from 'fs/promises';
import path from 'path';
import { gradeV2Async } from './graders/grader-v2.js';
import { getDefaultGiacBridge } from './graders/giac-bridge.js';
import { answerToGrade } from './regrade-extract.js';

interface Detail {
  dataset: string;
  index: number;
  question: string;
  groundTruth: string;
  baseline: { extractedAnswer: string; correct: boolean; response?: string };
  toolAugmented: { extractedAnswer: string; correct: boolean; response?: string };
}

async function main(): Promise<void> {
  const [arg] = process.argv.slice(2);
  if (!arg) throw new Error('Usage: tsx regrade.ts <path/to/details.jsonl>');
  const raw = await readFile(arg, 'utf-8');
  const lines = raw.split('\n').filter((l) => l.trim());
  const bridge = await getDefaultGiacBridge();

  let v1Tool = 0;
  let v2Tool = 0;
  let v1Base = 0;
  let v2Base = 0;
  const newImprovements: Detail[] = [];

  // Per-dataset breakdown
  type DatasetDelta = { v1Base: number; v1Tool: number; v2Base: number; v2Tool: number; n: number };
  const byDataset = new Map<string, DatasetDelta>();
  function bucket(name: string): DatasetDelta {
    let d = byDataset.get(name);
    if (!d) {
      d = { v1Base: 0, v1Tool: 0, v2Base: 0, v2Tool: 0, n: 0 };
      byDataset.set(name, d);
    }
    return d;
  }

  for (const line of lines) {
    const d: Detail = JSON.parse(line);
    if (d.baseline.correct) v1Base++;
    if (d.toolAugmented.correct) v1Tool++;
    const ds = bucket(d.dataset);
    ds.n++;
    if (d.baseline.correct) ds.v1Base++;
    if (d.toolAugmented.correct) ds.v1Tool++;

    const baseR = await gradeV2Async(answerToGrade(d.baseline), d.groundTruth, {
      giacEval: bridge.evaluate,
    });
    const toolR = await gradeV2Async(answerToGrade(d.toolAugmented), d.groundTruth, {
      giacEval: bridge.evaluate,
    });
    if (baseR.match) {
      v2Base++;
      ds.v2Base++;
    }
    if (toolR.match) {
      v2Tool++;
      ds.v2Tool++;
      if (!d.toolAugmented.correct) newImprovements.push(d);
    }
  }

  const out: string[] = [];
  out.push(`# Phase 0 — Grader-Only Re-grade Delta`);
  out.push(``);
  out.push(`**Source:** \`${path.basename(arg)}\` (n=${lines.length})`);
  out.push(`**Re-grade method:** offline; same model traces; v1 vs v2 grader.`);
  out.push(``);
  out.push(`## Aggregate`);
  out.push(``);
  out.push(`| Condition | v1 correct | v2 correct | Δ |`);
  out.push(`|---|---|---|---|`);
  out.push(`| Baseline | ${v1Base} | ${v2Base} | ${v2Base - v1Base >= 0 ? '+' : ''}${v2Base - v1Base} |`);
  out.push(`| Tool-augmented | ${v1Tool} | ${v2Tool} | ${v2Tool - v1Tool >= 0 ? '+' : ''}${v2Tool - v1Tool} |`);
  out.push(``);
  out.push(`## Per-dataset`);
  out.push(``);
  out.push(`| Dataset | N | v1 base | v2 base | Δb | v1 tool | v2 tool | Δt |`);
  out.push(`|---|---|---|---|---|---|---|---|`);
  for (const [name, d] of byDataset) {
    const db = d.v2Base - d.v1Base;
    const dt = d.v2Tool - d.v1Tool;
    out.push(
      `| ${name} | ${d.n} | ${d.v1Base} | ${d.v2Base} | ${db >= 0 ? '+' : ''}${db} | ${d.v1Tool} | ${d.v2Tool} | ${dt >= 0 ? '+' : ''}${dt} |`
    );
  }
  out.push(``);
  out.push(`## Newly correct under v2 (tool-augmented condition, up to 30)`);
  out.push(``);
  if (newImprovements.length === 0) {
    out.push(`*No changes in tool-augmented correctness under v2.*`);
  } else {
    for (const d of newImprovements.slice(0, 30)) {
      out.push(
        `- **#${d.index}** [${d.dataset}] expected \`${d.groundTruth}\`, model said \`${d.toolAugmented.extractedAnswer}\``
      );
    }
    if (newImprovements.length > 30) {
      out.push(``);
      out.push(`*…plus ${newImprovements.length - 30} more.*`);
    }
  }

  const outPath = arg.replace(/-details\.jsonl$/, '-regrade.md');
  await writeFile(outPath, out.join('\n') + '\n');
  console.log(`Wrote ${outPath}`);
  console.log(`Baseline: ${v1Base} → ${v2Base} (Δ ${v2Base - v1Base})`);
  console.log(`Tool-aug: ${v1Tool} → ${v2Tool} (Δ ${v2Tool - v1Tool})`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
