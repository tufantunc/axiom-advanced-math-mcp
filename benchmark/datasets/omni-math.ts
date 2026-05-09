import { fetchDataset } from './loader.js';

export interface OmniMATHProblem {
  problem: string;
  solution: string;
  answer: string; // extracted from \boxed{}
  difficulty: number; // 1–10
  domain: string;
  source: string;
}

const MIN_DIFFICULTY = 7;

/**
 * Extract answer from Omni-MATH problem.
 * Uses same \boxed{} extraction as MATH dataset.
 */
function extractAnswer(text: string): string | null {
  const idx = text.indexOf('\\boxed{');
  if (idx === -1) return null;

  let depth = 0;
  const start = idx + 7;
  let i = start;
  for (; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}') {
      if (depth === 0) break;
      depth--;
    }
  }
  return text.slice(start, i).trim() || null;
}

export async function loadOmniMATH(
  limit: number,
  cacheDir: string,
): Promise<OmniMATHProblem[]> {
  if (limit === 0) return [];

  // Fetch more than needed to account for filtering by difficulty
  const fetchLimit = Math.min(limit * 5, 2000);
  const rows = await fetchDataset('KbsdJames/Omni-MATH', 'default', 'test', fetchLimit, cacheDir);

  const problems: OmniMATHProblem[] = [];

  for (const r of rows) {
    if (problems.length >= limit) break;

    const difficulty = Number(r.row['difficulty'] ?? 0);
    if (difficulty < MIN_DIFFICULTY) continue;

    const problem = String(r.row['problem'] ?? '');
    const solution = String(r.row['solution'] ?? '');
    const domain = String(r.row['domain'] ?? 'Unknown');
    const source = String(r.row['source'] ?? 'Unknown');

    // Try to extract answer from solution, fallback to answer field
    const answerField = r.row['answer'];
    const answer =
      (answerField ? String(answerField) : null) ??
      extractAnswer(solution);

    if (!problem || !answer) continue;

    problems.push({ problem, solution, answer, difficulty, domain, source });
  }

  return problems;
}
