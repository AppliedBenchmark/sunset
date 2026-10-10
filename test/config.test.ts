// Configuration: the schema, the value parsers, precedence and fail-on.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import picomatch from 'picomatch';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import registrySchema from '../registry/schema.json' with { type: 'json' };
import { loadConfigFile } from '../src/adapters/config-file.ts';
import {
  ConfigError,
  DEFAULT_SETTINGS,
  failingFindings,
  PLATFORMS,
  parseFailOn,
  parseFailScope,
  parsePlatforms,
  parseRegistryMode,
  resolveSettings,
  validateConfig,
} from '../src/core/config.ts';
import { RULES } from '../src/report/rules.ts';
import { scanFiles } from './helpers.ts';

const problems = (data: unknown): string => {
  try {
    validateConfig(data);
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigError);
    return (error as Error).message;
  }
  throw new Error('expected a ConfigError');
};

describe('validateConfig', () => {
  it('accepts every v1 key', () => {
    const config = {
      include: ['src/**'],
      exclude: ['**/fixtures/**'],
      docs: ['notes/**'],
      ignore: [
        { paths: ['legacy/**'], reason: 'frozen' },
        {
          models: ['gpt-4'],
          rules: ['sunset/model-retiring', 'model-deprecated'],
          until: '2027-01-31',
        },
      ],
      legacy: true,
      'fail-on': 'warning',
      registry: 'bundled',
      'max-file-size': 2048,
      platforms: ['openai', 'bedrock'],
    };
    expect(validateConfig(config)).toEqual(config);
  });

  it('treats an empty file as no settings', () => {
    expect(validateConfig(null)).toEqual({});
  });

  it('names unknown keys, bad values and bad dates', () => {
    expect(problems({ fail_on: 'error' })).toContain('unknown key "fail_on"');
    expect(problems({ 'fail-on': 'notice' })).toContain(
      'fail-on: must be one of error, warning, never',
    );
    expect(problems({ platforms: ['openrouter'] })).toContain(
      'platforms[0]: must be one of openai',
    );
    expect(problems({ ignore: [{ rules: ['model-gone'] }] })).toMatch(
      /ignore\[0\]\.rules\[0\]: must be one of model-retired, .*suppression-expired$/m,
    );
    expect(problems({ ignore: [{ paths: ['a'], until: '2027-02-30' }] })).toContain(
      'ignore[0].until: "2027-02-30" is not a valid date',
    );
    expect(problems({ 'max-file-size': '1MB' })).toContain('max-file-size: must be integer');
  });

  it('rejects an ignore rule that would match everything', () => {
    expect(problems({ ignore: [{ reason: 'everything' }] })).toContain(
      'ignore[0]: needs at least one of paths, models or rules',
    );
  });

  it('lists every problem at once', () => {
    const message = problems({ legacy: 'yes', 'fail-on': 'sometimes', extra: 1 });
    expect(message.split('\n').filter((l) => l.startsWith('  - '))).toHaveLength(3);
    // Impossible dates too, also in a rule with other problems.
    const lines = problems({
      extra: 1,
      ignore: [{ until: '2027-02-30' }, { paths: ['a'], until: 'soon' }, 'x'],
    }).split('\n');
    expect(lines.filter((l) => l.startsWith('  - '))).toEqual([
      '  - the file: unknown key "extra"',
      '  - ignore[0]: needs at least one of paths, models or rules',
      '  - ignore[1].until: must match pattern "^\\d{4}-\\d{2}-\\d{2}$"',
      '  - ignore[2]: must be object',
      '  - ignore[0].until: "2027-02-30" is not a valid date (YYYY-MM-DD)',
    ]);
  });

  it('knows every platform and rule the rest of the code knows', () => {
    expect([...PLATFORMS]).toEqual(registrySchema.$defs.Platform.enum);
    const rules = (
      problems({ ignore: [{ rules: ['x'] }] }).match(/must be one of (.*)$/m)?.[1] ?? ''
    )
      .split(', ')
      .sort();
    expect(rules).toEqual(RULES.map((r) => r.id).sort());
  });
});

