export interface SymbolicParamDef {
  name: string;
  type: 'string' | 'number' | 'boolean' | 'string[]';
  description: string;
  required: boolean;
  enum?: readonly string[];
  default?: string | number | boolean;
}

export interface SymbolicToolDefinition {
  name: string;
  description: string;
  params: SymbolicParamDef[];
  buildGiacExpression: (args: Record<string, unknown>) => string;
}

export interface SymbolicToolResult {
  expression: string;
  result: string;
  latex?: string;
}
