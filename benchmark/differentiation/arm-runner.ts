import { spawn } from 'child_process';
import { buildCliArgs } from '../providers/claude-code.js';
import { parseClaudeCodeStream } from '../providers/claude-code-stream.js';
import type { Arm } from './arms.js';

export interface ArmRunOptions {
  model: string;
  maxTurns: number;
  axiomMcpPath: string;
  appendSystemPrompt?: string;
  cwd?: string;
  timeoutMs?: number;
}

/** Build the full `claude` argument list for one arm + prompt. Pure. */
export function armCliArgs(prompt: string, arm: Arm, opts: ArmRunOptions): string[] {
  const mcpConfigPath = arm.mcp === 'axiom' ? opts.axiomMcpPath : undefined;
  return [
    '-p',
    prompt,
    ...buildCliArgs({
      model: opts.model,
      maxTurns: opts.maxTurns,
      mcpConfigPath,
      appendSystemPrompt: opts.appendSystemPrompt,
      allowedTools: arm.allowedTools,
    }),
  ];
}

export interface ArmRunResult {
  text: string;
  toolCalls: { name: string; success: boolean }[];
  turns: number;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
  ok: boolean;
}

const DEFAULT_TIMEOUT_MS = Number(process.env.AXIOM_DIFF_TIMEOUT_MS ?? 600_000);

/** Run one prompt through one arm via the claude CLI. Resolves with a result
 *  (ok=false on failure) — never rejects, so one bad call can't abort a matrix. */
export function runArm(prompt: string, arm: Arm, opts: ArmRunOptions): Promise<ArmRunResult> {
  const args = armCliArgs(prompt, arm, opts);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const start = Date.now();
  return new Promise((resolve) => {
    const child = spawn('claude', args, {
      cwd: opts.cwd ?? process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let settled = false;
    const finish = (r: ArmRunResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    const fail = (): void =>
      finish({ text: '', toolCalls: [], turns: 0, inputTokens: 0, outputTokens: 0, durationMs: Date.now() - start, ok: false });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      fail();
    }, timeoutMs);
    child.stdout.on('data', (d: Buffer) => {
      stdout += d.toString();
    });
    child.on('error', fail);
    child.on('close', (code) => {
      const p = parseClaudeCodeStream(stdout.split('\n').filter((l) => l.trim()));
      finish({
        text: p.text,
        toolCalls: p.toolCalls.map((t) => ({ name: t.name, success: t.success })),
        turns: p.turns,
        inputTokens: p.inputTokens,
        outputTokens: p.outputTokens,
        durationMs: Date.now() - start,
        ok: code === 0 && !p.isError,
      });
    });
  });
}
