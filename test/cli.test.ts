// The CLI, run in-process: commands, formats, exit codes and logging.
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';
import { EXIT, runCli, USAGE } from '../src/cli/run.ts';
import { bundledFixture, FIXTURE_TODAY, root } from './helpers.ts';

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'sunset-cli-'));
  writeFileSync(
    join(dir, 'app.py'),
    'A = "gpt-fixture-retired"\nB = "gpt-fixture-2-2099-02-15"\nmodel = os.environ["M"]\n',
  );
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

async function cli(
  argv: string[],
  opts: { fetch?: typeof fetch; cwd?: string; bundled?: typeof bundledFixture } = {},
) {
  let stdout = '';
  let stderr = '';
  const code = await runCli({
    argv,
    cwd: opts.cwd ?? dir,
    stdout: { write: (t: string) => (stdout += t) },
    stderr: { write: (t: string) => (stderr += t) },
    bundled: opts.bundled ?? bundledFixture,
    // Every test is offline unless it passes its own fetch.
    fetch:
      opts.fetch ??
      (async () => {
        throw new Error('offline');
      }),
  });
  return { code, stdout, stderr };
}

const SCAN = ['scan', '--today', FIXTURE_TODAY, '--registry', 'bundled'];

describe('sunset', () => {
  it('prints the version and the help', async () => {
    expect(await cli(['--version'])).toMatchObject({
      code: 0,
      stdout: expect.stringMatching(/^sunset \S+\n$/),
    });
    expect(await cli(['--help'])).toMatchObject({ code: 0, stdout: `${USAGE}\n` });
    expect(await cli(['scan', '--help'])).toMatchObject({ code: 0, stdout: `${USAGE}\n` });
    // No command is a usage error, but still shows the help, on stderr.
    expect(await cli([])).toMatchObject({ code: EXIT.usage, stdout: '', stderr: `${USAGE}\n` });
  });

  it('exits 2 on usage errors', async () => {
    for (const argv of [
      ['frobnicate'],
      ['registry'],
      ['registry', 'publish'],
      ['scan', '--bogus'],
      ['scan', 'a', 'b'],
      ['scan', 'missing-dir'],
      ['scan', '--format', 'xml'],
      ['scan', '--today', '2099-13-01'],
      ['scan', '--fail-on', 'notice'],
      ['scan', '--platforms', 'azure'],
    ]) {
      const { code, stderr } = await cli(argv);
      expect(code, argv.join(' ')).toBe(EXIT.usage);
      expect(stderr).toMatch(/^sunset: /);
    }
  });
});

