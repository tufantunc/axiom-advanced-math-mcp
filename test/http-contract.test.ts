import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer as createNetServer } from 'node:net';
import { request as httpRequest } from 'node:http';
import { existsSync } from 'node:fs';
import { VERSION } from '../src/version.js';

/** Ask the OS for a free TCP port, then release it for the server to claim. */
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createNetServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const addr = probe.address();
      if (addr === null || typeof addr === 'string') {
        probe.close();
        reject(new Error('could not determine a free port'));
        return;
      }
      const { port } = addr;
      probe.close(() => resolve(port));
    });
  });
}

/** Poll /health until the server answers or we give up. */
async function waitForReady(base: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = null;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${base}/health`);
      if (res.ok) return;
      lastError = new Error(`health returned ${res.status}`);
    } catch (e) {
      lastError = e;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`server did not become ready: ${String(lastError)}`);
}

/**
 * Races `waitForReady` against the child dying during startup.
 *
 * Without this, a child that fails to bind (e.g. because something else
 * grabbed the port in the gap between `freePort()`'s probe closing and the
 * child binding) just never answers `/health`, and the caller only finds
 * out 30 s later via the opaque "server did not become ready" timeout. This
 * surfaces the real cause immediately by listening for the child's own
 * `error`/`exit` events while the poll loop runs.
 */
async function waitForReadyOrExit(
  child: ChildProcess,
  base: string,
  timeoutMs = 30_000
): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      child.off('error', onError);
      child.off('exit', onExit);
    };
    const onError = (err: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };
    const onExit = (code: number | null, signal: string | null) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error(`server process exited before becoming ready (code=${code}, signal=${signal})`));
    };
    child.on('error', onError);
    child.on('exit', onExit);

    waitForReady(base, timeoutMs).then(
      () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve();
      },
      (err) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(err);
      }
    );
  });
}

/** Captures a child's stderr as text while still forwarding it to this process's stderr for debugging. */
function captureStderr(child: ChildProcess): () => string {
  let buf = '';
  child.stderr?.on('data', (chunk: Buffer) => {
    buf += chunk.toString();
    process.stderr.write(chunk);
  });
  return () => buf;
}

interface SpawnedServer {
  child: ChildProcess;
  base: string;
  getStderr: () => string;
}

/** Spawns dist/http.js with the given env overrides and waits for it to become ready (or fails fast). */
async function spawnServer(envOverrides: Record<string, string> = {}): Promise<SpawnedServer> {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const child = spawn('node', ['dist/http.js'], {
    env: { ...process.env, MCP_PORT: String(port), MCP_HOST: '127.0.0.1', ...envOverrides },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  const getStderr = captureStderr(child);
  await waitForReadyOrExit(child, base);
  return { child, base, getStderr };
}

/**
 * POST a JSON-RPC message with an explicit `Host` header, bypassing the
 * request's own URL host. Node's global `fetch` (undici) silently ignores
 * an explicit `host` header and derives it from the URL instead, so this
 * uses `node:http` directly, which honors it.
 */
async function rpcWithHost(
  base: string,
  hostHeader: string,
  body: unknown
): Promise<{ status: number; json: any }> {
  const url = new URL(`${base}/mcp`);
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          Host: hostHeader,
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          try {
            const contentType = res.headers['content-type'] ?? '';
            const payload = contentType.includes('text/event-stream')
              ? JSON.parse(data.split('\n').find((l) => l.startsWith('data:'))!.slice(5).trim())
              : JSON.parse(data);
            resolve({ status: res.statusCode ?? 0, json: payload });
          } catch (e) {
            reject(e);
          }
        });
      }
    );
    req.on('error', reject);
    req.write(JSON.stringify(body));
    req.end();
  });
}

/** POST a JSON-RPC message to the running server and return the parsed response. */
async function rpc(
  base: string,
  body: unknown
): Promise<{ status: number; contentType: string; sessionId: string | null; json: any }> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
  };

  const res = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  const contentType = res.headers.get('content-type') ?? '';
  const responseSessionId = res.headers.get('mcp-session-id');
  const text = await res.text();
  // Streamable HTTP may answer either as plain JSON or as a single SSE event.
  const payload = contentType.includes('text/event-stream')
    ? JSON.parse(text.split('\n').find((l) => l.startsWith('data:'))!.slice(5).trim())
    : JSON.parse(text);
  return { status: res.status, contentType, sessionId: responseSessionId, json: payload };
}

const INIT = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'contract-test', version: '1.0.0' },
  },
};

describe('HTTP transport contract (subprocess, real HTTP)', () => {
  let child: ChildProcess;
  let base: string;

  beforeAll(async () => {
    if (!existsSync('dist/http.js')) {
      throw new Error('dist/http.js missing — run `npm run build` before the integration suite');
    }
    const port = await freePort();
    base = `http://127.0.0.1:${port}`;
    child = spawn('node', ['dist/http.js'], {
      env: { ...process.env, MCP_PORT: String(port), MCP_HOST: '127.0.0.1' },
      stdio: ['ignore', 'ignore', 'inherit'],
    });
    await waitForReadyOrExit(child, base);
  }, 60_000);

  afterAll(() => {
    child?.kill('SIGKILL');
  });

  it('reports the correct serverInfo on initialize, with no session id (stateless transport)', async () => {
    const { status, json, sessionId } = await rpc(base, INIT);
    expect(status).toBe(200);
    expect(json.result.serverInfo.name).toBe('axiom-advanced-math-mcp');
    expect(json.result.serverInfo.version).toBe(VERSION);
    // Real HTTP stack + adapter, not just the in-process app: this is the
    // layer that would actually catch a session header sneaking back in
    // (e.g. via the Node HTTP server or the streamable-HTTP adapter).
    expect(sessionId).toBeNull();
  });

  it('serves /health', async () => {
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; giac: boolean };
    expect(body.status).toBe('ok');
    expect(body.giac).toBe(true);
  });

  it('lists the compute, verify and plot tools', async () => {
    await rpc(base, INIT);
    const { json } = await rpc(base, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    const names = json.result.tools.map((t: { name: string }) => t.name).sort();
    expect(names).toEqual(['compute', 'plot', 'verify']);
  });

  it('computes a symbolic integral end to end', async () => {
    await rpc(base, INIT);
    const { json } = await rpc(base, {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'compute', arguments: { problem: 'integrate(sin(x)^3,x)' } },
    });
    const text = json.result.content.map((c: { text: string }) => c.text).join('\n');
    expect(text).toContain('-cos(x)+cos(x)^3/3');
  });

  it('lists the registered prompts', async () => {
    await rpc(base, INIT);
    const { json } = await rpc(base, { jsonrpc: '2.0', id: 4, method: 'prompts/list', params: {} });
    expect(json.result.prompts.length).toBeGreaterThan(0);
  });
});

