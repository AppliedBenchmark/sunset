// Builds both bundles into a temporary directory, runs them, and checks what went into them.
import { spawn, spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bundledPackages, noticeText } from '../scripts/third-party.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
  version: string;
};

interface Metafile {
  inputs: Record<string, unknown>;
}

/** Laid out like the Action's repository: `dist/` next to `registry/`. */
let outroot: string;
let outdir: string;
/** A tiny repository to scan, so the bundles never touch this one. */
let workdir: string;

beforeAll(() => {
  outroot = mkdtempSync(join(tmpdir(), 'sunset-bundle-'));
  outdir = join(outroot, 'dist');
  for (const name of ['models.yaml', 'formats.yaml']) {
    cpSync(join(root, 'registry', name), join(outroot, 'registry', name));
  }
  workdir = mkdtempSync(join(tmpdir(), 'sunset-bundle-work-'));
  writeFileSync(join(workdir, 'app.py'), 'M = "not-a-model"\n');
  const build = spawnSync(
    process.execPath,
    ['build.mjs', '--outdir', outdir, '--metafile', join(outdir, 'meta')],
    { cwd: root, encoding: 'utf8' },
  );
  expect(build.status, build.stderr).toBe(0);
}, 30_000);

afterAll(() => {
  rmSync(outroot, { recursive: true, force: true });
  rmSync(workdir, { recursive: true, force: true });
});

/**
 * Only what a process needs: on a CI runner, inheriting GITHUB_STEP_SUMMARY and the like would let
 * the Action bundle write into the real job.
 */
const BASE_ENV: NodeJS.ProcessEnv = Object.fromEntries(
  ['PATH', 'HOME', 'USERPROFILE', 'SystemRoot', 'TEMP', 'TMP', 'TMPDIR'].flatMap((key) =>
    process.env[key] === undefined ? [] : [[key, process.env[key]]],
  ),
);

function run(
  name: string,
  args: string[] = [],
  env: NodeJS.ProcessEnv = {},
  cwd = workdir,
): string {
  const result = spawnSync(process.execPath, [join(outdir, name, 'index.js'), ...args], {
    encoding: 'utf8',
    cwd,
    env: { ...BASE_ENV, ...env },
  });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout;
}

function inputs(name: string): string[] {
  const meta = JSON.parse(
    readFileSync(join(outdir, 'meta', `${name}.meta.json`), 'utf8'),
  ) as Metafile;
  return Object.keys(meta.inputs);
}

describe.each(['action', 'cli'])('%s bundle', (name) => {
  it('contains no updater code', () => {
    // The updater and its dependencies are never bundled.
    expect(
      inputs(name).filter((input) => /(^|\/)updater\/|node_modules\/cheerio\//.test(input)),
    ).toEqual([]);
  });
});

it('the CLI bundle prints its version and scans with the bundled registry', () => {
  expect(run('cli', ['--version'])).toBe(`sunset ${version}\n`);
  const report = JSON.parse(run('cli', ['scan', '--registry', 'bundled', '--format', 'json']));
  expect(report.tool).toEqual({ name: 'sunset', version });
  expect(report.registry.origin).toBe('bundled');
  expect(report.stats.files.scanned).toBe(1);
});

it('the Action bundle reads the registry from its repository, not from the bundle', () => {
  expect(inputs('action').filter((input) => input.endsWith('.yaml'))).toEqual([]);
  expect(inputs('cli')).toEqual(
    expect.arrayContaining(['registry/models.yaml', 'registry/formats.yaml']),
  );
});

it('the Action bundle runs like the runner runs it', () => {
  // The runner passes inputs as INPUT_<NAME> variables and reads outputs from GITHUB_OUTPUT.
  const output = join(workdir, 'github-output');
  writeFileSync(output, '');
  const log = run('action', [], {
    INPUT_REGISTRY: 'bundled',
    'INPUT_PR-COMMENT': 'false',
    GITHUB_OUTPUT: output,
    GITHUB_WORKSPACE: workdir,
  });
  expect(log).toContain('registry: bundled v');
  expect(readFileSync(output, 'utf8')).toMatch(/registry-origin<<.*\r?\nbundled\r?\n/);
});

it('THIRD_PARTY_LICENSES covers exactly the packages in the bundles', () => {
  const packages = bundledPackages(root, [...inputs('action'), ...inputs('cli')]);
  expect(packages.length).toBeGreaterThan(0);
  // Out of date after a dependency change: run `npm run licenses`.
  expect(readFileSync(join(root, 'THIRD_PARTY_LICENSES'), 'utf8')).toBe(noticeText(packages));
});

it('the npm package declares no runtime dependencies: the CLI bundle is self-contained', () => {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>;
  };
  expect(pkg.dependencies ?? {}).toEqual({});
});

