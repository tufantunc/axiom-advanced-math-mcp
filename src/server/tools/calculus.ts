import { formatErrorResponse } from './response-formatter.js';
import { validateExpression } from './expression-validator.js';
import { evalWithLatex } from './giac-eval.js';
import { detectFailure } from './compute/silent-failure.js';
import { giacEngine } from '../giac/index.js';
import { verifyIntegrate, verifyOdeSystem } from './self-verify.js';
import { parseOdeSystem } from './ode-system-shape.js';
import { translateOdeSystem } from './ode-system.js';

function buildSimpleCommand(operation: string, args: Record<string, unknown>): string {
  switch (operation) {
    case 'differentiate': {
      const expr = args.expression as string;
      const v = args.variable as string;
      const ord = args.order as number | undefined;
      if (ord && ord > 1) return `diff(${expr},${v},${ord})`;
      return `diff(${expr},${v})`;
    }
    case 'integrate': {
      const expr = args.expression as string;
      const v = args.variable as string;
      const lo = args.lower_bound as string | undefined;
      const hi = args.upper_bound as string | undefined;
      if (lo !== undefined && hi !== undefined) return `int(${expr},${v},${lo},${hi})`;
      return `int(${expr},${v})`;
    }
    case 'limit': {
      const expr = args.expression as string;
      const v = args.variable as string;
      const pt = args.point as string;
      const dir = args.direction as string | undefined;
      if (dir) return `limit(${expr},${v},${pt},${dir === '+' ? '1' : '-1'})`;
      return `limit(${expr},${v},${pt})`;
    }
    case 'taylor': {
      const expr = args.expression as string;
      const v = args.variable as string;
      const pt = (args.point as string) ?? '0';
      const n = (args.order as number) ?? 5;
      return `taylor(${expr},${v}=${pt},${n})`;
    }
    case 'solve_ode': {
      const eq = args.equation as string;
      const v = (args.variable as string) ?? 'x';
      const fn = (args.function_name as string) ?? 'y';
      const ic = args.initial_conditions as string | undefined;
      if (ic) return `desolve([${eq},${ic}],${v},${fn})`;
      return `desolve(${eq},${v},${fn})`;
    }
    default:
      throw new Error(`Unknown calculus operation: ${operation}`);
  }
}

interface BuiltCommand {
  expr: string;
  /** Present only for a rewritten system: the functions, in component order. */
  functions?: string[];
  /** Present only for a rewritten system: what the answer is checked against. */
  system?: {
    matrix: string;
    constants: string;
    variable: string;
    condition?: string;
  };
}

/**
 * The single place an operation becomes a Giac command.
 *
 * Async because one case needs the CAS to build its command: a list-form ODE
 * system is rewritten into the matrix form Giac solves, which takes a probe for
 * the coefficient matrix. Keeping that here rather than in the handler is what
 * lets `calculusHandler` stay a linear validate -> build -> eval pipeline.
 */
async function buildGiacExpression(
  operation: string,
  args: Record<string, unknown>
): Promise<BuiltCommand> {
  if (operation === 'solve_ode') {
    const system = parseOdeSystem(args.equation as string);
    if (system) {
      const translated = await translateOdeSystem(
        system,
        (args.variable as string) ?? 'x',
        giacEngine
      );
      // Thrown, not returned: the handler's existing catch turns it into
      // formatErrorResponse, which is this file's convention for a command that
      // cannot be built.
      if ('error' in translated) {
        throw new Error(`solve_ode cannot solve this system — it ${translated.error}`);
      }
      return {
        expr: translated.command,
        functions: translated.functions,
        system: {
          matrix: translated.matrix,
          constants: translated.constants,
          variable: (args.variable as string) ?? 'x',
          ...(translated.condition ? { condition: translated.condition } : {}),
        },
      };
    }
  }
  return { expr: buildSimpleCommand(operation, args) };
}

function validateParams(operation: string, args: Record<string, unknown>): string | null {
  switch (operation) {
    case 'differentiate':
      if (!args.expression) return "'expression' is required for differentiate";
      if (!args.variable) return "'variable' is required for differentiate";
      return null;
    case 'integrate':
      if (!args.expression) return "'expression' is required for integrate";
      if (!args.variable) return "'variable' is required for integrate";
      return null;
    case 'limit':
      if (!args.expression) return "'expression' is required for limit";
      if (!args.variable) return "'variable' is required for limit";
      if (!args.point) return "'point' is required for limit";
      return null;
    case 'taylor':
      if (!args.expression) return "'expression' is required for taylor";
      if (!args.variable) return "'variable' is required for taylor";
      return null;
    case 'solve_ode': {
      if (!args.equation) return "'equation' is required for solve_ode";
      // Refused, not ignored. The extractor folds the arguments it recognises —
      // identifiers name the variable and the function, `y(0)=1` shapes are
      // conditions — and reports the first it does not, because dropping one is
      // how `desolve(y'=y, y(0)=1)` came to answer the general solution as if it
      // satisfied the condition.
      const unsupported = args.unsupported_argument;
      if (typeof unsupported === 'string') {
        return (
          `solve_ode does not understand the argument "${unsupported.slice(0, 60)}" — ` +
          'give the equation, then any conditions as y(0)=1, then the variable ' +
          "and the function, as in desolve(y'=y, y(0)=1, x, y)"
        );
      }
      return null;
    }
    default:
      return `Unknown operation: ${operation}`;
  }
}

