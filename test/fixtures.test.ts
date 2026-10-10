// Fixture repos: each directory under test/fixtures/repos is scanned as a repository
// with the test-only registry on 2099-01-01, and the result must equal its expected.json.
//
// An optional fixture.json sets scan options (`ignores`, `legacy`, `maxFileSize`), files to create
// at test time (`generate`, for files git would ignore or that are too big to commit), the
// listing modes to check (`modes`: "walk" and/or "git"; default "walk") and registry entries only
// this repo needs (`models`: copies of the retired `openai:gpt-fixture-retired` with the given
// fields changed).
//
// After an intended change, regenerate with `UPDATE_FIXTURES=1 npx vitest run test/fixtures.test.ts`
// and review every diff in expected.json.
import { execFileSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { fixedClock } from '../src/adapters/clock.ts';
import { createFileSource } from '../src/adapters/file-source.ts';
import { scan } from '../src/core/pipeline.ts';
import type { Location, Registry, RegistryEntry, ScanResult } from '../src/core/types.ts';
import { FIXTURE_TODAY, fixtureRegistry, formats, root } from './helpers.ts';

const reposDir = join(root, 'test/fixtures/repos');
const update = process.env.UPDATE_FIXTURES === '1';
const META = new Set(['expected.json', 'fixture.json']);

interface FixtureOptions {
  ignores?: never[];
  legacy?: boolean;
  maxFileSize?: number;
  generate?: Record<string, string>;
  modes?: ('walk' | 'git')[];
  models?: Partial<RegistryEntry>[];
}

function registryFor(opts: FixtureOptions): Registry {
  if (!opts.models) return fixtureRegistry;
  const retired = fixtureRegistry.models[0] as RegistryEntry;
  const extra = opts.models.map((c) => ({
    ...retired,
    ...c,
    id: `${c.platform ?? retired.platform}:${c.model_id}`,
  }));
  return { ...fixtureRegistry, models: [...fixtureRegistry.models, ...extra] };
}

const temp: string[] = [];
afterAll(() => {
  for (const dir of temp) rmSync(dir, { recursive: true, force: true });
});

const at = (l: Location): string => `${l.path}:${l.line}:${l.column}`;

/** A compact, reviewable projection of a scan result. */
function project(result: ScanResult) {
  return {
    findings: result.findings.map(
      (f) =>
        `${at(f.location)} ${f.severity} ${f.rule} ${f.modelId}` +
        (f.entry ? ` [${f.entries.map((e) => e.id).join(' ')}]` : '') +
        (f.fileClass === 'test' ? ' (test)' : '') +
        (f.context && f.context.kind !== 'literal' ? ` <${f.context.kind}>` : ''),
    ),
    unresolved: result.unresolved.map(
      (u) => `${at(u.location)} ${u.reason} ${u.key ?? '-'} = ${u.expression}`,
    ),
    mentions: result.mentions.map((m) => `${at(m.location)} ${m.severity} ${m.modelId}`),
    inventory: result.inventory.map((i) => `${i.modelId} ${i.locations.map(at).join(', ')}`),
    suppressed: result.suppressed.map(
      (s) => `${at(s.location)} ${s.by} ${s.rule} ${s.modelId}${s.reason ? ` (${s.reason})` : ''}`,
    ),
    diagnostics: result.diagnostics.map(
      (d) => `${d.location ? at(d.location) : '-'} ${d.kind}: ${d.message}`,
    ),
    files: result.stats.files,
  };
}

function prepare(name: string, opts: FixtureOptions, git: boolean): string {
  const dir = mkdtempSync(join(tmpdir(), `sunset-fixture-${name}-`));
  temp.push(dir);
  cpSync(join(reposDir, name), dir, {
    recursive: true,
    filter: (src) => !META.has(basename(src)),
  });
  for (const [path, content] of Object.entries(opts.generate ?? {})) {
    mkdirSync(join(dir, path, '..'), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  if (git) {
    const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1' };
    execFileSync('git', ['init', '-q'], { cwd: dir, env });
    execFileSync('git', ['add', '.'], { cwd: dir, env });
  }
  return dir;
}

const fixtures = readdirSync(reposDir, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .sort();

describe('fixture repos', () => {
  // Every directory here is scanned below; this guards against losing one. A new fixture repo needs
  // no change here.
  it('keeps the fixture repos the scanner is checked against', () => {
    expect(fixtures).toEqual(
      expect.arrayContaining([
        'python',
        'ts-js',
        'go',
        'java',
        'configs',
        'terraform',
        'docker',
        'platform-formats',
        'dynamic',
        'suppression',
        'docs-only',
        'fp-traps',
        'azure-bicep',
        'arn-forms',
        'crlf',
        'unicode-columns',
        'binary-and-large',
        'gitignored',
        'words-and-paths',
        'prefixes',
        'notebooks',
        'ruby',
      ]),
    );
  });

  for (const name of fixtures) {
    const optionsPath = join(reposDir, name, 'fixture.json');
    const opts: FixtureOptions = existsSync(optionsPath)
      ? JSON.parse(readFileSync(optionsPath, 'utf8'))
      : {};
    for (const mode of opts.modes ?? ['walk']) {
      it(`${name} (${mode})`, async () => {
        const dir = prepare(name, opts, mode === 'git');
        const result = await scan({
          root: dir,
          files: createFileSource({ git: mode === 'git' }),
          registry: registryFor(opts),
          formats,
          clock: fixedClock(FIXTURE_TODAY),
          ...(opts.ignores && { ignores: opts.ignores }),
          ...(opts.legacy !== undefined && { legacy: opts.legacy }),
          ...(opts.maxFileSize !== undefined && { maxFileSize: opts.maxFileSize }),
        });
        const actual = project(result);
        const expectedPath = join(reposDir, name, 'expected.json');
        if (update) writeFileSync(expectedPath, `${JSON.stringify(actual, null, 2)}\n`);
        expect(actual).toEqual(JSON.parse(readFileSync(expectedPath, 'utf8')));
      });
    }
  }
});
