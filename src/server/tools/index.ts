// --- Primary tool exports (3-tool architecture) ---
export { computeSchema, computeHandler } from './compute/index.js';
export { verifySchema, verifyHandler } from './verify/index.js';
export { registerPlotTools } from './plot/index.js';

// --- Internal handler exports (used by compute dispatcher) ---
export { quickCalcHandler } from './quick-calc.js';
export { quickCalcToolSchema } from './quick-calc-schema.js';
export { advancedSolveHandler } from './advanced-solve.js';
export { advancedSolveToolSchema } from './advanced-solve-schema.js';
export { calculusSchema, calculusHandler } from './calculus.js';
export { algebraSchema, algebraHandler } from './algebra.js';
export {
  solveEquationSchema,
  solveEquationHandler,
  solveSystemSchema,
  solveSystemHandler,
} from './solve.js';
export { matrixSchema, matrixHandler } from './matrix.js';
export { numberTheorySchema, numberTheoryHandler } from './number-theory.js';
export { combinatoricsSchema, combinatoricsHandler } from './combinatorics.js';
export { probabilityCalcSchema, probabilityCalcHandler } from './probability-calc.js';
export { hypothesisTestingSchema, hypothesisTestingHandler } from './hypothesis-testing.js';
export { numericalMethodsSchema, numericalMethodsHandler } from './numerical-methods.js';
export { geometrySchema, geometryHandler } from './geometry.js';
export { exactValueSchema, exactValueHandler } from './exact-value.js';
