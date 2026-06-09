import { describe, it, expect } from 'vitest';
import { activeMathLevels } from '../benchmark/datasets/math.js';

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
