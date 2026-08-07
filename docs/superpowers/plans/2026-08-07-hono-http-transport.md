# Hono Stateless HTTP Transport Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Express HTTP transport with a stateless Hono app that has real test coverage and does not foreclose a future Cloudflare Workers entrypoint.

**Architecture:** Split `src/http.ts` into a portable Hono app factory (`src/server/transports/http-app.ts`, zero Node APIs, Web-standard `Request`/`Response` only) and a thin Node entrypoint (`src/http.ts`, ~30 lines, owns config/signals/Giac init). Every `POST /mcp` builds a throwaway `McpServer` + `WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })`; the expensive Giac worker stays a process-level singleton.

**Tech Stack:** Hono 4.x, `@hono/node-server` 2.x (router and Node adapter only — both zero-dependency), the MCP SDK's first-party `WebStandardStreamableHTTPServerTransport` for the entire protocol surface, vitest.

**Spec:** [docs/superpowers/specs/2026-08-07-hono-http-transport-design.md](../specs/2026-08-07-hono-http-transport-design.md)

## Global Constraints

- Node.js >= 20 (`package.json` `engines`).
- `src/server/transports/http-app.ts` MUST NOT import any `node:*` module, directly or transitively. Enforced by Task 7.
- Stateless only: `sessionIdGenerator: undefined`. No `Mcp-Session-Id` header may appear in any response.
- `enableJsonResponse: true` is load-bearing, not cosmetic. Without it the transport answers with SSE and closing it after `handleRequest` resolves truncates the body to `""` (measured). Do not remove it without replacing the cleanup strategy.
- Do not add `@hono/mcp`. It was evaluated and rejected; the SDK transport is first-party and adds no dependencies.
- No new devDependencies. Tests use `app.fetch` and the global `fetch`/`Request` — no `supertest`.
- Error responses keep the JSON-RPC envelope and MUST NOT contain stack traces.
- All 616 existing tests must keep passing at every commit.
- Branch: `feat/hono-http-transport`, from `main` @ `c33c660`.
- Do not touch `benchmark/` (verified: no Express usage).
- Do not add rate limiting or auth. Auth is a separate follow-up spec.

---

### Task 0: Create the working branch

**Files:** none

- [ ] **Step 1: Branch from main**

```bash
cd /Users/tufantunc/Desktop/Projects/Personal/axiom-advanced-math-mcp
git checkout main
git checkout -b feat/hono-http-transport
```

- [ ] **Step 2: Confirm a clean baseline**

Run: `npm test`
Expected: `Test Files 52 passed (52)` and `Tests 616 passed (616)`.

---

### Task 1: Single source of truth for the version

`package.json` says `0.1.0` while `src/server/index.ts:11` reports `0.2.0` in `serverInfo`. Task 2 asserts the version over the wire and must not pin the wrong one, so fix this first. `0.2.0` is the value clients already see, so `package.json` moves up to match.

**Files:**
- Create: `src/version.ts`
- Create: `test/version.test.ts`
- Modify: `src/server/index.ts` (the `version:` literal, line 11)
- Modify: `package.json` (the `version` field)

**Interfaces:**
- Produces: `export const VERSION: string` from `src/version.ts`. Task 2 and Task 4 assert against it.

- [ ] **Step 1: Write the failing test**

Create `test/version.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { VERSION } from '../src/version.js';

describe('version single source of truth', () => {
  it('matches the version field in package.json', () => {
    const pkg = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8')
    ) as { version: string };
    expect(VERSION).toBe(pkg.version);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run test/version.test.ts`
Expected: FAIL — cannot resolve `../src/version.js` (the module does not exist yet).

- [ ] **Step 3: Create the constant**

Create `src/version.ts`:

```ts
/**
 * The single source of truth for the server version.
 *
 * Kept in sync with package.json by test/version.test.ts. The MCP server
 * reports this in `serverInfo`, so a mismatch is visible to every client.
 */
export const VERSION = '0.2.0';
```

- [ ] **Step 4: Align package.json**

In `package.json`, change `"version": "0.1.0"` to `"version": "0.2.0"`.

- [ ] **Step 5: Use the constant in the server**

In `src/server/index.ts`, add to the imports at the top:

```ts
import { VERSION } from '../version.js';
```

Then replace the literal on line 11:

```ts
      version: VERSION,
```

- [ ] **Step 6: Run the tests**

Run: `npx vitest run test/version.test.ts`
Expected: PASS (1 test).

Run: `npm test`
Expected: `Tests 617 passed (617)`.

Run: `npm run typecheck`
Expected: no output, exit 0.

- [ ] **Step 7: Commit**

