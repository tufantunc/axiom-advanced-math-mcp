import { spawn } from 'child_process';
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import type {
  LLMProvider,
  NeutralTool,
  BaselineResult,
  ToolAugmentedResult,
  ToolCallRecord,
} from './types.js';
import { parseClaudeCodeStream } from './claude-code-stream.js';

const DEFAULT_TIMEOUT_MS = Number(process.env.AXIOM_CC_TIMEOUT_MS ?? 600_000);

export interface CliArgOptions {
  model: string;
  maxTurns: number;
  mcpConfigPath?: string;
}

/** Build the claude CLI argument list (prompt is passed separately via -p). */
export function buildCliArgs(opts: CliArgOptions): string[] {
  const args = [
    '--model', opts.model,
    '--output-format', 'stream-json',
    '--verbose',
    '--max-turns', String(opts.maxTurns),
    '--dangerously-skip-permissions',
    // Isolation (probe-verified): without these, user-level hooks, plugins
    // and MCP servers leak into the session even in an empty cwd.
    '--setting-sources', 'project',
    '--strict-mcp-config',
  ];
  if (opts.mcpConfigPath) {
    args.push('--mcp-config', opts.mcpConfigPath);
  }
  return args;
}

export interface McpConfig {
  mcpServers: Record<string, { command: string; args: string[] }>;
}

/** Translate the harness's mcpServerCmd into a Claude Code MCP config.
 *  The CLI runs in a temp cwd, so every path must be absolute. */
export function buildMcpConfig(serverCmd: string[], basedir: string): McpConfig {
  const [cmd, ...rest] = serverCmd;
  const command = cmd.includes('/') || cmd.startsWith('.')
    ? path.resolve(basedir, cmd)
    : path.join(basedir, 'node_modules', '.bin', cmd);
  const args = rest.map((a) =>
    a.startsWith('-') ? a : a.includes('/') || a.startsWith('.') ? path.resolve(basedir, a) : a
  );
  return { mcpServers: { axiom: { command, args } } };
}

/**
 * Runs benchmark problems through headless Claude Code. Product-realistic
 * scenario: baseline is vanilla Claude Code (built-in tools incl. web),
 * the tool condition attaches the Axiom MCP server via --mcp-config.
 * The CLI owns the agent loop AND the MCP connection, so runWithTools
 * deliberately ignores the `tools` and `callTool` parameters.
 */
export class ClaudeCodeProvider implements LLMProvider {
  readonly name = 'claude-code';
  private readonly workdir: string;
  private readonly mcpConfigPath: string;

  constructor(
    readonly model: string,
    mcpServerCmd: string[],
    private readonly timeoutMs = DEFAULT_TIMEOUT_MS
  ) {
    this.workdir = mkdtempSync(path.join(tmpdir(), 'axiom-cc-bench-'));
    const config = buildMcpConfig(mcpServerCmd, process.cwd());
    // Fall back to the bare command if the .bin shim doesn't exist (e.g. global tsx)
    const axiom = config.mcpServers.axiom;
    if (axiom.command.includes('/node_modules/') && !existsSync(axiom.command)) {
      axiom.command = path.basename(axiom.command);
    }
    this.mcpConfigPath = path.join(this.workdir, 'mcp-config.json');
    writeFileSync(this.mcpConfigPath, JSON.stringify(config));
    // Best-effort temp-dir cleanup (spec) — the OS reaps tmpdir leftovers anyway.
    process.once('exit', () => {
      try {
        rmSync(this.workdir, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    });
  }

  private run(prompt: string, maxTurns: number, withMcp: boolean): Promise<ReturnType<typeof parseClaudeCodeStream> & { durationMs: number }> {
    const args = ['-p', prompt, ...buildCliArgs({
      model: this.model,
      maxTurns,
      mcpConfigPath: withMcp ? this.mcpConfigPath : undefined,
    })];
    const start = Date.now();
    return new Promise((resolve, reject) => {
      const child = spawn('claude', args, { cwd: this.workdir, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error(`claude-code timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);
      child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
      child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
      child.on('error', (err) => { clearTimeout(timer); reject(err); });
      child.on('close', (code) => {
        clearTimeout(timer);
        const parsed = parseClaudeCodeStream(stdout.split('\n').filter((l) => l.trim()));
        if (code !== 0 || parsed.isError) {
          reject(new Error(
            `claude-code failed (exit ${code}, isError ${parsed.isError}): ${stderr.slice(0, 500) || parsed.text.slice(0, 500)}`
          ));
          return;
        }
        resolve({ ...parsed, durationMs: Date.now() - start });
      });
    });
  }

  async runBaseline(problem: string, _maxTokens: number, _temperature?: number): Promise<BaselineResult> {
    // Vanilla Claude Code: built-in tools on, no Axiom. maxTokens/temperature
    // are owned by the CLI and intentionally ignored. maxTurns is fixed at 8
    // because the interface does not pass maxTurns to baselines; vanilla
    // Claude Code may use several turns for built-in tools.
    const r = await this.run(problem, 8, false);
    return { text: r.text, inputTokens: r.inputTokens, outputTokens: r.outputTokens, durationMs: r.durationMs };
  }

  async runWithTools(
    problem: string,
    _tools: NeutralTool[],
    _callTool: (name: string, args: Record<string, unknown>) => Promise<string>,
    _maxTokens: number,
    maxTurns: number,
    _temperature?: number
  ): Promise<ToolAugmentedResult> {
    // The CLI spawns and talks to the Axiom MCP server itself; the harness's
    // tools/callTool are unused here by design (see the class doc comment).
    const r = await this.run(problem, maxTurns, true);
    const toolCalls: ToolCallRecord[] = r.toolCalls;
    return {
      text: r.text,
      toolCalls,
      turns: r.turns,
      inputTokens: r.inputTokens,
      outputTokens: r.outputTokens,
      durationMs: r.durationMs,
    };
  }
}
