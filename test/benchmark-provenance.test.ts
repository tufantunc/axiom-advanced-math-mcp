import { describe, it, expect } from 'vitest';
import {
  collectProvenance,
  formatProvenance,
  type RunProvenance,
} from '../benchmark/provenance.js';

const base: RunProvenance = {
  features: ['v2'],
  selfConsistency: null,
  commit: 'd0ed36dabe8ab2562e6e33024936c57c35e633c1',
  dirty: false,
  serverVersion: '1.0.5',
  nodeVersion: 'v24.14.0',
};

describe('formatProvenance', () => {
  it('renders the flags that decide whether two runs are comparable', () => {
    const line = formatProvenance({ ...base, features: ['v2', 'output-hygiene'] });
    expect(line).toContain('**Features:** v2,output-hygiene');
    expect(line).toContain('**Server:** v1.0.5');
    expect(line).toContain('**Commit:** d0ed36d');
  });

  it('says "none" rather than leaving the flag list blank', () => {
    // An empty string here would read as "this field was not recorded", which
    // is the exact ambiguity the provenance block exists to remove.
    expect(formatProvenance({ ...base, features: [] })).toContain('**Features:** none');
  });

  it('marks a dirty tree as not reproducible', () => {
    const line = formatProvenance({ ...base, dirty: true });
    expect(line).toContain('not reproducible');
  });

  it('leaves the reproducibility warning off a clean tree', () => {
    expect(formatProvenance(base)).not.toContain('not reproducible');
  });

  it('spells out the voting configuration, not just that it was on', () => {
    // "self-consistency: on" would not distinguish N=3 from N=5, and the two
    // produce different variance — the numbers have to be in the record.
    const line = formatProvenance({ ...base, selfConsistency: { N: 5, temperature: 0.7 } });
    expect(line).toContain('N=5@t0.7');
  });

  it('reports voting as off when it was not used', () => {
    expect(formatProvenance(base)).toContain('**Self-consistency:** off');
  });
});

describe('collectProvenance', () => {
  it('records the configuration it was given', () => {
    const p = collectProvenance(['v2', 'grader-v3'], { N: 3, temperature: 0.7 });
    expect(p.features).toEqual(['v2', 'grader-v3']);
    expect(p.selfConsistency).toEqual({ N: 3, temperature: 0.7 });
  });

  it('resolves the repository commit and the server version', () => {
    const p = collectProvenance([], null);
    // A 40-character hex SHA, or the explicit 'unknown' when git is absent —
    // never an empty string, which would silently look like a valid field.
    expect(p.commit).toMatch(/^([0-9a-f]{40}|unknown)$/);
    expect(p.serverVersion).toMatch(/^(\d+\.\d+\.\d+|unknown)$/);
    expect(typeof p.dirty).toBe('boolean');
    expect(p.nodeVersion).toBe(process.version);
  });
});