```bash
git add src/version.ts test/version.test.ts src/server/index.ts package.json
git commit -m "fix: single source of truth for server version

package.json said 0.1.0 while serverInfo reported 0.2.0. Clients see
serverInfo, so package.json moves to 0.2.0 and both now read from
src/version.ts, enforced by a test."
```

---

### Task 2: Contract tests against the current Express transport

These tests drive the **built** server as a subprocess over real HTTP, so they are transport-implementation-agnostic: whatever passes on Express today must still pass on Hono after Task 6.

**Measured before writing this task — the current Express transport is broken beyond `initialize`.** `src/http.ts:36` reads `transport.sessionId` immediately after `server.connect(transport)`, but the SDK assigns that field while handling the `initialize` request, which happens later at `handleRequest`. The guard is therefore always false and `sessions` is never populated — confirmed by `/health` reporting `sessions: 0` after three successive `initialize` calls. Every follow-up request answers `400 Bad Request: Server not initialized`.

So the "behaviour to preserve" is only `initialize` and `/health`. The rest is not a regression risk; it is a defect this migration fixes. This task therefore captures two things: the genuinely working contract, and one **characterization test** that pins the current breakage so Task 6 has to demonstrably flip it.

They live in the integration config because they need `dist/`, so `npm test` stays fast and build-independent.

**Files:**
- Create: `test/http-contract.test.ts`
- Modify: `vitest.config.integration.ts` (add to `include`)
- Modify: `vitest.config.ts` (add to `exclude`)

**Interfaces:**
- Consumes: `VERSION` from `src/version.ts` (Task 1).
- Produces: nothing importable. Task 6 re-runs this file unchanged as its acceptance gate.

- [ ] **Step 1: Write the contract test**

Create `test/http-contract.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer as createNetServer } from 'node:net';
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
 * POST a JSON-RPC message and return the parsed response.
 *
 * `sessionId` is forwarded as `mcp-session-id` when given. A stateful server
 * requires it on every request after `initialize`; a stateless one issues no
 * session id, so callers pass the null they got back and no header is sent.
 * The same helper therefore drives both transports.
 */
async function rpc(
  base: string,
  body: unknown,
  sessionId?: string | null
): Promise<{ status: number; contentType: string; sessionId: string | null; json: any }> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
  };
  if (sessionId) headers['mcp-session-id'] = sessionId;

  const res = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  const contentType = res.headers.get('content-type') ?? '';
  // Named distinctly from the `sessionId` parameter above — reusing the name
  // shadows it and fails to compile.
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
    await waitForReady(base);
  }, 60_000);

  afterAll(() => {
    child?.kill('SIGKILL');
  });

  it('reports the correct serverInfo on initialize', async () => {
    const { status, json } = await rpc(base, INIT);
    expect(status).toBe(200);
    expect(json.result.serverInfo.name).toBe('axiom-advanced-math-mcp');
    expect(json.result.serverInfo.version).toBe(VERSION);
  });

  it('serves /health', async () => {
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; giac: boolean };
    expect(body.status).toBe('ok');
    expect(body.giac).toBe(true);
  });

  // CHARACTERIZATION TEST — pins a defect, not desired behaviour.
  //
  // src/http.ts:36 reads transport.sessionId immediately after connect(), but
  // the SDK assigns it while handling `initialize`, which happens later at
  // handleRequest. The guard never fires, so the session map is never
  // populated (/health reports sessions: 0 after any number of initializes).
  //
  // The session id MUST be forwarded here. Without it, src/http.ts builds a
  // fresh uninitialized transport for the second request and returns the same
  // error for an unrelated reason — the test would pass no matter what the
  // session map does, and would pin nothing. Sending the id is what makes the
  // assertion depend on the defect: a correct stateful server would honour it.
  //
  // Task 6 REPLACES this test with real protocol assertions. If it starts
  // failing before then, the session bug changed and this plan needs revising.
  it('currently rejects requests after initialize even with the session id (defect, fixed in Task 6)', async () => {
    const init = await rpc(base, INIT);
    expect(init.sessionId, 'Express should issue a session id on initialize').toBeTruthy();

    const { json } = await rpc(
      base,
      { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
      init.sessionId
    );
    expect(json.error, 'expected an error response, got a result').toBeDefined();
    expect(json.error.message).toContain('Server not initialized');
  });
});
```

- [ ] **Step 2: Register the file in the integration config**

In `vitest.config.integration.ts`, change the `include` array to:

```ts
    include: [
      'test/integration.test.ts',
      'test/golden/tool.golden.test.ts',
      'test/http-contract.test.ts',
    ],
```

- [ ] **Step 3: Keep it out of the unit suite**

In `vitest.config.ts`, change the `exclude` array to:

