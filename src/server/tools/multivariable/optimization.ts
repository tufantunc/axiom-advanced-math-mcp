import { giacEngine } from '../../giac/index.js';
import { formatToolResponse, formatErrorResponse } from '../response-formatter.js';
import { validateExpression } from '../expression-validator.js';
import { toLatex } from '../giac-eval.js';

/** Build a Giac substitution list "[x=1,y=2]" from variables + point values. */
function substList(variables: string[], point: string[]): string {
  return `[${variables.map((v, i) => `${v}=${point[i]}`).join(',')}]`;
}

/** Evaluate a Giac expression, throwing on undef/empty. */
async function giac(expr: string): Promise<string> {
  const out = await giacEngine.evaluate(expr);
  if (!out || out === 'undef') throw new Error(`Giac could not evaluate: ${expr}`);
  return out;
}

/**
 * Parse a Giac solve()-with-variable-list result into coordinate tuples.
 * Giac returns "[[0,0]]" (list of solution vectors). Strips one outer bracket
 * layer and splits each inner vector on top-level commas.
 */
function parseSolutionPoints(raw: string): string[][] {
  const trimmed = raw.replace(/^list/, '').trim();
  const inner = trimmed
    .replace(/^[[(]/, '')
    .replace(/[\])]$/, '')
    .trim();
  if (!inner) return [];
  const points: string[][] = [];
  let depth = 0;
  let current = '';
  const flush = () => {
    const coords = current
      .replace(/^\[/, '')
      .replace(/\]$/, '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (coords.length) points.push(coords);
    current = '';
  };
  for (const ch of inner) {
    if (ch === '[') {
      depth++;
      current += ch;
    } else if (ch === ']') {
      depth--;
      current += ch;
    } else if (ch === ',' && depth === 0) {
      flush();
    } else {
      current += ch;
    }
  }
  if (current.trim()) flush();
  return points;
}

export async function optimizationHandler(args: Record<string, unknown>) {
  try {
    const operation = args.operation as string;
    if (!operation) return formatErrorResponse("'operation' is required");
    const expression = args.expression as string;
    const variables = (args.variables as string[]) ?? [];

    if (!expression) return formatErrorResponse(`'expression' is required for ${operation}`);
    if (variables.length === 0)
      return formatErrorResponse(`'variables' is required for ${operation}`);
    const validation = validateExpression(expression);
    if (validation) return formatErrorResponse(validation.message);

    if (operation === 'tangent_plane') {
      const point = (args.point as string[]) ?? [];
      if (point.length !== variables.length) {
        return formatErrorResponse("'point' length must match 'variables' length");
      }
      const sub = substList(variables, point);
      const f0 = await giac(`subst(${expression},${sub})`);
      const terms: string[] = [f0];
      // O(n+1) Giac calls by design: one per partial derivative + one final simplify.
      for (let i = 0; i < variables.length; i++) {
        const slope = await giac(`subst(diff(${expression},${variables[i]}),${sub})`);
        terms.push(`(${slope})*(${variables[i]}-(${point[i]}))`);
      }
      const plane = await giac(`simplify(${terms.join('+')})`);
      const latex = await toLatex(plane);
      return formatToolResponse({
        result: `z = ${plane}`,
        latex,
        notes: [`Expansion point: (${point.join(', ')})`, `f at point = ${f0}`],
      });
    }

    if (operation === 'directional_derivative') {
      const point = (args.point as string[]) ?? [];
      const direction = (args.direction as string[]) ?? [];
      if (point.length !== variables.length) {
        return formatErrorResponse("'point' length must match 'variables' length");
      }
      if (direction.length !== variables.length) {
        return formatErrorResponse("'direction' length must match 'variables' length");
      }
      const sub = substList(variables, point);
      const norm = await giac(`sqrt(${direction.map((d) => `(${d})^2`).join('+')})`);
      if (norm === '0') return formatErrorResponse('direction vector cannot be zero');
      const parts: string[] = [];
      for (let i = 0; i < variables.length; i++) {
        const gi = await giac(`subst(diff(${expression},${variables[i]}),${sub})`);
        parts.push(`(${gi})*(${direction[i]})`);
      }
      const dv = await giac(`simplify((${parts.join('+')})/(${norm}))`);
      const latex = await toLatex(dv);
      return formatToolResponse({
        result: dv,
        latex,
        notes: [
          `Point: (${point.join(', ')})`,
          `Direction: [${direction.join(', ')}]`,
          `‖direction‖ = ${norm}`,
        ],
      });
    }

    // Classification via the second-derivative test is supported for exactly 2 variables by design:
    // D = f_xx*f_yy - f_xy^2 is the standard 2-variable discriminant; the n-variable case would require full Hessian analysis.
    if (operation === 'critical_points') {
      if (variables.length !== 2) {
        return formatErrorResponse(
          'critical_points classification is supported for exactly 2 variables'
        );
      }
      const [x, y] = variables;
      const stationary = `[diff(${expression},${x}),diff(${expression},${y})]`;
      const grad = await giac(stationary);
      const raw = await giac(`solve(${stationary},[${x},${y}])`);
      if (!/^\s*(list)?\s*[[(]/.test(raw)) {
        return formatErrorResponse(`Could not parse solve output: ${raw}`);
      }
      const points = parseSolutionPoints(raw);
      if (points.length === 0) {
        return formatToolResponse({
          result: 'No critical points in the real domain',
          notes: [`Gradient: ${grad}`, `solve returned: ${raw}`],
        });
      }

      // Second-derivative test symbols.
      const fxx = `diff(${expression},${x},2)`;
      const fyy = `diff(${expression},${y},2)`;
      const fxy = `diff(diff(${expression},${x}),${y})`;
      const discriminant = `(${fxx})*(${fyy})-(${fxy})^2`;

      const classified: string[] = [];
      for (const pt of points) {
        const sub = substList(variables, pt);
        const Dexact = await giac(`subst(${discriminant},${sub})`);
        const fxxExact = await giac(`subst(${fxx},${sub})`);
        const dNum = Number(await giac(`evalf(${Dexact})`));
        const fxxNum = Number(await giac(`evalf(${fxxExact})`));
        let kind: string;
        if (!Number.isFinite(dNum)) kind = 'inconclusive (could not evaluate discriminant)';
        else if (dNum === 0) kind = 'inconclusive (second-derivative test fails, D=0)';
        else if (dNum < 0) kind = 'saddle point';
        else if (!Number.isFinite(fxxNum)) kind = 'inconclusive (could not evaluate f_xx)';
        else if (fxxNum > 0) kind = 'local minimum';
        else kind = 'local maximum';
        classified.push(`(${pt.join(', ')}): ${kind} [D=${Dexact}, f_xx=${fxxExact}]`);
      }

      return formatToolResponse({
        result: classified.join('; '),
        notes: [`Gradient: ${grad}`, `Discriminant D = f_xx*f_yy - f_xy^2`, ...classified],
      });
    }

    if (operation === 'lagrange') {
      const constraint = args.constraint as string;
      const value = (args.value as string) ?? '0';
      if (!constraint) return formatErrorResponse("'constraint' is required for lagrange");
      const cValidation = validateExpression(constraint);
      if (cValidation) return formatErrorResponse(cValidation.message);

      // Stationarity: grad(f) = L*grad(g) componentwise, plus constraint g = value.
      const stationarity = variables.map(
        (v) => `diff(${expression},${v})=L*diff(${constraint},${v})`
      );
      const system = `[${stationarity.join(',')},${constraint}=${value}]`;
      const unknowns = `[${variables.join(',')},L]`;
      const raw = await giac(`solve(${system},${unknowns})`);

      const candidates = parseSolutionPoints(raw);
      if (candidates.length === 0) {
        return formatToolResponse({
          result: 'No stationary points found in the real domain',
          notes: [`System: ${system}`, `solve returned: ${raw}`],
        });
      }

      // Report each candidate point (dropping the trailing lambda) and the objective value there.
      const reported: string[] = [];
      for (const cand of candidates) {
        if (cand.length < variables.length) continue;
        const coords = cand.slice(0, variables.length);
        const sub = substList(variables, coords);
        const fVal = await giac(`subst(${expression},${sub})`);
        reported.push(`(${coords.join(', ')}): f = ${fVal}`);
      }

      if (reported.length === 0) {
        return formatToolResponse({
          result: 'No usable stationary points parsed from solve output',
          notes: [`solve returned: ${raw}`],
        });
      }

      return formatToolResponse({
        result: reported.join('; '),
        notes: [
          `Constraint: ${constraint} = ${value}`,
          `Candidates (Lagrange):`,
          ...reported,
          'Note: Lagrange yields stationary points of the constrained problem; compare f values or check second-order conditions to classify max/min/saddle.',
        ],
      });
    }

    return formatErrorResponse(`Unknown optimization operation: ${operation}`);
  } catch (error) {
    return formatErrorResponse(error instanceof Error ? error.message : String(error));
  }
}
