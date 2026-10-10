// Rewrites registry/models.yaml in the layout the updater writes (updater/registry-yaml.ts), so a
// hand edit passes the byte-for-byte check in test/updater/registry-yaml.test.ts.
//
//   npm run registry:format
import { readFileSync, writeFileSync } from 'node:fs';
import { parse } from 'yaml';
import type { Registry } from '../src/core/types.ts';
import { formatRegistry, headerOf } from '../updater/registry-yaml.ts';

const path = new URL('../registry/models.yaml', import.meta.url);
const text = readFileSync(path, 'utf8');
const formatted = formatRegistry(parse(text) as Registry, headerOf(text));
if (formatted === text) {
  console.log('registry/models.yaml is already formatted.');
} else {
  writeFileSync(path, formatted);
  console.log('Formatted registry/models.yaml.');
}
