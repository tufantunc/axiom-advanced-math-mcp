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
 * Derive which MATH levels to load (and the per-level limit) from the resolved
 * per-level limits. A level is loaded iff its limit is > 0, so passing
 * `--math-l4 --math-l5` (which leaves `mathLevel3 = 0`) correctly loads L4+L5
 * only — instead of the old bug where the single `mathLevel3` limit was applied
 * to all three levels, yielding 0 problems whenever L3 was not requested.
 * Sizes are uniform per size mode, so the active levels share one limit.
 */
export function activeMathLevels(limits: {
  mathLevel3: number;
  mathLevel4: number;
  mathLevel5: number;
}): { levels: MATHLevel[]; limitPerLevel: number } {
  const entries: [MATHLevel, number][] = [
    [3, limits.mathLevel3],
    [4, limits.mathLevel4],
    [5, limits.mathLevel5],
  ];
  const active = entries.filter(([, n]) => n > 0);
  return {
    levels: active.map(([lvl]) => lvl),
    limitPerLevel: active.length > 0 ? Math.max(...active.map(([, n]) => n)) : 0,
  };
}

/**
 * Share of the test split occupied by the scarcest level this benchmark asks
 * for. Measured over the cached split (3,839 rows): level 1 is 8.5%, 2 is
 * 17.5%, 3 is 22.5%, 4 is 24.5%, 5 is 27.0%. L3 is the scarcest of {3,4,5}, at
 * a little over a fifth, so a fifth is the share to plan for.
 */
const SCARCEST_LEVEL_SHARE = 0.2;

/** Margin over the theoretical minimum, covering per-category level skew. */
const FETCH_MARGIN = 1.5;

/**
 * How many rows to pull from each category config in order to fill one level's
 * bucket to `limitPerLevel` after the level filter.
 *
 * Exported so the invariant is testable without touching the network: the fetch
 * must be big enough that the scarcest level still fills. It was not, and
 * nothing asserted the resulting problem count, so `--math-l4 --quick` silently
 * produced 30 problems against a limit of 50 for months.
 *
 * `levels.length` deliberately does not appear. The binding constraint is
 * filling the scarcest single bucket, and asking for more levels does not make
 * that bucket harder to fill — the old formula multiplied by it and so fetched
 * *fewer* rows for a single-level run than for a three-level one.
 */
export function rowsPerConfig(limitPerLevel: number): number {
  return Math.ceil((limitPerLevel * FETCH_MARGIN) / (SCARCEST_LEVEL_SHARE * MATH_CONFIGS.length));
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

  // Rows come from all 7 category configs and are then filtered down to the
  // requested levels, so the fetch has to over-sample by however selective that
  // filter is.
  //
  // The previous formula was `levels.length * limitPerLevel * 2 / configs`,
  // which had `levels.length` in the numerator — exactly backwards. Asking for
  // one level fetched *fewer* rows than asking for three, then threw away four
  // fifths of them. `--math-l4 --quick` fetched 105 rows and yielded 30
  // problems against a limit of 50, while `--math --quick` filled all three
  // levels to 50 by accident. Single-level and combined runs were therefore not
  // comparable, and the archive has both kinds recorded as "MATH L4".
  //
  // Measured on the cached test split (3,839 rows): level 1 is 8.5% of the
  // corpus, 2 is 17.5%, 3 is 22.5%, 4 is 24.5%, 5 is 27.0%. The scarcest level
  // this benchmark asks for is L3 at a little over a fifth, so a fifth is the
  // share to plan for. No row in the split is missing its `\boxed{}` answer, so
  // the margin below covers per-category level skew rather than extraction loss.
  //
  // `levels.length` correctly drops out: the binding constraint is filling the
  // scarcest single bucket, and requesting more levels does not make that
  // bucket harder to fill.
  const perConfigLimit = rowsPerConfig(limitPerLevel);

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
