#!/usr/bin/env tsx
/**
 * Differentiation benchmark: same CAS problems + verify set across three arms
 * (pure-model, code-exec, axiom), one model (Sonnet 4.6 via claude-code), one
 * grader. Emits a side-by-side comparison artifact.
 *
 * Usage:
 *   AXIOM_GRADER_V3=1 npx tsx benchmark/differentiation/run.ts [--limit N]
 */
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { ARMS } from './arms.js';
import { runArm } from './arm-runner.js';
import { VERIFY_SET } from './verify-set.js';
import { scoreVerify } from './verify-scorer.js';
import { rollupArm, renderComparison, type ArmProblemRecord, type ArmVerifyRecord } from './compare.js';
import { buildMcpConfig } from '../providers/claude-code.js';
import { grade } from '../graders/grader.js';
import { BASELINE_SYSTEM_PROMPT } from '../providers/prompts.js';
import { loadCAS } from '../datasets/cas-problems.js';

const MODEL = 'claude-sonnet-4-6';
const MAX_TURNS = 8;
// Same neutral prompt for every arm — fairness. Arms differ only in tools.
const SYSTEM_PROMPT = `${BASELINE_SYSTEM_PROMPT}\nUse any tools available to you to ensure your answer is correct.`;

function parseLimit(): number {
  const i = process.argv.indexOf('--limit');
  return i !== -1 ? Number(process.argv[i + 1]) : 20;
}

/** A clean answer is extractable (has a \boxed{...}). */
function isExtractionClean(text: string): boolean {
  return /\\boxed\{/.test(text);
}

async function main(): Promise<void> {
  const limit = parseLimit();
  const workdir = mkdtempSync(path.join(tmpdir(), 'axiom-diff-'));
  // tsx re-resolves itself from the child cwd; symlink node_modules so the Axiom MCP launches.
  const nm = path.join(process.cwd(), 'node_modules');
  if (existsSync(nm)) {
    try {
      symlinkSync(nm, path.join(workdir, 'node_modules'));
    } catch {
      /* best-effort */
    }
  }

  const axiomCfg = path.join(workdir, 'axiom.json');
  writeFileSync(axiomCfg, JSON.stringify(buildMcpConfig(['tsx', 'src/cli.ts'], process.cwd())));

  const problems = loadCAS(limit);
  const runOpts = { model: MODEL, maxTurns: MAX_TURNS, axiomMcpPath: axiomCfg, cwd: workdir };

  const rollups = [];
  for (const arm of ARMS) {
    console.log(`\n=== Arm: ${arm.name} ===`);

    // Block 1: accuracy + efficiency on CAS problems.
    const problemRecords: ArmProblemRecord[] = [];
    for (const p of problems) {
      const r = await runArm(p.problem, arm, { ...runOpts, appendSystemPrompt: SYSTEM_PROMPT });
      if (!r.ok) console.log(`  ! arm failed on: ${p.problem.slice(0, 50)}`);
      const g = r.ok ? await grade(r.text, String(p.answer)) : { correct: false };
      problemRecords.push({
        correct: g.correct,
        toolCalls: r.toolCalls,
        turns: r.turns,
        outputTokens: r.outputTokens,
        extractionClean: isExtractionClean(r.text),
      });
      console.log(`  ${p.problem.slice(0, 40)} -> ${g.correct ? 'OK' : 'X'} (${r.turns}t)`);
    }

    // Block 2: verify set.
    const verifyRecords: ArmVerifyRecord[] = [];
    for (const c of VERIFY_SET) {
      const prompt = `Verify whether this mathematical claim is correct: "${c.claim}". End your response with exactly one word: TRUE or FALSE.`;
      const r = await runArm(prompt, arm, { ...runOpts, appendSystemPrompt: SYSTEM_PROMPT });
      const s = r.ok ? scoreVerify(r.text, c.isTrue) : { verdict: 'ambiguous' as const, correct: false };
      verifyRecords.push({ isTrue: c.isTrue, correct: s.correct });
    }

    rollups.push(rollupArm(arm.name, problemRecords, verifyRecords));
  }

  const md = renderComparison(rollups);
  const resultsDir = path.join(process.cwd(), 'benchmark', 'results');
  mkdirSync(resultsDir, { recursive: true });
  const outPath = path.join(resultsDir, `differentiation-${MODEL}.md`);
  writeFileSync(outPath, `# Differentiation Benchmark - ${MODEL}\n\nN(problems)=${problems.length}, verify N=${VERIFY_SET.length}\n\n${md}\n`);
  console.log(`\n${md}\nWrote ${outPath}`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