describe('value parsers', () => {
  it('parses registry modes', () => {
    expect(parseRegistryMode('remote')).toEqual({ kind: 'remote' });
    expect(parseRegistryMode(' bundled ')).toEqual({ kind: 'bundled' });
    expect(parseRegistryMode('mirror/models.yaml')).toEqual({
      kind: 'file',
      path: 'mirror/models.yaml',
    });
    expect(parseRegistryMode('https://example.com/models.yaml')).toEqual({
      kind: 'url',
      url: 'https://example.com/models.yaml',
    });
    expect(parseRegistryMode('http://127.0.0.1:8080/m.yaml')).toEqual({
      kind: 'url',
      url: 'http://127.0.0.1:8080/m.yaml',
    });
    expect(() => parseRegistryMode('http://example.com/m.yaml')).toThrow(/must use https/);
    expect(() => parseRegistryMode('ftp://example.com/m.yaml')).toThrow(ConfigError);
    expect(() => parseRegistryMode('https://')).toThrow(/not a valid URL/);
    expect(() => parseRegistryMode('')).toThrow(/must not be empty/);
  });

  it('parses fail-on', () => {
    expect(parseFailOn('warning')).toBe('warning');
    expect(() => parseFailOn('notice')).toThrow('fail-on: must be one of error, warning, never');
  });

  it('parses platform lists', () => {
    expect(parsePlatforms('openai, bedrock openai')).toEqual(['openai', 'bedrock']);
    expect(() => parsePlatforms('openai,azure')).toThrow('unknown platform "azure"');
    expect(() => parsePlatforms(' , ')).toThrow('name at least one platform');
  });
});

describe('resolveSettings', () => {
  it('uses the defaults without a file', () => {
    expect(resolveSettings(null)).toEqual(DEFAULT_SETTINGS);
  });

  it('lets flags override the file, and the file override the defaults', () => {
    const file = validateConfig({
      'fail-on': 'warning',
      registry: 'bundled',
      platforms: ['openai'],
      exclude: ['vendor2/**'],
    });
    const fromFile = resolveSettings(file);
    expect(fromFile).toMatchObject({
      failOn: 'warning',
      registry: { kind: 'bundled' },
      platforms: ['openai'],
      exclude: ['vendor2/**'],
      legacy: false,
    });
    const fromFlags = resolveSettings(file, {
      failOn: 'never',
      registry: { kind: 'remote' },
      platforms: ['bedrock'],
      legacy: true,
    });
    expect(fromFlags).toMatchObject({
      failOn: 'never',
      registry: { kind: 'remote' },
      platforms: ['bedrock'],
      exclude: ['vendor2/**'],
      legacy: true,
    });
  });

  it('reads fail-scope from the file and the overrides', () => {
    expect(resolveSettings(null).failScope).toBe('all');
    const file = validateConfig({ 'fail-scope': 'new' });
    expect(resolveSettings(file).failScope).toBe('new');
    expect(resolveSettings(file, { failScope: parseFailScope('all') }).failScope).toBe('all');
    expect(() => parseFailScope('changed')).toThrow('fail-scope: must be one of all, new');
    expect(problems({ 'fail-scope': 'everything' })).toContain(
      'fail-scope: must be one of all, new',
    );
  });

  it("lets a directory's name match the files in it", () => {
    const settings = resolveSettings(
      validateConfig({
        include: ['src'],
        exclude: ['legacy', 'build/', '**/*.gen.ts', 'vendor2/**'],
        docs: ['guides'],
        ignore: [{ paths: ['old'], rules: ['model-retired'] }],
      }),
    );
    const matches = (globs: string[], path: string) => picomatch(globs, { dot: true })(path);
    expect(matches(settings.exclude, 'legacy/app.py')).toBe(true);
    expect(matches(settings.exclude, 'legacy')).toBe(true);
    expect(matches(settings.exclude, 'build/out.js')).toBe(true);
    expect(matches(settings.exclude, 'src/a.gen.ts')).toBe(true);
    expect(matches(settings.exclude, 'legacyapp/app.py')).toBe(false);
    expect(matches(settings.include, 'src/deep/a.ts')).toBe(true);
    expect(matches(settings.docs, 'guides/setup.txt')).toBe(true);
    expect(matches(settings.ignore[0]?.paths ?? [], 'old/a.py')).toBe(true);
    expect(settings.exclude).toContain('vendor2/**');
    expect(settings.exclude).not.toContain('vendor2/**/**');
  });

  it('accepts rule IDs with and without the sunset/ prefix', () => {
    const settings = resolveSettings(
      validateConfig({
        ignore: [
          { rules: ['sunset/model-retired', 'model-retired', 'model-legacy'], until: '2027-01-01' },
        ],
      }),
    );
    expect(settings.ignore).toEqual([
      { rules: ['model-retired', 'model-legacy'], until: '2027-01-01' },
    ]);
  });
});

