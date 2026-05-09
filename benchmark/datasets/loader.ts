import { createReadStream, createWriteStream, existsSync, mkdirSync } from 'fs';
import { readFile, writeFile, mkdir } from 'fs/promises';
import { createInterface } from 'readline';
import path from 'path';

const HF_BASE = 'https://datasets-server.huggingface.co';

export interface HFRow {
  rowIndex: number;
  row: Record<string, unknown>;
}

interface HFResponse {
  rows: HFRow[];
  num_rows_total?: number;
}

/**
 * Fetch rows from HuggingFace Datasets Server HTTP API with disk cache.
 * Cache is stored as JSONL at cacheDir/<safeDataset>_<split>.jsonl
 */
export async function fetchDataset(
  dataset: string,
  config: string,
  split: string,
  limit: number,
  cacheDir: string,
): Promise<HFRow[]> {
  const safeDataset = dataset.replace(/\//g, '_');
  const cacheFile = path.join(cacheDir, `${safeDataset}_${config}_${split}.jsonl`);

  // Load from cache if available and has enough rows
  if (existsSync(cacheFile)) {
    const cached = await loadJsonl(cacheFile);
    if (cached.length >= limit) {
      console.log(`  [cache] ${dataset} (${split}): ${limit} rows`);
      return cached.slice(0, limit);
    }
  }

  // Fetch from HuggingFace
  console.log(`  [fetch] ${dataset} (${split}): fetching up to ${limit} rows…`);
  const rows: HFRow[] = [];
  const batchSize = 100;

  for (let offset = 0; offset < limit; offset += batchSize) {
    const batchLimit = Math.min(batchSize, limit - offset);
    const url = `${HF_BASE}/rows?dataset=${encodeURIComponent(dataset)}&config=${encodeURIComponent(config)}&split=${encodeURIComponent(split)}&offset=${offset}&limit=${batchLimit}`;

    let data: HFResponse;
    try {
      const res = await fetch(url);
      if (!res.ok) {
        console.warn(`  [fetch] HTTP ${res.status} for ${url}`);
        break;
      }
      data = (await res.json()) as HFResponse;
    } catch (err) {
      console.warn(`  [fetch] Network error: ${err}`);
      break;
    }

    if (!data.rows || data.rows.length === 0) break;
    rows.push(...data.rows);

    if (rows.length >= limit) break;

    // Small delay to be polite
    await sleep(100);
  }

  // Persist to cache
  mkdirSync(cacheDir, { recursive: true });
  await saveJsonl(cacheFile, rows);
  console.log(`  [fetch] ${dataset} (${split}): ${rows.length} rows cached`);

  return rows.slice(0, limit);
}

async function loadJsonl(filePath: string): Promise<HFRow[]> {
  const content = await readFile(filePath, 'utf-8');
  return content
    .split('\n')
    .filter(line => line.trim())
    .map(line => JSON.parse(line) as HFRow);
}

async function saveJsonl(filePath: string, rows: HFRow[]): Promise<void> {
  const content = rows.map(r => JSON.stringify(r)).join('\n') + '\n';
  await writeFile(filePath, content, 'utf-8');
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
