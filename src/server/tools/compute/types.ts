export type ResultType =
  | 'scalar'
  | 'symbolic'
  | 'set'
  | 'matrix'
  | 'boolean'
  | 'function'
  | 'distribution'
  | 'test_result'
  | 'steps';

export interface VerificationInfo {
  status: 'verified' | 'failed' | 'skipped';
  check?: string;
}

export interface ComputeEnvelope {
  success: boolean;
  result_type: ResultType;
  display: string;
  latex?: string;
  data: Record<string, unknown>;
  method: string;
  verification?: VerificationInfo;
  giac_command?: string;
  /** Hygiene-layer notices (e.g., "empty result", "Giac error"). */
  warnings?: string[];
  /**
   * For a vector answer, which function each component is.
   *
   * `desolve([y'=z, z'=-y], x)` returns `[[cos(x),-sin(x)]]`, which is
   * uninterpretable without knowing that component 0 is y. The text format
   * carried that as prose, so `--json`, `--quiet` and `--latex` dropped it.
   */
  components?: string[];
}

export interface RouteResult {
  handler: string;
  args: Record<string, unknown>;
}

export interface RouterRule {
  name: string;
  test: (problem: string, domain?: string) => boolean;
  extract: (problem: string, domain?: string) => RouteResult;
}

export type McpResponse = {
  content: { type: 'text'; text: string }[];
  isError: boolean;
};
