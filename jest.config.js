module.exports = {
  testEnvironment: 'node',
  setupFiles: ['<rootDir>/test/config.ts'],
  clearMocks: true,
  // Only ever run the TypeScript sources; a stray compiled .js alongside them
  // would otherwise be collected and every test would run twice.
  testMatch: ['<rootDir>/test/**/*.test.ts'],
  collectCoverage: true,
  // Report on every source file, not just the ones a test happens to import,
  // so an untested new file shows up as a gap rather than being invisible.
  collectCoverageFrom: [
    'src/**/*.ts',
    // Type-only module: it compiles to nothing, so there is no code to cover.
    '!src/types.ts',
  ],
  coverageDirectory: 'coverage',
  coverageProvider: 'v8',
  coverageThreshold: {
    global: {
      branches: 100,
      functions: 100,
      lines: 100,
      statements: 100,
    },
  },
  transform: {
    '^.+\\.(ts|tsx)$': 'babel-jest',
  },
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json', 'node'],
};
