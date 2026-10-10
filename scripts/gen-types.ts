// Generates src/core/registry/types.gen.ts from registry/schema.json.
//
//   npm run gen:types              writes the file
//   npm run gen:types -- --check   fails if the committed file is stale (CI)
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { compile, type JSONSchema } from 'json-schema-to-typescript';

const { values } = parseArgs({ options: { check: { type: 'boolean', default: false } } });

const root = fileURLToPath(new URL('..', import.meta.url));
const schemaPath = `${root}registry/schema.json`;
const outPath = `${root}src/core/registry/types.gen.ts`;

const schema = JSON.parse(readFileSync(schemaPath, 'utf8')) as JSONSchema;
const generated = await compile(schema, 'Registry', {
  bannerComment:
    '// Generated from registry/schema.json by `npm run gen:types`. Do not edit; CI fails if it is stale.',
  additionalProperties: false,
  unreachableDefinitions: true,
  ignoreMinAndMaxItems: true,
  format: false,
});

// Format with Biome so the file matches the rest of the code base. Its bin is a Node script, run
// with this Node and no shell, so paths with spaces work on Windows too.
const biome = createRequire(import.meta.url).resolve('@biomejs/biome/bin/biome');
const formatted = execFileSync(
  process.execPath,
  [biome, 'format', `--stdin-file-path=${outPath}`],
  {
    input: generated,
    encoding: 'utf8',
  },
);

if (values.check) {
  if (readFileSync(outPath, 'utf8') !== formatted) {
    console.error(
      'src/core/registry/types.gen.ts is stale. Run `npm run gen:types` and commit it.',
    );
    process.exitCode = 1;
  }
} else {
  writeFileSync(outPath, formatted);
}
