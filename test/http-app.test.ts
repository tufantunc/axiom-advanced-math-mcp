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
