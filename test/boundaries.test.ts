// Boundary self-test: lints deliberately violating files with the project's real Biome config and
// the oxlint rule set, and expects every layer rule in CONTRIBUTING.md ("Layout") to fire. If a config change
// silently disables a rule, this test fails.
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('..', import.meta.url));
const fixture = join(root, 'test/fixtures/boundary');

interface Diagnostic {
  category: string;
  location: { path: string };
}

let workdir: string;

beforeAll(() => {
  // A copy outside the repository, so the includes in biome.json match `src/core/**` as usual.
  workdir = mkdtempSync(join(tmpdir(), 'sunset-boundary-'));
  cpSync(fixture, workdir, { recursive: true });
  const config = JSON.parse(readFileSync(join(root, 'biome.json'), 'utf8'));
  delete config.$schema;
  config.vcs = { enabled: false };
  writeFileSync(join(workdir, 'biome.json'), JSON.stringify(config));
  // oxlint looks for its tsgolint binary under ./node_modules.
  symlinkSync(join(root, 'node_modules'), join(workdir, 'node_modules'), 'junction');
  writeFileSync(
    join(workdir, 'tsconfig.json'),
    JSON.stringify({ compilerOptions: { strict: true, module: 'nodenext', noEmit: true } }),
  );
});

afterAll(() => {
  rmSync(workdir, { recursive: true, force: true });
});

function biome(): Diagnostic[] {
  const bin = require.resolve('@biomejs/biome/bin/biome');
  const run = spawnSync(
    process.execPath,
    [bin, 'lint', '--reporter=json', '--max-diagnostics=none', '.'],
    {
      cwd: workdir,
      encoding: 'utf8',
    },
  );
  expect(run.status, run.stderr).toBe(1);
  const json = run.stdout.slice(run.stdout.indexOf('{'), run.stdout.lastIndexOf('}') + 1);
  return (JSON.parse(json) as { diagnostics: Diagnostic[] }).diagnostics;
}

describe('Biome layer rules', () => {
  let found: Set<string>;
  beforeAll(() => {
    found = new Set(biome().map((d) => `${d.location.path.replaceAll('\\', '/')} ${d.category}`));
  });

  it.each([
    ['src/core/imports-node.ts', 'lint/style/noRestrictedImports'],
    ['src/core/imports-adapter.ts', 'lint/style/noRestrictedImports'],
    ['src/core/imports-actions.ts', 'lint/style/noRestrictedImports'],
    ['src/core/uses-globals.ts', 'lint/style/noRestrictedGlobals'],
    ['src/core/cycle-a.ts', 'lint/suspicious/noImportCycles'],
    ['src/report/imports-adapter.ts', 'lint/style/noRestrictedImports'],
    ['src/cli/imports-updater.ts', 'lint/style/noRestrictedImports'],
    ['src/adapters/promises-and-switch.ts', 'lint/nursery/noFloatingPromises'],
    ['src/adapters/promises-and-switch.ts', 'lint/nursery/noMisusedPromises'],
  ])('%s is reported by %s', (path, rule) => {
    expect([...found]).toContain(`${path} ${rule}`);
  });

  it('flags all three restricted globals in core', () => {
    const globals = biome().filter(
      (d) =>
        d.location.path.endsWith('uses-globals.ts') &&
        d.category === 'lint/style/noRestrictedGlobals',
    );
    expect(globals).toHaveLength(3);
  });

  it('leaves the adapters themselves alone', () => {
    expect([...found].filter((f) => f.startsWith('src/adapters/adapter.ts'))).toEqual([]);
  });
});

describe('oxlint type-aware rules', () => {
  it('reports the floating promise, the misused promise and the non-exhaustive switch', () => {
    // The package's exports hide its bin, so resolve the file directly.
    const bin = join(root, 'node_modules/oxlint/bin/oxlint');
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    // Reuse the exact flags from `npm run lint:types`, pointed at the fixture instead.
    const flags = (pkg.scripts['lint:types'] ?? '')
      .split(' ')
      .slice(1)
      .filter((arg) => arg !== 'src' && arg !== 'updater');
    const args = [bin, ...flags, '--format=json', 'src'];
    const run = spawnSync(process.execPath, args, { cwd: workdir, encoding: 'utf8' });
    expect(run.status, run.stderr || run.stdout).toBe(1);
    const { diagnostics } = JSON.parse(run.stdout) as { diagnostics: { code: string }[] };
    expect(diagnostics.map((d) => d.code).sort()).toEqual([
      'typescript(no-floating-promises)',
      'typescript(no-misused-promises)',
      'typescript(switch-exhaustiveness-check)',
    ]);
  });
});