export async function calculusHandler(args: Record<string, unknown>) {
  try {
    const operation = args.operation as string;

    const paramError = validateParams(operation, args);
    if (paramError) return formatErrorResponse(paramError);

    const exprToValidate =
      operation === 'solve_ode' ? (args.equation as string) : (args.expression as string);
    const validationError = validateExpression(exprToValidate);
    if (validationError) return formatErrorResponse(validationError.message);

    const { expr: giacExpr, functions, system } = await buildGiacExpression(operation, args);
    // From the translation, not a second parse of the caller's text. Re-running
    // unicodeToAscii, splitTopLevel and classify over the whole argument to
    // recover one boolean also made this handler depend on the parser's
    // internals rather than on what buildGiacExpression handed back — and two
    // independent computations over the same string can disagree.
    const hasConditions = system?.condition !== undefined;
    const isIndefiniteIntegral =
      operation === 'integrate' && args.lower_bound === undefined && args.upper_bound === undefined;
    // A rewritten system is checked against Y' = A*Y + b. The shape guards below
    // catch an answer that is visibly not one (`[]`, `undef`, `poly1[`); this
    // catches one that looks entirely ordinary and simply is not a solution.
    const verify = isIndefiniteIntegral
      ? (result: string) =>
          verifyIntegrate(args.expression as string, args.variable as string, result)
      : system
        ? (result: string) =>
            verifyOdeSystem(
              system.matrix,
              system.constants,
              system.variable,
              result,
              (expr: string) => giacEngine.evaluate(expr),
              system.condition
            )
        : undefined;
    // Through `notes`, not appended to the formatted content: formatToolResponse
    // owns line order and puts notes before the "The answer is" summary. Pushed
    // onto content it landed after the sentence presenting the answer, which for
    // an IVP is the only thing saying which component is which.
    const response = await evalWithLatex({
      giacExpr,
      operation,
      verify,
      ...(functions ? { notes: [`Components are in the order: ${functions.join(', ')}`] } : {}),
    });
    if (functions) {
      // `undef` as a whole token is what fixes the observed case: matching it as
      // a substring refused `[y'=k_undefined*z, z'=-y]`, which Giac solves
      // correctly, because the coefficient's NAME contains it.
      //
      // Reading only the Result line is defence in depth, not that fix — the
      // other two sentinels carry punctuation (`poly1[`, `ilaplace(`) so a bare
      // coefficient named `ilaplace_k` does not trip them either. It is here
      // because the `Command:` line echoes caller text and a sentinel added
      // later may not be as punctuated.
      const resultLine = /^Result:\s*(.*)$/m.exec(response.content.map((c) => c.text).join('\n'));
      const result = resultLine?.[1]?.trim() ?? '';
      // The shared detector decides the three checks it already owns — an empty
      // result, a GIAC_ERROR, and a non-finite token — and this path adds only
      // what is specific to a solution VECTOR. Re-deriving them here had let the
      // two drift: `detectFailure` token-matches `NaN`, `Inf` and `-Inf`, and this
      // copy did not, so a non-finite component would have shipped as a solution.
      //
      // It is given a synthesized `Result:` line rather than the whole response,
      // which is what keeps an earlier fix: the `Command:` line echoes the
      // caller's own text, so scanning the full response refused
      // `[y'=k_undefined*z, z'=-y]` for a coefficient's NAME.
      //
      // `infinity` stays local. It is not a failure in general — `integrate(1/x^2,
      // x, 0, 1)` correctly diverges to `+infinity` and detectFailure is right to
      // pass it — but neither an infinite COMPONENT of a solution vector nor an
      // `integrate(…,0,+infinity)` the engine never evaluated is a solution.
      // Token-matched so a coefficient named `infinity_k` is not caught by its own
      // name.
      //
      // Reached by `[y'=z, z'=-y+x^x]`, which answers `[[infinity,infinity]]`, and
      // by four forcing terms that come back with an unevaluated
      // `integrate(…,x,0,+infinity)`: exp(exp(x)), Gamma(x), log(x)^2,
      // exp(x)*sin(exp(x)). The pole rule cannot refuse any of them — `denom(x^x)`
      // does not mention x, and none is tan/cotan/tanh — so this arm is the only
      // guard on that answer. An earlier version of this comment called the arm
      // unreachable; `x^x` was the counterexample, and the row named
      // 'refuses an infinite solution component' in handler-seam.test.ts pins it.
      //
      // `ilaplace(` has never been observed without `poly1[` beside it — over 120
      // random matrices and every shape tried here — so no input discriminates
      // that arm and no test can pin it. Recorded so the next reader does not go
      // looking for the test that is missing.
      const unfinished =
        detectFailure(`Result: ${result}`) !== null ||
        /poly1\[|ilaplace\(/.test(result) ||
        /(^|[^A-Za-z_0-9])infinity([^A-Za-z_0-9]|$)/.test(result);
      // Reachable again. This branch was removed when verifyOdeSystem could only
      // say ✓ or nothing; it can now prove failure for an exact system, and a
      // disproved answer must not ship — `[y'=z, z'=-y+sqrt(x)]` was going out as
      // the homogeneous solution with success:true.
      //
      // Read from the value, not from the rendered glyph. Testing for `Verified: ✗`
      // coupled this guard to a display character: renaming the label or
      // reordering the formatter would have stopped it firing silently.
      const disproved = response.verification?.verified === false;
      if (unfinished || disproved) {
        // The initial-condition hint only when there were any: a 10-equation
        // cycle with none was being told to check conditions it never supplied.
        if (disproved && !unfinished) {
          return formatErrorResponse(
            'solve_ode cannot solve this system — the CAS returned an answer that ' +
              'does not satisfy it'
          );
        }
        const hint = hasConditions ? '; check the initial conditions' : '';
        return formatErrorResponse(
          `solve_ode cannot solve this system — the CAS could not finish it${hint}`
        );
      }
    }
    return response;
  } catch (error) {
    return formatErrorResponse(error instanceof Error ? error.message : String(error));
  }
}