```ts
    exclude: [
      'test/integration.test.ts',
      'test/golden/tool.golden.test.ts',
      'test/http-contract.test.ts',
    ],
```

- [ ] **Step 4: Build, then run the contract test against the current Express server**

Run:

```bash
npm run build && npx vitest run --config vitest.config.integration.ts test/http-contract.test.ts
```

Expected: PASS, 3 tests — including the characterization test, which passes by asserting the current breakage. **If any fail now, stop and investigate: the plan's model of current behaviour is wrong.**

- [ ] **Step 5: Confirm the unit suite is unaffected**

Run: `npm test`
Expected: `Tests 617 passed (617)` — the contract file is excluded here.

- [ ] **Step 6: Commit**

```bash
git add test/http-contract.test.ts vitest.config.ts vitest.config.integration.ts
git commit -m "test: contract tests for the HTTP transport

Drives the built server as a subprocess over real HTTP, so the same file
verifies Express today and Hono after the migration. Lives in the
integration config because it needs dist/."
```

---

### Task 3: Hono dependencies and the portable app factory with /health

Smallest useful slice of the new app: the health route and the injected probe. The injection is not ceremony — calling `giacEngine.isReady()` here would drag `node:child_process` into this module through `giac/index.ts → wrapper.ts → worker-host.ts` and destroy the portability boundary.

**Files:**
- Create: `src/server/transports/http-app.ts`
- Create: `test/http-app.test.ts`
- Modify: `package.json` (dependencies)

**Interfaces:**
- Produces:
  - `export interface HttpAppOptions { healthProbe: () => boolean }`
  - `export function createHttpApp(options: HttpAppOptions): Hono`

  Tasks 4, 5, 6 and 7 all consume `createHttpApp`.

- [ ] **Step 1: Install the runtime dependencies**

```bash
npm install hono @hono/node-server
```

Expected: `added 2 packages`. Both are zero-dependency, so the tree grows by exactly these two and nothing else. The MCP transport comes from `@modelcontextprotocol/sdk`, which is already a dependency — no new package for it.

- [ ] **Step 2: Write the failing test**

Create `test/http-app.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { createHttpApp } from '../src/server/transports/http-app.js';

describe('http-app /health', () => {
  it('returns 200 and giac:true when the probe reports ready', async () => {
    const app = createHttpApp({ healthProbe: () => true });
    const res = await app.fetch(new Request('http://localhost/health'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; giac: boolean; transport: string };
    expect(body).toEqual({ status: 'ok', giac: true, transport: 'stateless' });
  });

  it('returns 503 and giac:false when the probe reports not ready', async () => {
    const app = createHttpApp({ healthProbe: () => false });
    const res = await app.fetch(new Request('http://localhost/health'));
    expect(res.status).toBe(503);
    const body = (await res.json()) as { status: string; giac: boolean };
    expect(body.status).toBe('degraded');
    expect(body.giac).toBe(false);
  });
});
```

- [ ] **Step 3: Run it and watch it fail**

Run: `npx vitest run test/http-app.test.ts`
Expected: FAIL — cannot resolve `../src/server/transports/http-app.js`.

- [ ] **Step 4: Create the app factory**

Create `src/server/transports/http-app.ts`:

```ts
import { Hono } from 'hono';

export interface HttpAppOptions {
  /**
   * Reports whether the compute backend is ready to serve.
   *
   * Injected rather than imported: reaching for `giacEngine.isReady()` here
   * would pull `node:child_process` into this module via
   * giac/index.ts -> wrapper.ts -> worker-host.ts, and this module must stay
   * free of Node APIs so it can run unchanged on Workers/Deno/Bun.
   * Enforced by test/http-portability.test.ts.
   */
  healthProbe: () => boolean;
}

/**
 * Builds the MCP HTTP application.
 *
 * Web Standards only — no Node APIs, no port, no signal handling, no
 * environment access. The Node entrypoint (src/http.ts) supplies everything
 * host-specific.
 */
export function createHttpApp(options: HttpAppOptions): Hono {
  const app = new Hono();

  app.get('/health', (c) => {
    const ready = options.healthProbe();
    return c.json(
      { status: ready ? 'ok' : 'degraded', giac: ready, transport: 'stateless' },
      ready ? 200 : 503
    );
  });

  return app;
}
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run test/http-app.test.ts`
Expected: PASS, 2 tests.

Run: `npm run typecheck`
Expected: no output, exit 0.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json src/server/transports/http-app.ts test/http-app.test.ts
git commit -m "feat(http): portable Hono app factory with injected health probe

