/**
 * Build a deterministic fix_attempt for a verify result.
 *
 * The model is instructed in the system prompt to issue exactly the call
 * named in fix_attempt.next_call when verified=false. Generating these
 * deterministically (rather than free-form "try something") keeps retries
 * bounded and predictable.
 */

export interface FixAttempt {
  next_call: { tool: string; args: Record<string, unknown> };
  rationale: string;
}

export type ParsedClaimForFix =
  | { verified: boolean; type: 'identity'; lhs: string; rhs: string }
  | {
      verified: boolean;
      type: 'solution';
      variable: string;
      value: string;
      equation: string;
    }
  | { verified: boolean; type: 'unknown' };

export function buildFixAttempt(parsed: ParsedClaimForFix): FixAttempt | undefined {
  if (parsed.verified) return undefined;

  if (parsed.type === 'identity') {
    return {
      next_call: { tool: 'compute', args: { problem: `simplify(${parsed.lhs})` } },
      rationale:
        `Identity check failed. Recompute the LHS via compute → simplify, ` +
        `then verify the result matches the claimed RHS.`,
    };
  }

  if (parsed.type === 'solution') {
    return {
      next_call: {
        tool: 'compute',
        args: { problem: `solve(${parsed.equation}, ${parsed.variable})` },
      },
      rationale:
        `Substitution did not satisfy the equation. Solve directly to find ` +
        `the actual root(s), then re-verify.`,
    };
  }

  return undefined;
}