describe('Node entrypoint environment wiring (subprocess)', () => {
  // Each test here spawns its own child rather than sharing the suite-wide
  // one above, because each exercises a different, mutually exclusive env
  // configuration (invalid port, custom allowlist, 0.0.0.0 bind).

  it('exits non-zero and never binds when MCP_PORT is not a number', async () => {
    if (!existsSync('dist/http.js')) {
      throw new Error('dist/http.js missing — run `npm run build` before the integration suite');
    }
    const child = spawn('node', ['dist/http.js'], {
      env: { ...process.env, MCP_PORT: 'notanumber', MCP_HOST: '127.0.0.1' },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    const getStderr = captureStderr(child);

    const exit = await new Promise<{ code: number | null; signal: string | null }>(
      (resolve, reject) => {
        child.on('error', reject);
        child.on('exit', (code, signal) => resolve({ code, signal }));
      }
    );

    expect(exit.code).not.toBe(0);
    expect(getStderr()).toContain('invalid MCP_PORT');
  }, 15_000);

  it('an explicit MCP_ALLOWED_HOSTS from the environment replaces the loopback default', async () => {
    const { child, base } = await spawnServer({ MCP_ALLOWED_HOSTS: 'mcp.example.com' });
    try {
      const allowed = await rpcWithHost(base, 'mcp.example.com', INIT);
      expect(allowed.status).toBe(200);
      expect(allowed.json.result.serverInfo.name).toBe('axiom-advanced-math-mcp');

      // The loopback default is *replaced*, not extended, by an explicit
      // MCP_ALLOWED_HOSTS — so a request that would have passed under the
      // built-in default is now rejected.
      const rejected = await rpcWithHost(base, 'localhost', INIT);
      expect(rejected.status).toBe(403);
    } finally {
      child.kill('SIGKILL');
    }
  }, 20_000);

  it('warns on stderr when MCP_HOST is 0.0.0.0', async () => {
    const { child, getStderr } = await spawnServer({ MCP_HOST: '0.0.0.0' });
    try {
      expect(getStderr()).toContain('0.0.0.0');
      expect(getStderr()).toContain('WARNING');
    } finally {
      child.kill('SIGKILL');
    }
  }, 20_000);
});
