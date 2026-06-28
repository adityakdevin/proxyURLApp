/**
 * Jest config for API/HTTP end-to-end tests (supertest-driven).
 *
 * Separate from the unit/integration config so the fast feedback loop
 * (`npm test`) never boots the full app or needs a running database, while
 * `npm run test:e2e:api` runs the slower, DB-backed e2e specs.
 *
 * Requires TEST_DATABASE_URL to point at a disposable MySQL schema (see
 * docs/testing/e2e-test-plan.md).
 *
 * @type {import('jest').Config}
 */
export default {
  preset: 'ts-jest/presets/default-esm',
  testEnvironment: 'node',
  extensionsToTreatAsEsm: ['.ts'],
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  transform: {
    // isolatedModules is read from tsconfig.json (ts-jest's own option is deprecated).
    '^.+\\.ts$': ['ts-jest', { useESM: true }],
  },
  testMatch: ['<rootDir>/src/__tests__/e2e/**/*.e2e.test.ts'],
  // e2e specs share one DB and the in-process validation drain — run serially.
  maxWorkers: 1,
  testTimeout: 30000,
};
