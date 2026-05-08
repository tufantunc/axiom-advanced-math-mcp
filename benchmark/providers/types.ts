export interface NeutralTool {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties?: Record<string, unknown>;
    required?: string[];
    [key: string]: unknown;
  };
}

export interface ToolCallRecord {
  name: string;
  args: Record<string, unknown>;
  result: string;
  success: boolean;
}

export interface BaselineResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
}

export interface ToolAugmentedResult {
  text: string;
  toolCalls: ToolCallRecord[];
  turns: number;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
}

export interface LLMProvider {
  readonly name: string;
  readonly model: string;

  runBaseline(
    problem: string,
    maxTokens: number,
    temperature?: number
  ): Promise<BaselineResult>;

  runWithTools(
    problem: string,
    tools: NeutralTool[],
    callTool: (name: string, args: Record<string, unknown>) => Promise<string>,
    maxTokens: number,
    maxTurns: number,
    temperature?: number
  ): Promise<ToolAugmentedResult>;
}
