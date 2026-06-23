import type { ArmName } from './arms.js';

export interface ArmProblemRecord {
  correct: boolean;
  toolCalls: { name: string; success: boolean }[];
  turns: number;
  outputTokens: number;
  extractionClean: boolean;
}

export interface ArmVerifyRecord {
  isTrue: boolean;
  correct: boolean;
}

export interface ArmRollup {
  arm: ArmName | string;
  n: number;
  accuracy: number;
  toolSuccessRate: number;
  avgTurns: number;
  avgOutputTokens: number;
  extractionCleanRate: number;
  confirmTrueRate: number;
  rejectFalseRate: number;
  verifyAccuracy: number;
}

const rate = (num: number, den: number): number => (den === 0 ? 0 : num / den);
const mean = (xs: number[]): number => (xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length);

export function rollupArm(
  arm: ArmName | string,
  problems: ArmProblemRecord[],
  verifies: ArmVerifyRecord[]
): ArmRollup {
  const allToolCalls = problems.flatMap((p) => p.toolCalls);
  const trueClaims = verifies.filter((v) => v.isTrue);
  const falseClaims = verifies.filter((v) => !v.isTrue);
  return {
    arm,
    n: problems.length,
    accuracy: rate(problems.filter((p) => p.correct).length, problems.length),
    toolSuccessRate: rate(allToolCalls.filter((t) => t.success).length, allToolCalls.length),
    avgTurns: mean(problems.map((p) => p.turns)),
    avgOutputTokens: mean(problems.map((p) => p.outputTokens)),
    extractionCleanRate: rate(problems.filter((p) => p.extractionClean).length, problems.length),
    confirmTrueRate: rate(trueClaims.filter((v) => v.correct).length, trueClaims.length),
    rejectFalseRate: rate(falseClaims.filter((v) => v.correct).length, falseClaims.length),
    verifyAccuracy: rate(verifies.filter((v) => v.correct).length, verifies.length),
  };
}

const pct = (x: number): string => `${(x * 100).toFixed(1)}%`;

export function renderComparison(rows: ArmRollup[]): string {
  const header =
    '| Arm | N | Accuracy | Tool-success | Avg turns | Avg out-tok | Extraction-clean | Confirm-true | Reject-false | Verify-acc |\n' +
    '|---|---|---|---|---|---|---|---|---|---|';
  const body = rows
    .map(
      (r) =>
        `| ${r.arm} | ${r.n} | ${pct(r.accuracy)} | ${pct(r.toolSuccessRate)} | ${r.avgTurns.toFixed(1)} | ` +
        `${r.avgOutputTokens.toFixed(0)} | ${pct(r.extractionCleanRate)} | ${pct(r.confirmTrueRate)} | ` +
        `${pct(r.rejectFalseRate)} | ${pct(r.verifyAccuracy)} |`
    )
    .join('\n');
  return `${header}\n${body}\n`;
}
