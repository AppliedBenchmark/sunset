// The npm packages esbuild puts into the bundles, and the THIRD_PARTY_LICENSES text for them.
// Shared by scripts/licenses.ts, which writes the file, and test/bundle.test.ts, which checks it.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface BundledPackage {
  name: string;
  version: string;
  license: string;
  text: string;
}

/** An esbuild metafile's `inputs` keys are paths relative to the build's working directory. */
const PACKAGE_DIR = /^(.*node_modules\/(?:@[^/]+\/)?[^/]+)\//;
const LICENSE_FILE = /^(?:licen[cs]e|copying)(?:[.-].*)?$/i;

/** The packages behind the `node_modules` inputs of one or more metafiles, sorted by name. */
export function bundledPackages(root: string, inputs: Iterable<string>): BundledPackage[] {
  const dirs = new Set<string>();
  for (const input of inputs) {
    const dir = PACKAGE_DIR.exec(input)?.[1];
    if (dir) dirs.add(dir);
  }
  const packages = [...dirs].map((dir) => {
    const manifest = JSON.parse(readFileSync(join(root, dir, 'package.json'), 'utf8')) as {
      name: string;
      version: string;
      license?: string;
    };
    const file = readdirSync(join(root, dir)).find((name) => LICENSE_FILE.test(name));
    if (!file) throw new Error(`${manifest.name} has no license file in ${dir}`);
    return {
      name: manifest.name,
      version: manifest.version,
      license: manifest.license ?? 'see below',
      text: readFileSync(join(root, dir, file), 'utf8').trim(),
    };
  });
  return packages.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

export function noticeText(packages: readonly BundledPackage[]): string {
  const rule = '='.repeat(80);
  const sections = packages.map(
    (p) => `${rule}\n${p.name} ${p.version} (${p.license})\n${rule}\n\n${p.text}\n`,
  );
  return [
    'Third-party software in Sunset',
    '',
    'The Action (dist/action/index.js) and the CLI (dist/cli/index.js) are bundles that contain the',
    'npm packages below. Each one is followed by its license. This file is written by',
    '`npm run licenses` from the bundles; a test fails when it is out of date.',
    '',
    ...sections,
  ].join('\n');
}
