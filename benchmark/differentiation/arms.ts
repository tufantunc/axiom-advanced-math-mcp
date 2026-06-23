export type ArmName = 'pure-model' | 'code-exec' | 'axiom';

export interface Arm {
  name: ArmName;
  /** Passed to claude `--allowed-tools` (allowlist). Restricts the arm to its
   *  intended backend so accuracy is attributable. */
  allowedTools: string[];
  /** Which MCP server to attach. */
  mcp: 'none' | 'axiom';
}

export const ARMS: Arm[] = [
  // 'mcp__none' is an unattached server → grants zero usable tools (pure model).
  { name: 'pure-model', allowedTools: ['mcp__none'], mcp: 'none' },
  { name: 'code-exec', allowedTools: ['Bash'], mcp: 'none' },
  { name: 'axiom', allowedTools: ['mcp__axiom'], mcp: 'axiom' },
];