The probe is injected so this module never imports the Giac singleton,
which would drag node:child_process in transitively and break the
Workers portability boundary."
```

---

### Task 4: Stateless POST /mcp

**Files:**
- Modify: `src/server/transports/http-app.ts`
- Modify: `test/http-app.test.ts`

**Interfaces:**
- Consumes: `createHttpApp` (Task 3), `createServer` from `src/server/index.ts`, `VERSION` from `src/version.ts` (Task 1).
- Produces: no new exports. Adds the `POST /mcp` route to the app from Task 3.

- [ ] **Step 1: Write the failing tests**

Append to `test/http-app.test.ts`:

```ts
import { createServer } from '../src/server/index.js';
import { VERSION } from '../src/version.js';

/** POST a JSON-RPC message into the app in-process and parse the reply. */
async function post(app: ReturnType<typeof createHttpApp>, body: unknown) {
  const res = await app.fetch(
    new Request('http://localhost/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify(body),
    })
  );
  const contentType = res.headers.get('content-type') ?? '';
  const text = await res.text();
  const json = contentType.includes('text/event-stream')
    ? JSON.parse(text.split('\n').find((l) => l.startsWith('data:'))!.slice(5).trim())
    : JSON.parse(text);
  return { res, contentType, json };
}

const INIT_MSG = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'unit-test', version: '1.0.0' },
  },
};

describe('http-app POST /mcp (stateless)', () => {
  const app = createHttpApp({ healthProbe: () => true });

  it('answers initialize with the correct serverInfo', async () => {
    const { res, json } = await post(app, INIT_MSG);
    expect(res.status).toBe(200);
    expect(json.result.serverInfo.name).toBe('axiom-advanced-math-mcp');
    expect(json.result.serverInfo.version).toBe(VERSION);
  });

  it('lists all three tools', async () => {
    const { json } = await post(app, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    const names = json.result.tools.map((t: { name: string }) => t.name).sort();
    expect(names).toEqual(['compute', 'plot', 'verify']);
  });

  it('computes a symbolic integral end to end', async () => {
    const { json } = await post(app, {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'compute', arguments: { problem: 'integrate(sin(x)^3,x)' } },
    });
    const text = json.result.content.map((c: { text: string }) => c.text).join('\n');
    expect(text).toContain('-cos(x)+cos(x)^3/3');
  });

  it('never issues a session id', async () => {
    const { res } = await post(app, INIT_MSG);
    expect(res.headers.get('mcp-session-id')).toBeNull();
  });

  it('serves two independent requests with no handshake between them', async () => {
    const a = await post(app, { jsonrpc: '2.0', id: 10, method: 'tools/list', params: {} });
    const b = await post(app, { jsonrpc: '2.0', id: 11, method: 'tools/list', params: {} });
    expect(a.json.result.tools.length).toBeGreaterThan(0);
    expect(b.json.result.tools.length).toBe(a.json.result.tools.length);
  });

  it('answers with a complete JSON body, not a stream', async () => {
    // Pins the contract the cleanup depends on. The transport is closed as
    // soon as handleRequest resolves, which is only safe while responses are
    // complete JSON bodies — that is what enableJsonResponse guarantees.
    // Without it the transport answers with SSE and the body arrives empty
    // (measured). If someone drops that option, this fails loudly instead of
    // truncating responses in production.
    const { contentType, json } = await post(app, INIT_MSG);
    expect(contentType).toContain('application/json');
    expect(json.result).toBeDefined();
  });
});
```

- [ ] **Step 2: Run and watch the new tests fail**

Run: `npx vitest run test/http-app.test.ts`
Expected: the two `/health` tests PASS; the six new tests FAIL with 404 (no `POST /mcp` route yet).

- [ ] **Step 3: Add the route**

In `src/server/transports/http-app.ts`, add these imports at the top:

```ts
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { createServer } from '../index.js';
```

Then insert this route inside `createHttpApp`, before `return app;`:

```ts
  app.post('/mcp', async (c) => {
    // Parse here rather than letting the transport do it, so malformed JSON
    // gets a deterministic JSON-RPC parse error instead of a framework 400.
    let parsed: unknown;
    try {
      parsed = await c.req.json();
    } catch {
      return c.json(
        { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } },
        400
      );
    }

    // Stateless: a throwaway server + transport per request. This costs
    // ~0.25 ms, against 4-19 ms for a Giac evaluation. The expensive part —
    // the Giac worker process — is a module-level singleton and is untouched.
    //
    // enableJsonResponse is required, not cosmetic: without it the transport
    // answers with an SSE stream, and the close() below truncates the body to
    // "". With it, every response is a complete JSON body and closing once
    // handleRequest resolves is safe by construction.
    const server = createServer();
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    await server.connect(transport);

    try {
      return await transport.handleRequest(c.req.raw, { parsedBody: parsed });
    } finally {
      await transport.close();
      await server.close();
    }
  });
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/http-app.test.ts`
Expected: PASS, 8 tests.

Run: `npm run typecheck`
Expected: no output, exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/server/transports/http-app.ts test/http-app.test.ts
git commit -m "feat(http): stateless POST /mcp on the SDK web-standard transport

One throwaway McpServer + transport per request (~0.25 ms); the Giac
worker stays a process singleton. enableJsonResponse keeps responses as
complete JSON bodies, which is what makes closing the transport right
after handleRequest safe; a content-type test pins that contract."
```