describe('sunset scan', () => {
  it('prints the text report, logs to stderr, and exits 1 on an error-level finding', async () => {
    const { code, stdout, stderr } = await cli([...SCAN, '--no-color']);
    expect(code).toBe(EXIT.findings);
    expect(stdout).toContain('app.py:1:6');
    expect(stdout).not.toContain('\u001b[');
    expect(stderr).toContain('sunset: registry: bundled v1 (27 entries, newest check 2099-01-01)');
    expect(stderr).toMatch(/sunset: scanned 1 of 1 file \(1 lexed\), 3 lines, in \d+ ms/);
    expect(stderr).toContain('1 finding at or above fail-on (error)');
  });

  it('writes every count in its log the same way, and whole milliseconds', async () => {
    const many = mkdtempSync(join(tmpdir(), 'sunset-cli-many-'));
    for (let i = 0; i < 1_000; i++) {
      writeFileSync(join(many, `m${i}.py`), 'M = "gpt-fixture-retired"\n');
    }
    const { stderr } = await cli([...SCAN, many, '--debug', '-f', 'json']);
    expect(stderr).toMatch(
      /^sunset: scanned 1,000 of 1,000 files \(1,000 lexed\), 1,000 lines, in [\d,]+ ms$/m,
    );
    expect(stderr).toMatch(/^sunset: 1,000 findings at or above fail-on \(error\)$/m);
    expect(stderr).toMatch(
      /^sunset: debug: scanned 1,000 of 1,000 files \(1,000 lexed\) in [\d,]+ ms$/m,
    );
    expect(stderr).toMatch(/^sunset: debug: timings: list [\d,]+ ms, scan [\d,]+ ms$/m);
    rmSync(many, { recursive: true, force: true });
  });

  it.each([
    ['never', EXIT.ok],
    ['warning', EXIT.findings],
  ])('honours --fail-on %s', async (level, expected) => {
    const r = await cli([...SCAN, '--fail-on', level]);
    expect(r.code, r.stderr).toBe(expected);
  });

  it('writes each format to stdout or --output', async () => {
    const json = await cli([...SCAN, '--format', 'json']);
    const report = JSON.parse(json.stdout);
    expect(report).toMatchObject({ report_version: 1, today: FIXTURE_TODAY });
    expect(report.findings).toHaveLength(2);
    expect(report.unresolved).toHaveLength(1);

    const sarif = await cli([...SCAN, '-f', 'sarif', '-o', 'out/report.sarif']);
    expect(sarif.stdout).toBe('');
    expect(sarif.stderr).toContain('wrote the sarif report to out/report.sarif');
    expect(JSON.parse(readFileSync(join(dir, 'out/report.sarif'), 'utf8')).version).toBe('2.1.0');

    const md = await cli([...SCAN, '--format', 'markdown']);
    expect(md.stdout).toMatch(/^## Sunset/);
  });

  it('scans a path relative to the working directory', async () => {
    const { code, stdout } = await cli([...SCAN, '-f', 'json', '.'], { cwd: dir });
    expect(code).toBe(EXIT.findings);
    expect(JSON.parse(stdout).findings[0].location.path).toBe('app.py');
    const outside = await cli([...SCAN, '-f', 'json', dir], { cwd: root });
    expect(outside.stdout).toBe(stdout);
  });

  it('reads .sunset.yml, and lets flags override it', async () => {
    const sub = mkdtempSync(join(dir, 'configured-'));
    cpSync(join(dir, 'app.py'), join(sub, 'app.py'));
    writeFileSync(
      join(sub, '.sunset.yml'),
      'fail-on: never\nignore:\n  - paths: [app.py]\n    rules: [sunset/model-retired]\n',
    );
    const fromFile = await cli([...SCAN, sub, '-f', 'json']);
    expect(fromFile.code).toBe(EXIT.ok);
    expect(JSON.parse(fromFile.stdout).suppressed).toHaveLength(1);
    expect(fromFile.stderr).toContain(`config: ${join(sub, '.sunset.yml')}`);
    expect((await cli([...SCAN, sub, '--fail-on', 'warning'])).code).toBe(EXIT.findings);

    // The config file names model IDs on purpose; it is never scanned, whatever its name.
    writeFileSync(
      join(sub, '.sunset.yml'),
      'ignore:\n  - paths: [legacy/**]\n    models: [gpt-fixture-retired]\n',
    );
    const ownConfig = JSON.parse((await cli([...SCAN, sub, '-f', 'json'])).stdout);
    expect(ownConfig.findings.map((f: { location: { path: string } }) => f.location.path)).toEqual([
      'app.py',
      'app.py',
    ]);
    cpSync(join(sub, '.sunset.yml'), join(sub, 'sunset-ci.yml'));
    const named = await cli([...SCAN, sub, '-f', 'json', '--config', join(sub, 'sunset-ci.yml')]);
    expect(JSON.parse(named.stdout).findings).toHaveLength(2);

    writeFileSync(join(sub, '.sunset.yml'), 'fail_on: never\n');
    const invalid = await cli([...SCAN, sub]);
    expect(invalid.code).toBe(EXIT.usage);
    expect(invalid.stderr).toContain('unknown key "fail_on"');
    expect((await cli([...SCAN, '--config', 'nope.yml'])).code).toBe(EXIT.usage);
  });

  it('reports paths from the repository root, and never scans its own reports', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'sunset-cli-repo-'));
    cpSync(join(dir, 'app.py'), join(repo, 'svc', 'app.py'), { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: repo });
    const sarif = await cli([...SCAN, 'svc', '-f', 'sarif'], { cwd: repo });
    const uris = JSON.parse(sarif.stdout).runs[0].results.map(
      (r: { locations: { physicalLocation: { artifactLocation: { uri: string } } }[] }) =>
        r.locations[0]?.physicalLocation.artifactLocation.uri,
    );
    expect(uris).toContain('svc/app.py');
    // A report from an earlier run, where this run writes its own, isn't scanned.
    const out = join(repo, 'svc', 'sunset.json');
    expect((await cli([...SCAN, 'svc', '-f', 'json', '-o', out], { cwd: repo })).code).toBe(
      EXIT.findings,
    );
    await cli([...SCAN, 'svc', '-f', 'json', '-o', out], { cwd: repo });
    const report = JSON.parse(readFileSync(out, 'utf8'));
    expect(report.findings.map((f: { location: { path: string } }) => f.location.path)).toEqual([
      'svc/app.py',
      'svc/app.py',
    ]);
    rmSync(repo, { recursive: true, force: true });
  });

  it("escapes control characters from the repository's config in its errors", async () => {
    const sub = mkdtempSync(join(dir, 'escapes-'));
    // A clipboard write (OSC 52) and a screen clear in a key; the next problem keeps its line.
    writeFileSync(
      join(sub, '.sunset.yml'),
      '"\\e]52;c;cHduZWQ=\\a\\e[2J": 1\nfail-on: "\\e[31mred"\n',
    );
    const { code, stderr } = await cli([...SCAN, sub]);
    expect(code).toBe(EXIT.usage);
    expect(stderr).toContain('unknown key "\\u001b]52;c;cHduZWQ=\\u0007\\u001b[2J"');
    expect(stderr).toContain('\n  - fail-on: must be one of error, warning, never\n');
    expect(stderr).not.toContain('\u001b');
    expect(stderr).not.toContain('\u0007');
  });

  it('refuses to write the report over a directory', async () => {
    const { code, stderr } = await cli([...SCAN, '-o', dir]);
    expect(code).toBe(EXIT.usage);
    expect(stderr).toContain('is a directory');
  });

  it('makes no network calls with --registry bundled', async () => {
    const fetch = vi.fn() as unknown as typeof globalThis.fetch;
    await cli(SCAN, { fetch });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('falls back to the bundled registry when the remote one is unreachable', async () => {
    const fetch = vi.fn(async () => {
      throw new TypeError('fetch failed', { cause: { code: 'ENOTFOUND' } });
    }) as unknown as typeof globalThis.fetch;
    const { code, stderr } = await cli(['scan', '--today', FIXTURE_TODAY], { fetch });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(code).toBe(EXIT.findings);
    expect(stderr).toContain(
      "sunset: warning: Couldn't use the remote registry (ENOTFOUND); using the bundled copy.",
    );
  });

  it('reads a registry file given on the command line, relative to the working directory', async () => {
    const { stderr } = await cli(
      ['scan', '--today', FIXTURE_TODAY, '--registry', 'test/fixtures/registry/models.yaml', dir],
      { cwd: root },
    );
    expect(stderr).toContain('registry: file v1');
  });

  it("infers the repository's platforms from its dependencies, unless platforms is set", async () => {
    const repo = mkdtempSync(join(dir, 'inferred-'));
    writeFileSync(join(repo, 'a.py'), 'M = "claude-fixture-opus-9"\n');
    writeFileSync(join(repo, 'requirements.txt'), 'anthropic>=0.40\n');
    const inferred = await cli([...SCAN, repo, '-f', 'json']);
    expect(inferred.stderr).toContain(
      'sunset: platforms: anthropic, inferred from requirements.txt: anthropic.',
    );
    expect(JSON.parse(inferred.stdout).findings[0].severity).toBe('error');
    const explicit = await cli([...SCAN, repo, '-f', 'json', '--platforms', 'vertex']);
    expect(explicit.stderr).not.toContain('inferred');
    expect(JSON.parse(explicit.stdout).findings[0].severity).toBe('notice');
  });

  it('warns when the registry is old', async () => {
    const { stderr } = await cli(['scan', '--today', '2099-03-01', '--registry', 'bundled']);
    expect(stderr).toContain(
      "sunset: warning: The registry's newest check is 59 days old (2099-01-01).",
    );
  });

  it('exits 3 on an internal error', async () => {
    const { code, stderr } = await cli(SCAN, {
      bundled: { ...bundledFixture, formats: 'bedrock: 1\n' },
    });
    expect(code).toBe(EXIT.internal);
    expect(stderr).toContain('sunset: internal error: the bundled formats.yaml is invalid');
  });
});

