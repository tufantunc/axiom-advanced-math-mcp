import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

export function registerPrompts(server: McpServer): void {
  server.prompt(
    'solve-step-by-step',
    'Solve a mathematical expression step by step. Guides the LLM to show intermediate work: parse the expression, simplify, solve, and verify the result.',
    { expression: z.string().describe('The mathematical expression or equation to solve (e.g., "x^2 - 5x + 6 = 0", "int(x^2*sin(x), x)")') },
    ({ expression }) => ({
      messages: [
        {
          role: 'user' as const,
          content: {
            type: 'text' as const,
            text:
              `Solve the following expression step by step, showing all intermediate work:\n\n` +
              `Expression: ${expression}\n\n` +
              `Steps to follow:\n` +
              `1. Parse and identify the type of problem (equation, integral, derivative, etc.)\n` +
              `2. Simplify the expression if possible using compute with: simplify(expression)\n` +
              `3. Apply the appropriate solving method using compute (e.g., solve(...), diff(...), int(...))\n` +
              `4. Verify the result using the verify tool\n` +
              `5. Present the final answer with LaTeX formatting\n\n` +
              `Use the compute tool for each step and verify tool for verification. Show your work clearly.`,
          },
        },
      ],
    }),
  );

  server.prompt(
    'analyze-function',
    'Perform a complete analysis of a mathematical function: domain, derivatives, critical points, inflection points, asymptotes, and integral.',
    {
      expression: z.string().describe('The function to analyze (e.g., "x^3 - 3*x + 2", "sin(x)/x", "ln(x^2+1)")'),
      variable: z.string().describe('The variable (e.g., "x")'),
    },
    ({ expression, variable }) => ({
      messages: [
        {
          role: 'user' as const,
          content: {
            type: 'text' as const,
            text:
              `Perform a complete analysis of the function f(${variable}) = ${expression}\n\n` +
              `Analyze the following aspects using the compute tool:\n\n` +
              `1. **Simplification**: compute with simplify(${expression})\n` +
              `2. **First derivative**: compute with diff(${expression}, ${variable})\n` +
              `3. **Critical points**: compute with solve(diff(${expression}, ${variable})=0, ${variable})\n` +
              `4. **Second derivative**: compute with diff(${expression}, ${variable}, 2)\n` +
              `5. **Inflection points**: Solve second derivative = 0\n` +
              `6. **Limits**: compute with limit(${expression}, ${variable}, inf) and limit(${expression}, ${variable}, -inf)\n` +
              `7. **Integral**: compute with int(${expression}, ${variable})\n` +
              `8. **Taylor series**: compute with taylor(${expression}, ${variable}=0, 5)\n\n` +
              `Present results with LaTeX formatting. Include a summary table of key properties.`,
          },
        },
      ],
    }),
  );

  server.prompt(
    'verify-identity',
    'Verify whether a mathematical identity holds by simplifying both sides and checking if they are equal.',
    {
      lhs: z.string().describe('Left-hand side of the identity (e.g., "sin(x)^2 + cos(x)^2")'),
      rhs: z.string().describe('Right-hand side of the identity (e.g., "1")'),
    },
    ({ lhs, rhs }) => ({
      messages: [
        {
          role: 'user' as const,
          content: {
            type: 'text' as const,
            text:
              `Verify whether the following mathematical identity holds:\n\n` +
              `${lhs} = ${rhs}\n\n` +
              `Use the verify tool with claim: "${lhs} = ${rhs}"\n\n` +
              `Also verify step by step using compute:\n` +
              `1. compute with simplify(${lhs})\n` +
              `2. compute with simplify(${rhs})\n` +
              `3. compute with simplify((${lhs}) - (${rhs}))\n` +
              `4. compute with expand(${lhs}) and expand(${rhs}) for comparison\n\n` +
              `Clearly state whether the identity is TRUE or FALSE, and show the simplification steps.`,
          },
        },
      ],
    }),
  );

  server.prompt(
    'convert-units',
    'Convert a value from one unit to another using the compute tool.',
    {
      value: z.string().describe('The numeric value to convert (e.g., "100")'),
      from_unit: z.string().describe('Source unit (e.g., "km/h", "degF", "lb", "inch")'),
      to_unit: z.string().describe('Target unit (e.g., "m/s", "degC", "kg", "cm")'),
    },
    ({ value, from_unit, to_unit }) => ({
      messages: [
        {
          role: 'user' as const,
          content: {
            type: 'text' as const,
            text:
              `Convert ${value} ${from_unit} to ${to_unit}.\n\n` +
              `Use compute with problem: "${value} ${from_unit} to ${to_unit}"\n\n` +
              `Present the result clearly with both the original and converted values.`,
          },
        },
      ],
    }),
  );

  server.prompt(
    'analyze-dataset',
    'Guide statistical test selection for a dataset. Uses a decision tree (t-test vs ANOVA vs chi-square) based on data type, group count, and study design.',
    {
      description: z.string().describe('Brief description of the dataset and research question (e.g., "comparing exam scores between 2 teaching methods")'),
      groups: z.string().describe('Number of groups or conditions being compared (e.g., "2", "3 or more")'),
      data_type: z.string().describe('Type of dependent variable: "continuous" (heights, scores), "categorical" (yes/no, categories), or "ordinal" (rankings)'),
      design: z.string().optional().describe('Study design: "independent" (different subjects per group) or "repeated" (same subjects measured multiple times)'),
    },
    ({ description, groups, data_type, design }) => ({
      messages: [
        {
          role: 'user' as const,
          content: {
            type: 'text' as const,
            text:
              `I need help selecting the right statistical test for my dataset.\n\n` +
              `**Dataset description**: ${description}\n` +
              `**Number of groups**: ${groups}\n` +
              `**Data type**: ${data_type}\n` +
              (design ? `**Study design**: ${design}\n` : '') +
              `\n` +
              `Please follow this decision process:\n\n` +
              `1. **Identify the measurement level**: Is the outcome continuous, categorical, or ordinal?\n` +
              `2. **Count the groups**: 1 group (one-sample test), 2 groups (two-sample test), 3+ groups (ANOVA or chi-square)\n` +
              `3. **Check independence**: Are measurements independent (different subjects) or paired/repeated?\n` +
              `4. **Check assumptions**: For t-tests and ANOVA, verify normality assumption; for chi-square, check expected cell frequencies ≥ 5\n\n` +
              `**Decision tree**:\n` +
              `- Continuous + 1 group → compute with t_test({...}) using one_sample_t\n` +
              `- Continuous + 2 independent groups → compute with t_test({...}) using two_sample_t\n` +
              `- Continuous + 2 paired groups → compute with t_test({...}) using paired_t\n` +
              `- Continuous + 3+ groups → compute with anova({...}) using one_way_anova\n` +
              `- Categorical + 2 variables → compute with chi_square_test({...})\n\n` +
              `After selecting the test:\n` +
              `- Use the compute tool with the appropriate test type and data\n` +
              `- Report: test statistic, degrees of freedom, p-value, effect size (Cohen's d or η²), and interpretation\n` +
              `- State the conclusion at α = 0.05 significance level`,
          },
        },
      ],
    }),
  );

  server.prompt(
    'solve-ode-system',
    'Set up and solve a system of ordinary differential equations. Guides through problem formulation, CAS solution, stability analysis, and physical interpretation.',
    {
      system: z.string().describe('The ODE system (e.g., "x\'=ax+by, y\'=cx+dy" or "prey-predator model with growth rate r=0.5, death rate d=0.2")'),
      initial_conditions: z.string().optional().describe('Initial conditions (e.g., "x(0)=10, y(0)=5")'),
      variable: z.string().optional().describe('Independent variable (default: t for time)'),
    },
    ({ system, initial_conditions, variable }) => ({
      messages: [
        {
          role: 'user' as const,
          content: {
            type: 'text' as const,
            text:
              `Solve and analyze the following ODE system:\n\n` +
              `**System**: ${system}\n` +
              (initial_conditions ? `**Initial conditions**: ${initial_conditions}\n` : '') +
              `**Independent variable**: ${variable ?? 't'}\n\n` +
              `Follow these steps using the compute tool:\n\n` +
              `1. **Formulate**: Write the system in standard form. Identify order, linearity, and whether it's autonomous.\n\n` +
              `2. **Solve symbolically**: compute with desolve(equation, variable, function) for each equation. For coupled systems, use Giac notation: desolve([eq1,eq2],[f,g])\n\n` +
              `3. **Apply initial conditions**: If initial conditions are given, substitute to find constants of integration.\n\n` +
              `4. **Stability analysis** (for autonomous systems):\n` +
              `   - Find equilibrium points: compute with solve_system([eq1=0, eq2=0], [x, y])\n` +
              `   - Compute the Jacobian eigenvalues: compute with eigenvals([[a,b],[c,d]])\n` +
              `   - Classify each equilibrium: stable node (negative real eigenvalues), saddle (mixed signs), center (imaginary), spiral (complex with nonzero real part)\n\n` +
              `5. **Interpret**: Describe the physical/biological meaning of the solution and stability.\n\n` +
              `6. **Verify**: Use the verify tool to check the solution by substituting back.`,
          },
        },
      ],
    }),
  );

  server.prompt(
    'regression-workflow',
    'Guide through a complete regression analysis: model selection, fitting, diagnostic checks, and interpretation of results.',
    {
      description: z.string().describe('Description of the data and what you want to predict (e.g., "plant growth vs. fertilizer concentration, suspect diminishing returns")'),
      x_description: z.string().describe('Description of the independent variable (predictor)'),
      y_description: z.string().describe('Description of the dependent variable (response)'),
    },
    ({ description, x_description, y_description }) => ({
      messages: [
        {
          role: 'user' as const,
          content: {
            type: 'text' as const,
            text:
              `Perform a complete regression analysis for my dataset.\n\n` +
              `**Study**: ${description}\n` +
              `**X (predictor)**: ${x_description}\n` +
              `**Y (response)**: ${y_description}\n\n` +
              `Follow this regression workflow using the compute tool:\n\n` +
              `**Step 1 — Exploratory analysis**\n` +
              `- Use compute to calculate basic statistics: mean, std, min, max for both X and Y\n` +
              `- Consider the physical relationship: does theory suggest a linear, exponential, power, or logarithmic relationship?\n\n` +
              `**Step 2 — Model selection**\n` +
              `Fit multiple models using compute with linear_regression(...) and compare R²:\n` +
              `- Linear: model="linear" (baseline)\n` +
              `- Polynomial: model="polynomial", degree=2 (try if linear R² < 0.90)\n` +
              `- Exponential: model="exponential" (if Y grows multiplicatively with X)\n` +
              `- Logarithmic: model="logarithmic" (if effect diminishes with X)\n` +
              `- Power: model="power" (if relationship looks like Y = a·Xᵇ on log-log scale)\n\n` +
              `**Step 3 — Evaluate fit**\n` +
              `For each model, examine:\n` +
              `- R² ≥ 0.95: excellent; 0.80–0.95: good; < 0.80: consider other models\n` +
              `- RMSE: lower is better (in same units as Y)\n` +
              `- Check if the equation makes physical sense (correct sign, reasonable magnitude)\n\n` +
              `**Step 4 — Select and report best model**\n` +
              `- Report the winning model equation with coefficients\n` +
              `- Interpret each coefficient in context of the problem\n` +
              `- State the R² and what percentage of variance is explained\n` +
              `- Note any extrapolation risk (predicting outside the range of observed X)`,
          },
        },
      ],
    }),
  );
}
