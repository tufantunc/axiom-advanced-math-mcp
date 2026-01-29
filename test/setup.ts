import { vi } from 'vitest';

vi.mock('../src/server/giac/index.js', async () => {
  const actual = await vi.importActual<typeof import('../src/server/giac/index.mock.js')>('../src/server/giac/index.mock.js');
  return actual;
});