describe('sunset registry', () => {
  it('info shows where the registry comes from and what is in it', async () => {
    const text = await cli(['registry', 'info', '--registry', 'bundled', '--today', FIXTURE_TODAY]);
    expect(text.code).toBe(0);
    expect(text.stdout).toContain('origin:        bundled');
    expect(text.stdout).toContain('entries:       27');
    expect(text.stdout).toContain('newest check:  2099-01-01 (today)');

    const json = JSON.parse(
      (
        await cli([
          'registry',
          'info',
          '--registry',
          'bundled',
          '-f',
          'json',
          '--today',
          FIXTURE_TODAY,
        ])
      ).stdout,
    );
    expect(json).toMatchObject({
      origin: 'bundled',
      registry_version: 1,
      entries: 27,
      newest_check_age_days: 0,
    });
    expect(json.platforms.bedrock).toBe(6);
  });

  it('validate checks the bundled registry by default', async () => {
    const { code, stdout } = await cli(['registry', 'validate', '--today', FIXTURE_TODAY]);
    expect(code).toBe(0);
    expect(stdout).toMatch(/the bundled registry: 27 entries; 0 errors, \d+ warnings?\n$/);
  });

  it('validate checks a registry directory against its sources and snapshots', async () => {
    const { code, stdout } = await cli(['registry', 'validate', 'registry/models.yaml'], {
      cwd: root,
    });
    const { models } = parse(readFileSync(join(root, 'registry/models.yaml'), 'utf8')) as {
      models: unknown[];
    };
    expect(stdout).toMatch(
      new RegExp(`registry[\\\\/]models\\.yaml: ${models.length} entries; 0 errors`),
    );
    expect(code).toBe(0);
  });

  it('validate reports a broken file and exits 1', async () => {
    writeFileSync(join(dir, 'bad.yaml'), 'schema_version: 2\nregistry_version: 1\nmodels: []\n');
    const bad = await cli(['registry', 'validate', 'bad.yaml']);
    expect(bad.code).toBe(EXIT.findings);
    expect(bad.stdout).toContain('error');
    writeFileSync(join(dir, 'garbage.yaml'), 'models: [');
    expect((await cli(['registry', 'validate', 'garbage.yaml'])).stdout).toContain(
      'not valid YAML',
    );
    expect((await cli(['registry', 'validate', 'missing.yaml'])).code).toBe(EXIT.usage);
  });

  it('validate escapes control characters from the file', async () => {
    const text = bundledFixture.models.replace(
      "id: 'openai:gpt-fixture-retired'",
      'id: "openai:gpt-fixture-retired\\e[2J"',
    );
    writeFileSync(join(dir, 'escapes.yaml'), text);
    const { code, stdout } = await cli(['registry', 'validate', 'escapes.yaml']);
    expect(code).toBe(EXIT.findings);
    expect(stdout).toContain('error   openai:gpt-fixture-retired\\u001b[2J: id must be');
    expect(stdout).not.toContain('\u001b');
  });
});