---

### Task 5: Method rejection and error envelopes

**Files:**
- Modify: `src/server/transports/http-app.ts`
- Modify: `test/http-app.test.ts`

**Interfaces:**
- Consumes: `createHttpApp` (Task 3).
- Produces: no new exports.

- [ ] **Step 1: Write the failing tests**

Append to `test/http-app.test.ts`:

```ts
describe('http-app method rejection and errors', () => {
  const app = createHttpApp({ healthProbe: () => true });

  it('rejects GET /mcp with 405 (no SSE stream offered)', async () => {
    const res = await app.fetch(new Request('http://localhost/mcp', { method: 'GET' }));
    expect(res.status).toBe(405);
    const body = (await res.json()) as { error: { code: number } };
    expect(body.error.code).toBe(-32000);
  });

  it('rejects DELETE /mcp with 405 (no sessions to terminate)', async () => {
    const res = await app.fetch(new Request('http://localhost/mcp', { method: 'DELETE' }));
    expect(res.status).toBe(405);
  });

  it('maps a malformed JSON body to -32700', async () => {
    const res = await app.fetch(
      new Request('http://localhost/mcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{ not json',
      })
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: number; message: string } };
    expect(body.error.code).toBe(-32700);
    expect(body.error.message).toBe('Parse error');
  });

  it('returns a JSON-RPC shaped 404 for unknown paths', async () => {
    const res = await app.fetch(new Request('http://localhost/nope'));
    expect(res.status).toBe(404);
    const body = (await res.json()) as { jsonrpc: string; error: { code: number } };
    expect(body.jsonrpc).toBe('2.0');
    expect(body.error.code).toBe(-32601);
  });

  it('never leaks a stack trace in an internal error body', async () => {
    const boom = createHttpApp({
      healthProbe: () => {
        throw new Error('probe exploded at Object.<anonymous> (/secret/path.ts:1:1)');
      },
    });
    const res = await boom.fetch(new Request('http://localhost/health'));
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(text).not.toMatch(/at .*\(/);
    expect(text).not.toContain('/secret/path.ts');
    const body = JSON.parse(text) as { error: { code: number; message: string } };
    expect(body.error.code).toBe(-32603);
    expect(body.error.message).toBe('Internal error');
  });
});
```

- [ ] **Step 2: Run and watch them fail**

Run: `npx vitest run test/http-app.test.ts`
Expected: the 8 earlier tests PASS; the 5 new ones FAIL (404s where 405 expected, HTML 404 body, unhandled throw).

- [ ] **Step 3: Add the handlers**

In `src/server/transports/http-app.ts`, insert these routes after the `POST /mcp` route and before `return app;`:

```ts
  // The MCP spec requires 405 from servers that offer no SSE stream at this
  // endpoint. Session termination is likewise meaningless without sessions.
  const methodNotAllowed = (c: Context) =>
    c.json(
      {
        jsonrpc: '2.0',
        id: null,
        error: { code: -32000, message: 'Method not allowed: this server is stateless' },
      },
      405
    );

  app.get('/mcp', methodNotAllowed);
  app.delete('/mcp', methodNotAllowed);

  app.notFound((c) =>
    c.json(
      { jsonrpc: '2.0', id: null, error: { code: -32601, message: 'Not found' } },
      404
    )
  );

  app.onError((err, c) => {
    // Full detail to stderr; never into the response body. This is an
    // open-source server — leaking internals buys nothing.
    console.error('[http] unhandled error:', err);
    return c.json(
      { jsonrpc: '2.0', id: null, error: { code: -32603, message: 'Internal error' } },
      500
    );
  });
```

Add `Context` to the Hono import at the top of the file:

```ts
import { Hono, type Context } from 'hono';
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/http-app.test.ts`
Expected: PASS, 13 tests.

Run: `npm run typecheck`
Expected: no output, exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/server/transports/http-app.ts test/http-app.test.ts
git commit -m "feat(http): 405 on GET/DELETE, JSON-RPC error envelopes

