/** @type {import('jest').Config} */
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
  testMatch: ['<rootDir>/src/**/__tests__/**/*.test.ts'],
  // E2E specs (supertest, DB-backed) run via jest.e2e.config.mjs — keep the
  // default `npm test` loop fast and DB-free by excluding them here.
  testPathIgnorePatterns: ['/node_modules/', '\\.e2e\\.test\\.ts$'],
  testTimeout: 15000,
  maxWorkers: 1,
};
