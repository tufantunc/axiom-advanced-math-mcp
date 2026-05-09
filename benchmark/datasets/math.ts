import { fetchDataset, type HFRow } from './loader.js';

export type MATHLevel = 1 | 2 | 3 | 4 | 5;

export interface MATHProblem {
  problem: string;
  solution: string;
  answer: string; // extracted from \boxed{}
  level: MATHLevel;
  type: string; // e.g. "Algebra", "Number Theory"
}

/**
 * EleutherAI/hendrycks_math — public mirror of the MATH dataset.
 * Split into 7 configs by category.
 */
const MATH_CONFIGS = [
  'algebra',
  'counting_and_probability',
  'geometry',
  'intermediate_algebra',
  'number_theory',
  'prealgebra',
  'precalculus',
] as const;

/**
 * Extract answer from MATH dataset solution.
 * Format: \boxed{answer} — handles nested braces.
 */
export function extractMATHAnswer(solution: string): string | null {
  const idx = solution.indexOf('\\boxed{');
  if (idx === -1) return null;

  let depth = 0;
  const start = idx + 7; // after \boxed{
  let i = start;
  // Find matching closing brace
  for (; i < solution.length; i++) {
    if (solution[i] === '{') depth++;
    else if (solution[i] === '}') {
      if (depth === 0) break;
      depth--;
    }
  }
  return solution.slice(start, i).trim() || null;
}

export async function loadMATH(
  levels: MATHLevel[],
  limitPerLevel: number,
  cacheDir: string,
): Promise<MATHProblem[]> {
  if (limitPerLevel === 0 || levels.length === 0) return [];

  // Fetch from all 7 configs in parallel
  const perConfigLimit = Math.ceil((levels.length * limitPerLevel * 2) / MATH_CONFIGS.length);

  const configResults = await Promise.all(
    MATH_CONFIGS.map(config =>
      fetchDataset('EleutherAI/hendrycks_math', config, 'test', perConfigLimit, cacheDir),
    ),
  );

  // Merge all rows
  const allRows: HFRow[] = configResults.flat();

  const byLevel: Map<MATHLevel, MATHProblem[]> = new Map();
  for (const level of levels) byLevel.set(level, []);

  for (const r of allRows) {
    const rawLevel = r.row['level'];
    const levelNum =
      typeof rawLevel === 'string'
        ? parseInt(rawLevel.replace('Level ', ''))
        : Number(rawLevel);

    if (!levels.includes(levelNum as MATHLevel)) continue;

    const bucket = byLevel.get(levelNum as MATHLevel)!;
    if (bucket.length >= limitPerLevel) continue;

    const problem = String(r.row['problem'] ?? '');
    const solution = String(r.row['solution'] ?? '');
    const type = String(r.row['type'] ?? 'Unknown');
    const answer = extractMATHAnswer(solution);

    if (!problem || !answer) continue;

    bucket.push({ problem, solution, answer, level: levelNum as MATHLevel, type });
  }

  return [...byLevel.values()].flat();
}
