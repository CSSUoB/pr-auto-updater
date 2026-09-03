import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    setupFiles: ['./test/config.ts'],
    clearMocks: true,
    include: ['test/**/*.test.ts'],
    server: {
      deps: {
        // `@actions/core` is real ESM; Vitest externalizes third-party ESM by
        // default, which leaves its export bindings non-configurable and
        // unspyable. Inlining it routes it through Vite's transform instead,
        // the same as local `src/` modules, so `vi.spyOn(core, ...)` works.
        inline: ['@actions/core'],
      },
    },
    reporters: ['default', 'junit'],
    outputFile: { junit: './junit.xml' },
    coverage: {
      enabled: true,
      provider: 'v8',
      reportsDirectory: 'coverage',
      // Report on every source file, not just the ones a test happens to import,
      // so an untested new file shows up as a gap rather than being invisible.
      include: ['src/**/*.ts'],
      // Type-only module: it compiles to nothing, so there is no code to cover.
      exclude: ['src/types.ts'],
      thresholds: {
        branches: 100,
        functions: 100,
        lines: 100,
        statements: 100,
      },
    },
  },
});
