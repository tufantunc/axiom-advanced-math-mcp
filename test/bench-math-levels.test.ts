import { describe, it, expect } from 'vitest';
import { activeMathLevels, rowsPerConfig } from '../benchmark/datasets/math.js';

describe('activeMathLevels', () => {
  it('selects only levels with a positive limit (L4+L5 requested, L3 off)', () => {
    expect(activeMathLevels({ mathLevel3: 0, mathLevel4: 50, mathLevel5: 50 })).toEqual({
      levels: [4, 5],
      limitPerLevel: 50,
    });
  });
  it('selects only L3 when only L3 requested', () => {
    expect(activeMathLevels({ mathLevel3: 50, mathLevel4: 0, mathLevel5: 0 })).toEqual({
      levels: [3],
      limitPerLevel: 50,
    });
  });
  it('selects all three when all requested', () => {
    expect(activeMathLevels({ mathLevel3: 50, mathLevel4: 50, mathLevel5: 50 })).toEqual({
      levels: [3, 4, 5],
      limitPerLevel: 50,
    });
  });
  it('returns empty selection when no math level is requested', () => {
    expect(activeMathLevels({ mathLevel3: 0, mathLevel4: 0, mathLevel5: 0 })).toEqual({
      levels: [],
      limitPerLevel: 0,
    });
  });
});

describe('rowsPerConfig', () => {
  // The MATH test split is 7 category configs; rows are fetched from all of
  // them and then filtered to the requested levels. Measured level shares over
  // the cached split: L1 8.5%, L2 17.5%, L3 22.5%, L4 24.5%, L5 27.0%.
  const CONFIGS = 7;
  const MEASURED_SHARES: Record<number, number> = {
    3: 0.225,
    4: 0.245,
    5: 0.27,
  };

  it.each([3, 4, 5])('fetches enough rows to fill level %i to 50', (level) => {
    const fetched = rowsPerConfig(50) * CONFIGS;
    const matchingRows = fetched * MEASURED_SHARES[level];
    expect(matchingRows).toBeGreaterThanOrEqual(50);
  });

  it('does not depend on how many levels were requested', () => {
    // The bug: the old formula had levels.length in the numerator, so asking
    // for one level fetched fewer rows than asking for three and yielded 30
    // problems instead of 50. The function takes only the per-level limit now,
    // which makes that class of mistake unrepresentable.
    expect(rowsPerConfig.length).toBe(1);
  });

  it('scales with the requested limit', () => {
    expect(rowsPerConfig(100)).toBeGreaterThan(rowsPerConfig(50));
    expect(rowsPerConfig(0)).toBe(0);
  });

  it('is at least the naive per-config share of the limit', () => {
    // A lower bound that would have failed on the old formula for a
    // single-level request: it produced 15 per config for a limit of 50.
    expect(rowsPerConfig(50)).toBeGreaterThan(50 / CONFIGS);
    expect(rowsPerConfig(50)).toBeGreaterThanOrEqual(50);
  });
});
