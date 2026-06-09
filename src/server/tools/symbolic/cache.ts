export interface CacheEntry {
  result: string;
  latex?: string;
  verification?: { verified: boolean; method: 'substitution' | 'expand' | 'differentiation'; detail: string };
}

const MAX_ENTRIES = 100;

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
}

export const evaluationCache = new LruCache();