describe('failingFindings', () => {
  const files = {
    'a.py': [
      'A = "gpt-fixture-retired"', // error
      'B = "gpt-fixture-2-2099-02-15"', // warning
      'C = "gpt-fixture-3"', // notice
      'D = os.environ["MODEL"]', // unresolved: never counts
      '',
    ].join('\n'),
    'README.md': 'Uses gpt-fixture-retired.\n', // a docs mention: never counts
  };

  it('counts findings at or above the level', async () => {
    const result = await scanFiles(files);
    expect(failingFindings(result, 'error')).toBe(1);
    expect(failingFindings(result, 'warning')).toBe(2);
    expect(failingFindings(result, 'never')).toBe(0);
  });
});

describe('platforms', () => {
  // The fixture registry lists this ID on Anthropic (retires 2099-01-20) and Vertex (2099-04-01).
  const files = { 'a.py': 'M = "claude-fixture-opus-9"\n' };
  const verdict = async (platforms?: ('anthropic' | 'vertex' | 'openai')[]) =>
    (await scanFiles(files, platforms ? { platforms } : {})).findings.map(
      (f) => `${f.severity} ${f.entries.map((e) => e.platform).join(',')}`,
    );

  it('drops entries on other platforms before severity', async () => {
    expect(await verdict(['anthropic'])).toEqual(['error anthropic']);
    expect(await verdict(['vertex'])).toEqual(['notice vertex']);
    expect(await verdict(['openai'])).toEqual([]);
    // Without the setting, the shared-ID rule keeps it below an error.
    expect(await verdict()).toEqual(['warning anthropic,vertex']);
  });
});

describe('loadConfigFile', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sunset-config-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('finds .sunset.yml, then .sunset.yaml, in the scanned directory', async () => {
    expect(await loadConfigFile(dir, null)).toEqual({ path: null, config: null });
    writeFileSync(join(dir, '.sunset.yaml'), 'legacy: true\n');
    expect(await loadConfigFile(dir, null)).toEqual({
      path: join(dir, '.sunset.yaml'),
      config: { legacy: true },
    });
    writeFileSync(join(dir, '.sunset.yml'), 'fail-on: never\n');
    expect((await loadConfigFile(dir, null)).config).toEqual({ 'fail-on': 'never' });
  });

  it('resolves a relative registry path against the file', async () => {
    mkdirSync(join(dir, 'conf'));
    writeFileSync(join(dir, 'conf/sunset.yml'), 'registry: ../mirror/models.yaml\n');
    const { config } = await loadConfigFile(dir, join(dir, 'conf/sunset.yml'));
    expect(config?.registry).toBe(join(dir, 'mirror/models.yaml'));
  });

  it("doesn't let YAML warnings quote the file to stderr", async () => {
    // An unresolved tag is a warning, which `yaml` would emit with the line it is on.
    writeFileSync(join(dir, '.sunset.yml'), 'fail-on: !y never # \u001b[2J\n');
    const warnings: unknown[] = [];
    const listener = (w: unknown) => warnings.push(w);
    process.on('warning', listener);
    try {
      await loadConfigFile(dir, null).catch(() => undefined);
      await new Promise((r) => setImmediate(r));
    } finally {
      process.off('warning', listener);
    }
    expect(warnings).toEqual([]);
  });

  it('reports a missing explicit file, bad YAML and invalid settings as config errors', async () => {
    await expect(loadConfigFile(dir, join(dir, 'nope.yml'))).rejects.toThrow(
      /can't read the config file .*nope\.yml: ENOENT/,
    );
    writeFileSync(join(dir, '.sunset.yml'), 'exclude: [unclosed\n');
    await expect(loadConfigFile(dir, null)).rejects.toThrow(/is not valid YAML/);
    writeFileSync(join(dir, '.sunset.yml'), 'exclude: vendor/**\n');
    await expect(loadConfigFile(dir, null)).rejects.toThrow(/exclude: must be array/);
  });

  it('documents every key in the schema', () => {
    const schema = JSON.parse(
      readFileSync(new URL('../docs/schemas/config.schema.json', import.meta.url), 'utf8'),
    ) as { properties: Record<string, { description?: string }> };
    for (const [key, value] of Object.entries(schema.properties)) {
      expect(value.description, key).toBeTruthy();
    }
  });
});
