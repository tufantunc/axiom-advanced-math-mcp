import { fetchDataset } from './loader.js';

export interface GSM8KProblem {
  question: string;
  answer: string; // full solution text
  numericAnswer: number; // extracted number after "####"
}

/**
 * Extract the numeric answer from GSM8K solution text.
 * Format: "... #### 42" (last occurrence wins)
 */
export function extractGSM8KAnswer(solutionText: string): number | null {
  const matches = [...solutionText.matchAll(/####\s*([\d,.-]+)/g)];
  if (matches.length === 0) return null;
  const raw = matches[matches.length - 1][1].replace(/,/g, '');
  const num = parseFloat(raw);
  return isNaN(num) ? null : num;
}

export async function loadGSM8K(limit: number, cacheDir: string): Promise<GSM8KProblem[]> {
  if (limit === 0) return [];
  const rows = await fetchDataset('openai/gsm8k', 'main', 'test', limit, cacheDir);

  return rows
    .map(r => {
      const question = String(r.row['question'] ?? '');
      const answer = String(r.row['answer'] ?? '');
      const numericAnswer = extractGSM8KAnswer(answer);
      if (!question || numericAnswer === null) return null;
      return { question, answer, numericAnswer };
    })
    .filter((p): p is GSM8KProblem => p !== null);
}
