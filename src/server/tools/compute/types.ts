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
