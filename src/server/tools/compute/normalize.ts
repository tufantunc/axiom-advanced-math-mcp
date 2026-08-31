import type { ComputeEnvelope, McpResponse, ResultType, VerificationInfo } from './types.js';
import { splitTopLevel } from '../output-cleanup.js';

// ---------------------------------------------------------------------------
// Result type mapping — handler key → result type
// ---------------------------------------------------------------------------

const RESULT_TYPE_MAP: Record<string, ResultType> = {
  'calculus:differentiate': 'symbolic',
  'calculus:integrate': 'symbolic',
  'calculus:integrate_definite': 'scalar',
  'calculus:limit': 'scalar',
  'calculus:taylor': 'symbolic',
  'calculus:solve_ode': 'function',
  'algebra:factor': 'symbolic',
  'algebra:simplify': 'symbolic',
  'algebra:expand': 'symbolic',
  'algebra:partial_fractions': 'symbolic',
  solve_equation: 'set',
  solve_system: 'set',
  matrix: 'matrix',
  'matrix:determinant': 'scalar',
  'matrix:rank': 'scalar',
  'matrix:norm_frobenius': 'scalar',
  'matrix:norm_1': 'scalar',
  'matrix:norm_inf': 'scalar',
  'matrix:condition_number': 'scalar',
  number_theory: 'scalar',
  combinatorics: 'scalar',
  probability: 'distribution',
  hypothesis_testing: 'test_result',
  numerical_methods: 'steps',
  geometry: 'scalar',
  exact_value: 'scalar',
  quick_calc: 'scalar',
  giac_raw: 'symbolic',
  fourier: 'symbolic',
  linear_regression: 'function',
  number_properties: 'scalar',
  sequence_identify: 'symbolic',
};

/**
 * Determine the result_type from the handler name and its args.
 */
function resolveResultType(handler: string, args: Record<string, unknown>): ResultType {
  const operation = args.operation as string | undefined;

  // Check specific handler:operation combination first
  if (operation) {
    const specific = `${handler}:${operation}`;
    if (specific in RESULT_TYPE_MAP) return RESULT_TYPE_MAP[specific];
  }

  // Check if it's a definite integral (has bounds)
  if (handler === 'calculus' && operation === 'integrate') {
    if (args.lower_bound !== undefined && args.upper_bound !== undefined) {
      return 'scalar';
    }
  }

  return RESULT_TYPE_MAP[handler] || 'symbolic';
}

// ---------------------------------------------------------------------------
// Parse MCP text response lines
// ---------------------------------------------------------------------------

interface ParsedFields {
  result: string;
  decimal?: string;
  latex?: string;
  giacCommand?: string;
  notes: string[];
  verification?: VerificationInfo;
}

function parseResponseLines(response: McpResponse): ParsedFields {
  const lines = response.content.filter((c) => c.type === 'text').map((c) => c.text);

  const fields: ParsedFields = {
    result: '',
    notes: [],
  };

  for (const line of lines) {
    if (line.startsWith('Result: ')) {
      fields.result = line.slice('Result: '.length);
    } else if (line.startsWith('Decimal: ')) {
      fields.decimal = line.slice('Decimal: '.length);
    } else if (line.startsWith('LaTeX: ')) {
      fields.latex = line.slice('LaTeX: '.length);
    } else if (line.startsWith('Command: ')) {
      fields.giacCommand = line.slice('Command: '.length);
    } else if (line.startsWith('Verified: ')) {
      const rest = line.slice('Verified: '.length).trim();
      fields.verification = {
        status: rest.startsWith('✓') ? 'verified' : 'failed',
        check: rest.replace(/^[✓✗]\s*/, ''),
      };
    } else if (line.startsWith('Method: ')) {
      // Informational model-facing note — not surfaced in the envelope.
    } else if (line.startsWith('The answer is ')) {
      // Summary line — skip (we use structured fields)
    } else if (line.trim() !== '') {
      fields.notes.push(line);
    }
  }

  return fields;
}

// ---------------------------------------------------------------------------
// Build structured data from parsed fields
// ---------------------------------------------------------------------------

function buildData(resultType: ResultType, fields: ParsedFields): Record<string, unknown> {
  switch (resultType) {
    case 'scalar':
      return {
        value: fields.result,
        ...(fields.decimal ? { decimal: fields.decimal } : {}),
      };

    case 'symbolic':
      return { expression: fields.result };

    case 'set': {
      let solutions = [fields.result];
      const trimmed = fields.result.trim();
      const setMatch =
        /^\{(.+)\}$/.exec(trimmed) ||
        /^\[(.+)\]$/.exec(trimmed) ||
        /^list\[(.+)\]$/.exec(trimmed) ||
        /^list\((.+)\)$/.exec(trimmed);
      if (setMatch) {
        solutions = splitTopLevel(setMatch[1], ',').map((s) => s.trim());
      }
      return { solutions, count: solutions.length };
    }

    case 'matrix':
      return { matrix: fields.result };

    case 'function':
      return { definition: fields.result };

    case 'distribution':
      return { result: fields.result, details: fields.notes };

    case 'test_result':
      return { summary: fields.result, details: fields.notes };

    case 'boolean':
      return {
        value: fields.result.toLowerCase() === 'true' || fields.result === '1',
      };

    case 'steps':
      return { steps: fields.notes, final_result: fields.result };

    default:
      return { value: fields.result };
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Normalize a raw MCP handler response into a structured ComputeEnvelope.
 */
export function normalize(
  response: McpResponse,
  handler: string,
  args: Record<string, unknown>
): ComputeEnvelope {
  if (response.isError) {
    const errorText = response.content
      .filter((c) => c.type === 'text')
      .map((c) => c.text)
      .join('\n');
    return {
      success: false,
      result_type: 'scalar',
      display: errorText,
      data: { error: errorText },
      method: handler,
    };
  }

  const fields = parseResponseLines(response);
  const resultType = resolveResultType(handler, args);
  const data = buildData(resultType, fields);

  return {
    success: true,
    result_type: resultType,
    display: fields.result || response.content.map((c) => c.text).join('\n'),
    ...(fields.latex ? { latex: fields.latex } : {}),
    data,
    method: handler,
    ...(fields.giacCommand ? { giac_command: fields.giacCommand } : {}),
    ...(fields.verification ? { verification: fields.verification } : {}),
  };
}
