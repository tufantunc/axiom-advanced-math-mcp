import { describe, it, expect } from 'vitest';
import { createMutex, withGiacSession } from '../src/server/giac/session-lock.js';
import { isCacheable } from '../src/server/giac/cache.js';

describe('createMutex', () => {
  it('serializes holders — a second acquire waits for the first release', async () => {
    const m = createMutex();
    const order: string[] = [];

    const releaseA = await m.acquire();
    const b = (async () => {
      const releaseB = await m.acquire();
      order.push('b');
      releaseB();
    })();

    await Promise.resolve();
    order.push('a');
    releaseA();
    await b;

    expect(order).toEqual(['a', 'b']);
  });

  it('serves waiters FIFO', async () => {
    const m = createMutex();
    const order: number[] = [];
    const release0 = await m.acquire();

    const waiters = [1, 2, 3].map((n) =>
      m.acquire().then((release) => {
        order.push(n);
        release();
      })
    );

    release0();
    await Promise.all(waiters);
    expect(order).toEqual([1, 2, 3]);
  });

  it('is not wedged by a double release', async () => {
    const m = createMutex();
    const release = await m.acquire();
    release();
    release();
    // A second and third holder must still be able to take it — the double
    // release must not have wedged the mutex or corrupted its grant count.
    const second = await m.acquire();
    expect(typeof second).toBe('function');
    second();
    const third = await m.acquire();
    expect(typeof third).toBe('function');
    third();
  });
});

describe('withGiacSession', () => {
  it('does not interleave two concurrent tool calls', async () => {
    const trace: string[] = [];
    const wrapped = withGiacSession(async (name: string) => {
      trace.push(`${name}:start`);
      await new Promise((r) => setTimeout(r, 5));
      trace.push(`${name}:end`);
      return name;
    });

    await Promise.all([wrapped('a'), wrapped('b')]);
    // Whichever order they run in, neither may start inside the other.
    expect(trace).toSatisfy(
      (t: string[]) =>
        t.join(',') === 'a:start,a:end,b:start,b:end' ||
        t.join(',') === 'b:start,b:end,a:start,a:end'
    );
  });

  it('releases the lock when the handler throws', async () => {
    const boom = withGiacSession(async () => {
      throw new Error('handler exploded');
    });
    const ok = withGiacSession(async () => 'ok');

    await expect(boom(undefined)).rejects.toThrow('handler exploded');
    // Would hang (and fail the test timeout) if the lock leaked.
    await expect(ok(undefined)).resolves.toBe('ok');
  });

  it('does not deadlock when a wrapped handler re-enters', async () => {
    const inner = withGiacSession(async () => 'inner');
    const outer = withGiacSession(async () => `outer+${await inner(undefined)}`);

    await expect(outer(undefined)).resolves.toBe('outer+inner');
  });
});

describe('isCacheable', () => {
  it('rejects state-mutating constructs', () => {
    for (const expr of ['sto(9,d)', 'simplify(sto(5,c1)+1)', 'a:=5', 'assume(b>0)', 'purge(x)']) {
      expect(isCacheable(expr), expr).toBe(false);
    }
  });

  it('accepts ordinary expressions', () => {
    for (const expr of ['simplify(x+1)', 'integrate(sqrt(b^2),b)', 'factor(x^2-4)', 'C(10,3)']) {
      expect(isCacheable(expr), expr).toBe(true);
    }
  });
});