Stack traces go to stderr, never into a response body."
```

---

### Task 6: Replace src/http.ts with the Node entrypoint and drop Express

The migration itself. The Task 2 contract tests are the acceptance gate: they were written against Express and must pass unchanged against Hono.

**Files:**
- Modify: `src/http.ts` (full rewrite)
- Modify: `package.json` (remove `express`, `@types/express`)

**Interfaces:**
- Consumes: `createHttpApp` (Task 3), `giacEngine` from `src/server/giac/index.js`.
- Produces: nothing importable — this is a process entrypoint.

- [ ] **Step 1: Rewrite the entrypoint**

Replace the entire contents of `src/http.ts` with:

```ts
import { serve } from '@hono/node-server';
import { createHttpApp } from './server/transports/http-app.js';
import { giacEngine } from './server/giac/index.js';

const port = parseInt(process.env.MCP_PORT || '3000', 10);
const host = process.env.MCP_HOST || '127.0.0.1';

const app = createHttpApp({ healthProbe: () => giacEngine.isReady() });

async function start(): Promise<void> {
  await giacEngine.initialize();

  if (host === '0.0.0.0') {
    console.error(
      '[http] WARNING: bound to 0.0.0.0 with no authentication. ' +
        'Anyone who can reach this port can run computations on this server. ' +
        'Put it behind a reverse proxy or restrict MCP_HOST.'
    );
  }

  const server = serve({ fetch: app.fetch, port, hostname: host }, (info) => {
    console.log(`Axiom Math MCP Server (HTTP) listening on http://${host}:${info.port}/mcp`);
  });

  const shutdown = () => {
    server.close(() => process.exit(0));
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

start().catch((err) => {
  console.error('Failed to start:', err);
  process.exit(1);
});
```

- [ ] **Step 2: Remove Express**

```bash
npm uninstall express @types/express
```

- [ ] **Step 3: Confirm Express is gone from the source tree**

Run: `grep -rn "express" src/ package.json`
Expected: no matches.

- [ ] **Step 4: Build and confirm the preserved contract still holds**

```bash
npm run build && npx vitest run --config vitest.config.integration.ts test/http-contract.test.ts
```

Expected: the `initialize` and `/health` tests PASS unchanged from Task 2. The characterization test now **FAILS** — `tools/list` succeeds instead of returning "Server not initialized". That failure is the proof the migration fixed the session defect; the next step converts it into real assertions.

- [ ] **Step 5: Replace the characterization test with real protocol assertions**

In `test/http-contract.test.ts`, delete the whole `it('currently rejects any request after initialize (defect, fixed in Task 6)', ...)` block — including its CHARACTERIZATION TEST comment — and put these three tests in its place:

```ts
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
```

Note these need no session handling: the Hono transport is stateless, so each request stands alone. That is the fix.

- [ ] **Step 6: Re-run the contract tests — the acceptance gate**

```bash
npx vitest run --config vitest.config.integration.ts test/http-contract.test.ts
```

Expected: PASS, 5 tests.

- [ ] **Step 7: Run everything**

Run: `npm test`
Expected: `Tests 630 passed (630)` (617 after Task 1, plus the 13 from Tasks 3-5).

Run: `npm run typecheck`
Expected: no output, exit 0.

Run: `npx oxlint src`
Expected: `Found 0 warnings and 0 errors.`

- [ ] **Step 8: Record the dependency reduction**

Run: `npm ls --omit=dev --all --json | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);const seen=new Set();(function w(d){for(const [k,v] of Object.entries(d.dependencies||{})){if(seen.has(k))continue;seen.add(k);w(v);}})(j);console.log('prod packages:',seen.size);})"`

Expected: fewer packages than before. Note the actual figure in the commit message.

Do not expect a dramatic drop from this particular command. `@modelcontextprotocol/sdk` itself depends on `express@^5`, `cors`, `express-rate-limit` — and on `hono` and `@hono/node-server` — so Express stays in the tree transitively and Hono was already there. What this migration removes is our *direct* `express@4`, a second Express major that does not dedupe with the SDK's. In a clean install of the production dependency set that is 135 → 103 packages; measured in this repo's already-deduped tree the delta reads much smaller. Both are correct; they count different things.

- [ ] **Step 9: Commit**

```bash
git add src/http.ts test/http-contract.test.ts package.json package-lock.json
git commit -m "refactor(http): serve the Hono app, drop Express

src/http.ts is now a thin Node entrypoint: config, eager Giac init,
signals, and a warning when bound to 0.0.0.0 without auth. The routes
live in the portable app factory.

This also fixes a defect the old transport had from the start: it read
transport.sessionId immediately after connect(), before the SDK assigns
it during initialize, so the session map was never populated and every
request after initialize got 'Server not initialized'. The stateless
design removes the failure mode rather than patching it. Task 2's
characterization test, which pinned that breakage, is replaced here with
real tools/list, tools/call and prompts/list assertions."
```

---

