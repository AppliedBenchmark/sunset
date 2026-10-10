// Bundles the Action and the CLI with esbuild.
//
//   node build.mjs                      writes dist/action/index.js and dist/cli/index.js
//   node build.mjs --outdir <dir>       writes the bundles somewhere else
//   node build.mjs --metafile <dir>     also writes <name>.meta.json for the bundle-content test
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { build } from 'esbuild';

const { values } = parseArgs({
  options: { outdir: { type: 'string', default: 'dist' }, metafile: { type: 'string' } },
});

const pkg = JSON.parse(await readFile(new URL('./package.json', import.meta.url), 'utf8'));

// @actions/core is ESM-only but some dependencies are CommonJS and call require().
const requireShim =
  "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);";

const entries = [
  { name: 'action', entry: 'src/action/main.ts', banner: requireShim },
  { name: 'cli', entry: 'src/cli/main.ts', banner: `#!/usr/bin/env node\n${requireShim}` },
];

for (const { name, entry, banner } of entries) {
  const result = await build({
    entryPoints: [entry],
    outfile: join(values.outdir, name, 'index.js'),
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    banner: { js: banner },
    define: { __SUNSET_VERSION__: JSON.stringify(pkg.version) },
    loader: { '.yaml': 'text' },
    metafile: true,
    logLevel: 'warning',
  });
  if (values.metafile) {
    await mkdir(values.metafile, { recursive: true });
    await writeFile(join(values.metafile, `${name}.meta.json`), JSON.stringify(result.metafile));
  }
}
