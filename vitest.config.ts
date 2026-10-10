import { readFileSync } from 'node:fs';
import { defineConfig } from 'vitest/config';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as {
  version: string;
};

export default defineConfig({
  // Like esbuild's `.yaml: 'text'` loader in build.mjs: the bundled registry is imported as text.
  plugins: [
    {
      name: 'yaml-text',
      transform: (code, id) =>
        id.endsWith('.yaml')
          ? { code: `export default ${JSON.stringify(code)};`, map: null }
          : null,
    },
  ],
  define: { __SUNSET_VERSION__: JSON.stringify(pkg.version) },
  test: {
    include: ['test/**/*.test.ts'],
    // The hosted runners, with coverage on, take up to 5 or 6 seconds for tests that take 1 here
    // (the lexers' adversarial inputs, a large file, validating the registry). Those tests check
    // what comes out, or how time grows with the input, not the time itself.
    testTimeout: 30_000,
    // `npm test` turns coverage on (`--coverage`); a run of a few files leaves it off, so the
    // threshold doesn't fail it.
    coverage: {
      provider: 'v8',
      include: ['src/**'],
      reporter: ['text-summary', 'html'],
      thresholds: { 'src/core/**': { lines: 90 } },
    },
  },
});