### Task 7: Portability guard

Without this the Workers boundary is a comment. It must be transitive: the violation found during design was the indirect chain `giac/index.ts -> wrapper.ts -> worker-host.ts -> node:child_process`, which a direct-import check would miss.

**Files:**
- Create: `test/http-portability.test.ts`
- Modify: `vitest.config.integration.ts` (add to `include`)
- Modify: `vitest.config.ts` (add to `exclude`)

**Interfaces:**
- Consumes: the build output `dist/server/transports/http-app.js`.
- Produces: nothing importable.

- [ ] **Step 1: Write the test**

Create `test/http-portability.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const ENTRY = 'dist/server/transports/http-app.js';

/** Every `from '...'` / `import('...')` specifier in a compiled ES module. */
function specifiers(source: string): string[] {
  const out: string[] = [];
  const patterns = [/from\s+['"]([^'"]+)['"]/g, /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g];
  for (const re of patterns) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(source)) !== null) out.push(m[1]);
  }
  return out;
}

/**
 * Walk the transitive closure of relative imports starting at `entry`,
 * collecting every bare `node:*` specifier encountered along the way.
 */
function nodeImportsInClosure(entry: string): { file: string; specifier: string }[] {
  const violations: { file: string; specifier: string }[] = [];
  const seen = new Set<string>();
  const queue = [resolve(entry)];

  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file) || !existsSync(file)) continue;
    seen.add(file);

    for (const spec of specifiers(readFileSync(file, 'utf8'))) {
      if (spec.startsWith('node:')) {
        violations.push({ file, specifier: spec });
      } else if (spec.startsWith('.')) {
        queue.push(resolve(dirname(file), spec));
      }
      // Bare package specifiers (hono, @modelcontextprotocol/sdk) are not
      // walked: they are the dependency's own portability problem, and both
      // are Workers-compatible by design — the SDK's web-standard transport
      // documents Cloudflare Workers as a supported target.
    }
  }

  return violations;
}

describe('http-app portability boundary', () => {
  it('has a build to inspect', () => {
    expect(existsSync(ENTRY), `${ENTRY} missing — run \`npm run build\` first`).toBe(true);
  });

  it('imports no node: builtin anywhere in its transitive closure', () => {
    const violations = nodeImportsInClosure(ENTRY);
    const rendered = violations.map((v) => `${v.file} imports ${v.specifier}`).join('\n');
    expect(violations, `Workers portability boundary broken:\n${rendered}`).toEqual([]);
  });

  it('actually walks past the entry file', () => {
    // Guards the guard: if the closure walk silently found nothing to follow,
    // the test above would pass vacuously.
    const source = readFileSync(resolve(ENTRY), 'utf8');
    const relative = specifiers(source).filter((s) => s.startsWith('.'));
    expect(relative.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Register it in the integration config**

In `vitest.config.integration.ts`, the `include` array becomes:

```ts
    include: [
      'test/integration.test.ts',
      'test/golden/tool.golden.test.ts',
      'test/http-contract.test.ts',
      'test/http-portability.test.ts',
    ],
```

- [ ] **Step 3: Keep it out of the unit suite**

In `vitest.config.ts`, the `exclude` array becomes:

```ts
    exclude: [
      'test/integration.test.ts',
      'test/golden/tool.golden.test.ts',
      'test/http-contract.test.ts',
      'test/http-portability.test.ts',
    ],
```

- [ ] **Step 4: Build and run it**

```bash
npm run build && npx vitest run --config vitest.config.integration.ts test/http-portability.test.ts
```

Expected: PASS, 3 tests.

- [ ] **Step 5: Prove the guard actually catches a violation**

Temporarily add this line to the top of `src/server/transports/http-app.ts`:

```ts
import { randomUUID } from 'node:crypto';
```

Then run:

```bash
npm run build && npx vitest run --config vitest.config.integration.ts test/http-portability.test.ts
```

Expected: FAIL with `Workers portability boundary broken: .../http-app.js imports node:crypto`.

**Now remove that line again**, rebuild, and confirm the test passes:

```bash
npm run build && npx vitest run --config vitest.config.integration.ts test/http-portability.test.ts
```

Expected: PASS, 3 tests.

- [ ] **Step 6: Commit**

```bash
git add test/http-portability.test.ts vitest.config.ts vitest.config.integration.ts
git commit -m "test(http): transitive portability guard for the Hono app

Walks the relative-import closure of the built http-app and fails on any
node: builtin. Transitive by necessity — the violation caught during
design was three hops deep."
```

---

### Task 8: Docker and README cleanup

**Files:**
- Modify: `docker/Dockerfile`
- Modify: `docker/docker-compose.yml`
- Modify: `README.md`

**Interfaces:** none.

- [ ] **Step 1: Drop the redundant Giac copy from the image**

In `docker/Dockerfile`, delete this line:

```dockerfile
COPY --from=builder /app/src/server/giac ./src/server/giac
```

Since `173e119` the build copies `giac.wasm.js` into `dist/`, so this line adds a second 9.7 MB copy to the image.

- [ ] **Step 2: Fix the phantom configuration**

Replace the `environment` block and remove the `volumes` entry in `docker/docker-compose.yml` so the service reads:

```yaml
services:
  axiom-math-mcp:
    build:
      context: ..
      dockerfile: docker/Dockerfile
    container_name: axiom-advanced-math-mcp
    environment:
      - NODE_ENV=production
      - MCP_HOST=0.0.0.0
      - MCP_PORT=3000
      - AXIOM_EVAL_TIMEOUT_MS=30000
    ports:
      - '3000:3000'
    restart: unless-stopped
    healthcheck:
      test: ['CMD', 'node', '-e', "fetch('http://127.0.0.1:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 20s
    networks:
      - axiom-network
```

`GIAC_TIMEOUT`, `GIAC_MEMORY`, `LOG_LEVEL` and the `data` volume are all removed: verified, none of them is read anywhere in `src/`.

Also delete the now-unused top-level `volumes:` block at the end of the file.

- [ ] **Step 3: Verify the image builds and is healthy**

```bash
cd docker && docker-compose build && docker-compose up -d
sleep 25 && curl -s http://127.0.0.1:3000/health && echo
docker-compose ps
docker-compose down
cd ..
```

Expected: `/health` returns `{"status":"ok","giac":true,"transport":"stateless"}` and `docker-compose ps` shows the container as `healthy`.

- [ ] **Step 4: Update the README HTTP section**

In `README.md`, replace the `### HTTP Transport` section (currently ending with the `MCP_HOST` table row) with:

````markdown
### HTTP Transport

```bash
# Start HTTP server (default: http://127.0.0.1:3000)
npm run start:http

# Development HTTP
npm run dev:http
```

The HTTP transport is **stateless**: every `POST /mcp` is handled independently,
no `Mcp-Session-Id` is issued, and no session state is kept between requests.
This server sends no server-initiated notifications, so nothing is lost — and it
scales horizontally with no shared state.

| Method | Path      | Behaviour                                              |
| ------ | --------- | ------------------------------------------------------ |
| POST   | `/mcp`    | Handles a JSON-RPC message                             |
| GET    | `/mcp`    | `405` — no SSE stream is offered                       |
| DELETE | `/mcp`    | `405` — there are no sessions to terminate             |
| GET    | `/health` | `200` when ready, `503` when the CAS engine is not     |

> **Security:** there is no authentication yet. The default bind address is
> `127.0.0.1`, but `docker-compose.yml` sets `MCP_HOST=0.0.0.0`. If you expose
> the port, put it behind a reverse proxy that handles authentication.

**Environment variables:**

| Variable                 | Default     | Description                                        |
| ------------------------ | ----------- | -------------------------------------------------- |
| `MCP_PORT`               | `3000`      | HTTP server port                                    |
| `MCP_HOST`               | `127.0.0.1` | HTTP server host                                    |
| `AXIOM_EVAL_TIMEOUT_MS`  | `10000`     | Per-evaluation CAS timeout, in milliseconds         |
| `AXIOM_COMPUTE_HYGIENE`  | unset       | Set to `1` to enable compute output post-processing |
````

- [ ] **Step 5: Run the full suite one more time**

```bash
npm run build
npm test
npx vitest run --config vitest.config.integration.ts
npm run typecheck
npx oxlint src
```

Expected: unit suite `630 passed`; integration suite green; typecheck silent; lint `0 warnings and 0 errors`.

- [ ] **Step 6: Commit**

```bash
git add docker/Dockerfile docker/docker-compose.yml README.md
git commit -m "chore(docker,docs): drop phantom config, add healthcheck

GIAC_TIMEOUT, GIAC_MEMORY, LOG_LEVEL and the data volume were never read
by any code. The Dockerfile's second copy of giac.wasm.js is redundant
since the build copies it into dist/. README documents the stateless
contract, the 405s, and the two previously undocumented env vars."
```

---

## Done criteria

- `npm test` green (630 tests), `npx vitest run --config vitest.config.integration.ts` green.
- `grep -rn "express" src/ package.json` returns nothing.
- The portability guard fails when a `node:` import is added to `http-app.ts` and passes when it is removed (proven in Task 7 Step 5).
- The Task 2 contract tests pass against both the Express baseline and the Hono implementation.
- Docker image builds, reports `healthy`, and `/health` returns `transport: "stateless"`.
