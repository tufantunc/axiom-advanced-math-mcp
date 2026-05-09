import { calculusHandler } from '../calculus.js';
import { algebraHandler } from '../algebra.js';
import { solveEquationHandler, solveSystemHandler } from '../solve.js';
import { matrixHandler } from '../matrix.js';
import { numberTheoryHandler } from '../number-theory.js';
import { combinatoricsHandler } from '../combinatorics.js';
import { probabilityCalcHandler } from '../probability-calc.js';
import { hypothesisTestingHandler } from '../hypothesis-testing.js';
import { numericalMethodsHandler } from '../numerical-methods.js';
import { geometryHandler } from '../geometry.js';
import { exactValueHandler } from '../exact-value.js';
import { quickCalcHandler } from '../quick-calc.js';
import { advancedSolveHandler } from '../advanced-solve.js';
import { fourierTransformHandler } from '../fourier-transform.js';
import { linearRegressionHandler } from '../linear-regression.js';
import { numberPropertiesHandler } from '../number-properties.js';
import { sequenceIdentifyHandler } from '../sequence-identify.js';

type McpResponse = {
  content: { type: 'text'; text: string }[];
  isError: boolean;
};

/**
 * Dispatch to an existing handler by key.
 * Returns the raw MCP response from the handler.
 */
export async function dispatch(
  handler: string,
  args: Record<string, unknown>
): Promise<McpResponse> {
  switch (handler) {
    case 'calculus':
      return (await calculusHandler(args)) as McpResponse;

    case 'algebra':
      return (await algebraHandler(args)) as McpResponse;

    case 'solve_equation':
      return (await solveEquationHandler(args)) as McpResponse;

    case 'solve_system':
      return (await solveSystemHandler(args)) as McpResponse;

    case 'matrix':
      return (await matrixHandler(args)) as McpResponse;

    case 'number_theory':
      return (await numberTheoryHandler(args)) as McpResponse;

    case 'combinatorics':
      return (await combinatoricsHandler(args)) as McpResponse;

    case 'probability':
      return (await probabilityCalcHandler(args)) as McpResponse;

    case 'hypothesis_testing':
      return (await hypothesisTestingHandler(args)) as McpResponse;

    case 'numerical_methods':
      return (await numericalMethodsHandler(args)) as McpResponse;

    case 'geometry':
      return (await geometryHandler(args)) as McpResponse;

    case 'exact_value':
      return (await exactValueHandler(args)) as McpResponse;

    case 'quick_calc':
      return (await quickCalcHandler(args)) as McpResponse;

    case 'fourier':
      return (await fourierTransformHandler(args)) as McpResponse;

    case 'linear_regression':
      return (await linearRegressionHandler(args)) as McpResponse;

    case 'number_properties':
      return (await numberPropertiesHandler(args)) as McpResponse;

    case 'sequence_identify':
      return (await sequenceIdentifyHandler(args)) as McpResponse;

    case 'giac_raw':
    default:
      return (await advancedSolveHandler(args)) as McpResponse;
  }
}
