import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.{ts,mjs}'],
    environment: 'node',
    passWithNoTests: false,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary', 'json', 'html'],
      include: ['src/**/*.{ts,tsx}'],
      exclude: [
        // These two files contain only erased public type declarations.
        'src/shared/types.ts',
        'src/client/types.ts',
      ],
      thresholds: {
        // Global thresholds cover every executable source file.  These are
        // deliberately below the current measured baseline so new modules
        // must carry tests without making the gate brittle to generated/UI
        // branch shape changes.
        lines: 78,
        functions: 80,
        branches: 60,
        statements: 75
      }
    }
  }
})
