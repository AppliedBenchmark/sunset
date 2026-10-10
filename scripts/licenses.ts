// Writes THIRD_PARTY_LICENSES: the license of every npm package in the Action and CLI bundles,
// found from the bundles' esbuild metafiles. Run it after a dependency change.
//
//   npm run licenses
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bundledPackages, noticeText } from './third-party.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const out = mkdtempSync(join(tmpdir(), 'sunset-licenses-'));
try {
  const build = spawnSync(
    process.execPath,
    ['build.mjs', '--outdir', join(out, 'dist'), '--metafile', join(out, 'meta')],
    { cwd: root, stdio: 'inherit' },
  );
  if (build.status !== 0) process.exit(build.status ?? 1);
  const inputs = ['action', 'cli'].flatMap((name) =>
    Object.keys(
      (
        JSON.parse(readFileSync(join(out, 'meta', `${name}.meta.json`), 'utf8')) as {
          inputs: Record<string, unknown>;
        }
      ).inputs,
    ),
  );
  const packages = bundledPackages(root, inputs);
  writeFileSync(join(root, 'THIRD_PARTY_LICENSES'), noticeText(packages));
  console.log(`THIRD_PARTY_LICENSES: ${packages.map((p) => `${p.name}@${p.version}`).join(', ')}`);
} finally {
  rmSync(out, { recursive: true, force: true });
}
