// src/server/tools/multivariable/index.ts
import { formatErrorResponse } from '../response-formatter.js';
import { operatorHandler } from './operators.js';
import { integralHandler } from './integrals.js';
import { optimizationHandler } from './optimization.js';

const OPERATOR_OPS = new Set(['gradient', 'hessian', 'jacobian', 'divergence', 'curl', 'partial']);
const OPTIMIZATION_OPS = new Set([
  'critical_points',
  'lagrange',
  'tangent_plane',
  'directional_derivative',
]);

export async function multivariableHandler(args: Record<string, unknown>) {
  const operation = args.operation as string;
  if (OPERATOR_OPS.has(operation)) return operatorHandler(args);
  if (operation === 'multiple_integral') return integralHandler(args);
  if (OPTIMIZATION_OPS.has(operation)) return optimizationHandler(args);
  return formatErrorResponse(`Unknown multivariable operation: ${operation}`);
}