it.skipIf(process.platform === 'win32')(
  "the Action's log can't carry workflow commands in a file name",
  () => {
    const repo = mkdtempSync(join(tmpdir(), 'sunset-bundle-commands-'));
    const dir = join(repo, 'x\n::error file=README.md,line=1::All clear\n::stop-commands::x\ny');
    mkdirSync(dir);
    // The manifest path is logged when the platforms are inferred from it.
    writeFileSync(join(dir, 'package.json'), '{"dependencies": {"openai": "6"}}');
    const output = join(repo, 'github-output');
    writeFileSync(output, '');
    const log = run(
      'action',
      [],
      {
        INPUT_REGISTRY: 'bundled',
        'INPUT_PR-COMMENT': 'false',
        GITHUB_OUTPUT: output,
        GITHUB_WORKSPACE: repo,
      },
      repo,
    );
    rmSync(repo, { recursive: true, force: true });
    expect(log).toContain('inferred from x\\u000a::error');
    // Sunset's own `::debug::` lines are fine; the file name's commands must not start a line.
    expect(log).not.toMatch(/^::(?:error file=README|stop-commands)/m);
  },
);

it("the Action's log can't carry terminal escapes from the repository's config", () => {
  const repo = mkdtempSync(join(tmpdir(), 'sunset-bundle-escapes-'));
  // A clipboard write (OSC 52) and a screen clear, which a ConfigError quotes.
  writeFileSync(join(repo, '.sunset.yml'), '"\\e]52;c;cHduZWQ=\\a\\e[2J": 1\nfail-on: never\n');
  const result = spawnSync(process.execPath, [join(outdir, 'action', 'index.js')], {
    encoding: 'utf8',
    cwd: repo,
    env: { ...BASE_ENV, INPUT_REGISTRY: 'bundled', GITHUB_WORKSPACE: repo },
  });
  rmSync(repo, { recursive: true, force: true });
  expect(result.status).toBe(1);
  // core.setFailed escapes the line breaks; the runner shows them as line breaks.
  expect(result.stdout).toContain(
    'is not valid:%0A  - the file: unknown key "\\u001b]52;c;cHduZWQ=\\u0007\\u001b[2J"',
  );
  expect(result.stdout).not.toContain('\u001b');
  expect(result.stdout).not.toContain('\u0007');
});

it('the CLI bundle exits quietly when its output pipe closes early', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'sunset-bundle-pipe-'));
  // A report far larger than a pipe's buffer.
  writeFileSync(join(repo, 'app.py'), 'M = "gpt-4.5-preview"\n'.repeat(5000));
  const args = ['scan', '--registry', 'bundled', '--format', 'json', '--fail-on', 'never'];
  const child = spawn(process.execPath, [join(outdir, 'cli', 'index.js'), ...args], {
    cwd: repo,
    env: BASE_ENV,
  });
  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  child.stdout.once('data', () => child.stdout.destroy());
  const code = await new Promise((done) => child.on('close', done));
  rmSync(repo, { recursive: true, force: true });
  expect(stderr).not.toContain('EPIPE');
  expect(code).toBe(0);
});

it('the CLI bundle starts with a shebang', () => {
  expect(readFileSync(join(outdir, 'cli', 'index.js'), 'utf8')).toMatch(
    /^#!\/usr\/bin\/env node\n/,
  );
});
