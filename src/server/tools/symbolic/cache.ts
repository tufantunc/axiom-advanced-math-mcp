export interface CacheEntry {
  result: string;
  latex?: string;
  // Mirrors VerificationResult from tools/self-verify.ts — kept inline to avoid
  // a dependency from cache.ts into the tools layer.
  verification?: { verified: boolean; method: 'substitution' | 'expand' | 'differentiation'; detail: string };
}

const MAX_ENTRIES = 100;

/**
 * Giac constructs that mutate global CAS session state.
 *
 * `:=` covers Xcas assignment (`a:=5`) and `=<` is not a thing, so a plain
 * substring scan is enough; `sto(`/`assume(`/`purge(` are matched with the
 * open paren so an unrelated identifier like `store_x` is not caught.
 */
const STATE_MUTATING = ['sto(', ':=', 'assume(', 'purge('];

/**
 * Whether a Giac expression may be served from / stored in the shared cache.
 *
 * The cache is process-wide and keyed on the expression string alone, so it
 * is a second state-leak channel that the per-tool-call engine reset cannot
 * close: a single tool call whose input both mutates CAS state and computes
 * against it (`sto(9,d); d+1`) would store a result that is only valid under
 * that mutation, under a key that does not mention it — and hand it to a
 * later, clean caller.
 *
 * Deliberately conservative and syntactic: a false positive is just a cache
 * miss, which costs a millisecond and is always correct.
 */
export function isCacheable(expression: string): boolean {
  const lower = expression.toLowerCase();
  return !STATE_MUTATING.some((token) => lower.includes(token));
}

/**
 * Simple LRU cache for Giac evaluation results.
 */
class LruCache {
  private cache = new Map<string, CacheEntry>();

  get(key: string): CacheEntry | undefined {
    const entry = this.cache.get(key);
    if (entry) {
      // Move to end (most recently used)
      this.cache.delete(key);
      this.cache.set(key, entry);
    }
    return entry;
  }

  set(key: string, value: CacheEntry): void {
    if (this.cache.has(key)) {
      this.cache.delete(key);
    } else if (this.cache.size >= MAX_ENTRIES) {
      // Delete oldest entry
      const firstKey = this.cache.keys().next().value;
      if (firstKey !== undefined) {
        this.cache.delete(firstKey);
      }
    }
    this.cache.set(key, value);
  }

  get size(): number {
    return this.cache.size;
  }

  clear(): void {
    this.cache.clear();
  }
}

export const evaluationCache = new LruCache();
