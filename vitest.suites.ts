/**
 * Which test files belong to the integration suite.
 *
 * This list used to exist twice — as `exclude` in vitest.config.ts and as
 * `include` in vitest.config.integration.ts — with nothing asserting the two
 * were complements. Both divergences were silent:
 *
 *   - added to the unit config's exclude only  -> the file runs in NEITHER
 *     suite, both CI jobs stay green, and nothing reports it;
 *   - added to the integration config only     -> the unit config's
 *     `test/**\/*.test.ts` glob picks it up too, so it also runs under
 *     `npm test`, without the `npm run build` prefix that the integration
 *     suite exists to provide, against a stale or absent dist/.
 *
 * One list, two readers, plus the partition test in test/suite-membership.test.ts.
 */
export const INTEGRATION_TESTS: string[] = [
  'test/integration.test.ts',
  'test/golden/tool.golden.test.ts',
  'test/http-contract.test.ts',
  'test/http-portability.test.ts',
  'test/cli-contract.test.ts',
];
