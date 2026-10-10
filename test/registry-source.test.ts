// Registry loading: the remote path against a local server, the fallback to the bundled
// copy on every kind of failure, local files and mirrors, and no network at all for `bundled`.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';
import { createHttpClient } from '../src/adapters/http.ts';
import {
  type BundledData,
  bundledFormats,
  createRegistrySource,
  MAX_YAML_TOKENS,
  parseRegistry,
  REMOTE_REGISTRY_URL,
} from '../src/adapters/registry-source.ts';
import { ConfigError, type RegistryMode } from '../src/core/config.ts';
import type { Logger } from '../src/core/ports.ts';
import type { Registry, RegistryEntry } from '../src/core/types.ts';
import { bundledFixture } from './helpers.ts';

/** The fixture registry under another version, so tests can tell the copies apart. */
const remoteText = bundledFixture.models.replace(
  /^registry_version: \d+$/m,
  'registry_version: 77',
);

type Handler = (url: string, res: import('node:http').ServerResponse) => void;
const routes = new Map<string, Handler>();
let server: Server;
let base: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    const handler = routes.get(req.url ?? '');
    if (handler) handler(req.url ?? '', res);
    else res.writeHead(404).end('not found');
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  routes.set('/models.yaml', (_, res) => res.end(remoteText));
  routes.set('/garbage.yaml', (_, res) => res.end('models: [unclosed'));
  routes.set('/invalid.yaml', (_, res) => res.end('schema_version: 1\nmodels: []\n'));
  routes.set('/v2.yaml', (_, res) =>
    res.end(remoteText.replace(/^schema_version: 1$/m, 'schema_version: 2')),
  );
  routes.set('/bomb.yaml', (_, res) => {
    // A billion-laughs document: yaml refuses to expand it.
    const lines = ['a: &a [x, x, x, x, x, x, x, x, x, x]'];
    for (let i = 1; i < 10; i++) {
      const prev = String.fromCharCode(96 + i);
      const next = String.fromCharCode(97 + i);
      lines.push(`${next}: &${next} [${Array(10).fill(`*${prev}`).join(', ')}]`);
    }
    res.end(`${lines.join('\n')}\n`);
  });
  routes.set('/huge.yaml', (_, res) => {
    res.writeHead(200);
    res.write('#'.repeat(64 * 1024));
    res.end('#'.repeat(64 * 1024));
  });
  routes.set('/slow.yaml', () => {
    // Never answers.
  });
  routes.set('/redirect.yaml', (_, res) => res.writeHead(302, { location: '/models.yaml' }).end());
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise((done) => server.close(done));
});

function logger(): Logger & { warnings: string[]; infos: string[]; debugs: string[] } {
  const warnings: string[] = [];
  const infos: string[] = [];
  const debugs: string[] = [];
  return {
    warnings,
    infos,
    debugs,
    info: (m) => infos.push(m),
    debug: (m) => debugs.push(m),
    warn: (m) => warnings.push(m),
  };
}

function source(mode: RegistryMode, opts: { url?: string; bundled?: BundledData } = {}) {
  const log = logger();
  const http = vi.fn(() => createHttpClient());
  const src = createRegistrySource({
    mode,
    bundled: opts.bundled ?? bundledFixture,
    http,
    logger: log,
    remoteUrl: opts.url ?? `${base}/models.yaml`,
    timeoutMs: 300,
    maxBytes: 100 * 1024,
  });
  return { src, http, log };
}

describe('registry: bundled', () => {
  it('makes no network calls: the HTTP client is never created', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const { src, http } = source({ kind: 'bundled' });
    const loaded = await src.load();
    expect(loaded).toMatchObject({ origin: 'bundled', version: 1, warnings: [] });
    expect(http).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('fails loudly if the bundled copy is broken', async () => {
    const { src } = source({ kind: 'bundled' }, { bundled: { ...bundledFixture, models: 'x: [' } });
    await expect(src.load()).rejects.toThrow(/the bundled registry is not valid YAML/);
  });
});

describe('registry: remote', () => {
  it('uses the fetched registry when it is valid', async () => {
    const { src, log } = source({ kind: 'remote' });
    expect(await src.load()).toMatchObject({ origin: 'remote', version: 77, warnings: [] });
    expect(log.warnings).toEqual([]);
  });

  it('follows redirects', async () => {
    const { src } = source({ kind: 'remote' }, { url: `${base}/redirect.yaml` });
    expect(await src.load()).toMatchObject({ origin: 'remote', version: 77 });
  });

  it("follows a redirect only while it doesn't leave https", async () => {
    const hops: string[] = [];
    const fake = (routes: Record<string, string>) =>
      (async (input: string | URL | Request) => {
        const url = String(input);
        hops.push(url);
        const location = routes[url];
        return location === undefined
          ? new Response('ok')
          : new Response(null, { status: 302, headers: { location } });
      }) as typeof fetch;
    const get = (routes: Record<string, string>, url: string) =>
      createHttpClient(fake(routes)).getText(url, { timeoutMs: 1000, maxBytes: 100 });

    expect(await get({ 'https://m.test/a': '/b' }, 'https://m.test/a')).toBe('ok');
    expect(hops).toEqual(['https://m.test/a', 'https://m.test/b']);
    hops.length = 0;
    await expect(
      get({ 'https://m.test/a': 'http://169.254.169.254/latest/meta-data/' }, 'https://m.test/a'),
    ).rejects.toThrow('a redirect from https to http:');
    expect(hops).toEqual(['https://m.test/a']);
    await expect(get({ 'https://m.test/a': '/a' }, 'https://m.test/a')).rejects.toThrow(
      'more than 20 redirects',
    );
  });

  it.each([
    ['an HTTP error', '/missing.yaml', /HTTP 404/],
    ['a timeout', '/slow.yaml', /no response within 300 ms/],
    ['a body over the size cap', '/huge.yaml', /over the 102,400-byte limit/],
    ['invalid YAML', '/garbage.yaml', /not valid YAML/],
    ['an alias bomb', '/bomb.yaml', /invalid|alias/i],
    ['a schema violation', '/invalid.yaml', /invalid: .*must have required property/],
    ['an unknown schema major', '/v2.yaml', /schema_version 2 isn't supported .* update Sunset/],
  ])('falls back to the bundled copy on %s', async (_, path, reason) => {
    const { src, log } = source({ kind: 'remote' }, { url: `${base}${path}` });
    const loaded = await src.load();
    expect(loaded).toMatchObject({ origin: 'bundled', version: 1 });
    expect(log.warnings).toHaveLength(1);
    expect(log.warnings[0]).toMatch(/^Couldn't use the remote registry \(/);
    expect(log.warnings[0]).toMatch(reason);
    expect(loaded.warnings).toEqual(log.warnings);
  });

  it('falls back when nothing is listening', async () => {
    const closed = createServer();
    await new Promise<void>((done) => closed.listen(0, '127.0.0.1', done));
    const { port } = closed.address() as AddressInfo;
    await new Promise((done) => closed.close(done));
    const { src, log } = source(
      { kind: 'remote' },
      { url: `http://127.0.0.1:${port}/models.yaml` },
    );
    expect((await src.load()).origin).toBe('bundled');
    expect(log.warnings[0]).toMatch(/ECONNREFUSED/);
  });

  it('fetches the raw file from main by default', () => {
    expect(REMOTE_REGISTRY_URL).toBe(
      'https://raw.githubusercontent.com/AppliedBenchmark/sunset/main/registry/models.yaml',
    );
  });
});

describe('registry: mirrors and files', () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'sunset-registry-'));
    writeFileSync(join(dir, 'models.yaml'), remoteText);
    writeFileSync(join(dir, 'broken.yaml'), 'schema_version: 1\n');
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('reads a mirror URL, falling back like remote', async () => {
    const ok = source({ kind: 'url', url: `${base}/models.yaml` });
    expect(await ok.src.load()).toMatchObject({ origin: 'remote', version: 77 });
    const down = source({ kind: 'url', url: `${base}/missing.yaml` });
    expect((await down.src.load()).origin).toBe('bundled');
    expect(down.log.warnings[0]).toContain(`mirror ${base}/missing.yaml`);
  });

  it('reads a local file without the network', async () => {
    const { src, http } = source({ kind: 'file', path: join(dir, 'models.yaml') });
    expect(await src.load()).toMatchObject({ origin: 'file', version: 77 });
    expect(http).not.toHaveBeenCalled();
  });

  it('treats a missing or invalid file as a config error', async () => {
    await expect(source({ kind: 'file', path: join(dir, 'nope.yaml') }).src.load()).rejects.toThrow(
      ConfigError,
    );
    await expect(
      source({ kind: 'file', path: join(dir, 'broken.yaml') }).src.load(),
    ).rejects.toThrow(/broken\.yaml is invalid/);
  });
});

/**
 * The fixture registry as a newer Sunset might write it, still schema_version 1: a new top-level
 * field, a new field on every entry, and one entry on a platform this version doesn't know.
 */
const newerText = remoteText
  .replace(/^models:$/m, 'published_by: AppliedBenchmark\nmodels:')
  .replace(/^( +)notes: (.*)$/gm, '$1notes: $2\n$1context_window: 128000')
  .replace(/^( +)platform: openai$/m, '$1platform: openrouter');

const bundledCount = (parseRegistry(remoteText) as { registry: { models: unknown[] } }).registry
  .models.length;

/** `text` (by default `remoteText`) with one entry, from its `id` line on, changed. */
const withEntry = (id: string, change: (entry: string) => string, text = remoteText): string => {
  const start = text.indexOf(`  - id: '${id}'\n`);
  const end = text.indexOf('\n  - id: ', start + 1);
  return text.slice(0, start) + change(text.slice(start, end)) + text.slice(end);
};

describe('external registries are read forward-compatibly', () => {
  it('skips what this version does not understand, instead of falling back', () => {
    const strict = parseRegistry(newerText);
    expect(strict).toMatchObject({ problem: expect.stringMatching(/additional properties/) });
    const result = parseRegistry(newerText, { external: true });
    if (!('registry' in result)) throw new Error(result.problem);
    expect(result.skipped).toEqual([
      { entry: 'openai:gpt-fixture-retired', reason: 'unknown platform "openrouter"' },
    ]);
    expect(result.registry.models).toHaveLength(bundledCount - 1);
    expect(result.registry.models.some((e) => 'context_window' in e)).toBe(false);
  });

  it('says how many entries it skipped and kept, and which ones in the debug log', async () => {
    routes.set('/newer.yaml', (_, res) => res.end(newerText));
    const { src, log } = source({ kind: 'remote' }, { url: `${base}/newer.yaml` });
    expect(await src.load()).toMatchObject({ origin: 'remote', version: 77, warnings: [] });
    expect(log.infos).toEqual([
      "The remote registry has 1 entry that this version of Sunset can't read; update Sunset to check them. 1 entry comes from the bundled copy instead.",
    ]);
    expect(log.debugs).toEqual([
      'left out openai:gpt-fixture-retired: unknown platform "openrouter"',
      'kept openai:gpt-fixture-retired from the bundled copy',
    ]);
  });

  it('leaves out an entry that fails its own checks, and uses the rest', () => {
    const govCloud = 'bedrock:anthropic.claude-fixture-1-20990101-v1:0#us-gov-west-1';
    for (const [text, reason] of [
      // A kind of region name this version's schema doesn't accept.
      [
        withEntry(govCloud, (e) => e.replaceAll('us-gov-west-1', 'eu_sovereign_1')),
        /^schema: \/regions\/0 must match pattern/,
      ],
      [withEntry(govCloud, (e) => e.replace("'2099-01-20'", "'2099-02-30'")), /not a date/],
      [withEntry(govCloud, (e) => e.replace('#us-gov-west-1', '#us-gov-east-1')), /^id must be/],
      [remoteText.replace(/^models:$/m, 'models:\n  - just a string'), /^not a mapping$/],
    ] as const) {
      expect(parseRegistry(text)).toMatchObject({ problem: expect.stringMatching(/^invalid: /) });
      const result = parseRegistry(text, { external: true });
      if (!('registry' in result)) throw new Error(result.problem);
      expect(result.skipped).toHaveLength(1);
      expect(result.skipped[0]?.reason).toMatch(reason);
      const { models } = parse(text) as { models: unknown[] };
      expect(result.registry.models).toHaveLength(models.length - 1);
    }
  });

  it('keeps an entry whose drop-in replacement is on a platform it does not know', () => {
    const text = withEntry('openai:gpt-fixture-retired', (e) =>
      e
        .replace('platform: openai }', 'platform: openrouter }')
        .replace('drop_in: false', 'drop_in: true'),
    );
    const result = parseRegistry(text, { external: true });
    if (!('registry' in result)) throw new Error(result.problem);
    expect(result.skipped).toEqual([]);
    expect(result.registry.models[0]).toMatchObject({
      id: 'openai:gpt-fixture-retired',
      recommended_replacements: [],
      drop_in: false,
    });
  });

  it('rejects the whole file for problems across entries, such as a duplicate id', async () => {
    const entry = remoteText.slice(
      remoteText.indexOf("  - id: 'openai:gpt-fixture-retired'"),
      remoteText.indexOf("  - id: 'openai:gpt-fixture-1-2099-01-10'"),
    );
    const duplicated = remoteText.replace(entry, `${entry}${entry}`);
    expect(parseRegistry(duplicated, { external: true })).toEqual({
      problem: 'invalid: openai:gpt-fixture-retired: duplicate id',
    });
    routes.set('/duplicated.yaml', (_, res) => res.end(duplicated));
    const { src, log } = source({ kind: 'remote' }, { url: `${base}/duplicated.yaml` });
    expect((await src.load()).origin).toBe('bundled');
    expect(log.warnings[0]).toContain('duplicate id');
  });
});

describe('a fetched registry never knows less than the release', () => {
  let served = 0;
  /** Loads `text` as the remote registry, a mirror, or a local file. */
  const load = async (
    text: string,
    kind: 'remote' | 'url' | 'file' = 'remote',
    bundled: BundledData = bundledFixture,
  ) => {
    const name = `floor-${++served}.yaml`;
    const path = join(tmpdir(), `sunset-${process.pid}-${name}`);
    routes.set(`/${name}`, (_, res) => res.end(text));
    if (kind === 'file') writeFileSync(path, text);
    const url = `${base}/${name}`;
    const mode: RegistryMode =
      kind === 'file' ? { kind, path } : kind === 'url' ? { kind, url } : { kind };
    const { src, log } = source(mode, { url, bundled });
    const loaded = await src.load();
    if (kind === 'file') rmSync(path);
    return { loaded, log, path };
  };
  const bundledEntries = (parseRegistry(bundledFixture.models) as { registry: Registry }).registry
    .models;
  const retired = (models: readonly RegistryEntry[]) =>
    models.find((e) => e.id === 'openai:gpt-fixture-retired');
  const newStatus = withEntry('openai:gpt-fixture-retired', (e) =>
    e.replace('status: retired', 'status: sunsetting'),
  );
  const noneReadable = remoteText.replace(/^( +)status: \w+$/gm, '$1status: sunsetting');

  it('keeps the bundled entry for one whose status it does not know', async () => {
    for (const kind of ['remote', 'url'] as const) {
      const { loaded, log } = await load(newStatus, kind);
      expect(loaded).toMatchObject({ origin: 'remote', version: 77, warnings: [] });
      expect(loaded.registry.models).toHaveLength(bundledEntries.length);
      expect(retired(loaded.registry.models)).toEqual(retired(bundledEntries));
      expect(log.infos[0]).toContain('1 entry comes from the bundled copy instead.');
    }
  });

  it('gives the bundled entries for a registry it can read none of', async () => {
    const { loaded, log } = await load(noneReadable);
    expect(loaded).toMatchObject({ origin: 'remote', version: 77 });
    expect(loaded.registry.models).toEqual(bundledEntries);
    const n = bundledEntries.length;
    expect(log.infos).toEqual([
      `The remote registry has ${n} entries that this version of Sunset can't read; update Sunset to check them. ${n} entries come from the bundled copy instead.`,
    ]);
  });

  it('keeps a bundled entry the registry lacks', async () => {
    const start = remoteText.indexOf("  - id: 'openai:gpt-fixture-retired'");
    const end = remoteText.indexOf("  - id: 'openai:gpt-fixture-1-2099-01-10'");
    const { loaded, log } = await load(remoteText.slice(0, start) + remoteText.slice(end));
    expect(retired(loaded.registry.models)).toEqual(retired(bundledEntries));
    expect(log.infos).toEqual([
      'The remote registry lacks 1 entry of the bundled copy, which is kept.',
    ]);
  });

  it('falls back to the bundled copy when a kept entry collides with another', async () => {
    // A newer version moved the alias to another entry, and gave the first a status this one
    // doesn't know, so the bundled entry it keeps still has the alias.
    const moved = withEntry('openai:gpt-fixture-3', (e) =>
      e
        .replace('aliases: [gpt-fixture-3-0301]', 'aliases: []')
        .replace('status: deprecated', 'status: sunsetting'),
    );
    const text = withEntry(
      'openai:gpt-fixture-3-mini',
      (e) => e.replace('aliases: []', 'aliases: [gpt-fixture-3-0301]'),
      moved,
    );
    const { loaded, log } = await load(text);
    expect(loaded).toMatchObject({ origin: 'bundled', version: 1 });
    expect(log.warnings).toEqual([
      "Couldn't use the remote registry (invalid: openai:gpt-fixture-3: `gpt-fixture-3-0301` is already a model ID or alias of openai:gpt-fixture-3-mini); using the bundled copy.",
    ]);
  });

  it('uses the bundled copy instead of an older registry, and says why', async () => {
    // The fetched registry is v77.
    const bundledAt = (version: number): BundledData => ({
      ...bundledFixture,
      models: bundledFixture.models.replace(
        /^registry_version: \d+$/m,
        `registry_version: ${version}`,
      ),
    });
    for (const kind of ['remote', 'url'] as const) {
      const { loaded, log } = await load(remoteText, kind, bundledAt(78));
      expect(loaded).toMatchObject({ origin: 'bundled', version: 78 });
      expect(log.warnings).toEqual([
        expect.stringMatching(
          /^The (remote|mirror \S+) registry is v77, older than the bundled copy \(v78\); using the bundled copy\.$/,
        ),
      ]);
      expect(loaded.warnings).toEqual(log.warnings);
      expect(log.infos).toEqual([]);
    }
    // The same version is used, and so is a file whatever its version.
    expect((await load(remoteText, 'remote', bundledAt(77))).loaded.origin).toBe('remote');
    expect((await load(remoteText, 'file', bundledAt(78))).loaded).toMatchObject({
      origin: 'file',
      version: 77,
    });
  });

  it('reads a local file as it is, and warns about what it leaves out', async () => {
    const one = await load(newStatus, 'file');
    expect(one.loaded).toMatchObject({ origin: 'file', version: 77 });
    expect(one.loaded.registry.models).toHaveLength(bundledEntries.length - 1);
    expect(retired(one.loaded.registry.models)).toBeUndefined();
    const warning = `The ${one.path} registry has 1 entry that this version of Sunset can't read; update Sunset to check them.`;
    expect(one.log.warnings).toEqual([warning]);
    expect(one.loaded.warnings).toEqual([warning]);
    // A file this version can't read at all would check nothing.
    await expect(load(noneReadable, 'file')).rejects.toThrow(
      /can't read any of the \d+ entries in .* update Sunset/,
    );
  });
});

describe('external registries are parsed within limits', () => {
  it('rejects a document with too many YAML tokens before parsing it', () => {
    const line = `- [${Array(5000).fill('0').join(',')}]\n`;
    const flood = line.repeat(Math.ceil(MAX_YAML_TOKENS / 10_000) + 1);
    expect(parseRegistry(flood, { external: true })).toEqual({
      problem: `more than ${MAX_YAML_TOKENS.toLocaleString('en-US')} YAML tokens`,
    });
  });

  it('parses a huge mapping in linear time', () => {
    // With duplicate-key checks, this takes about 20 seconds.
    const keys = Array.from({ length: 40_000 }, (_, i) => `k${i}: ${i}`).join('\n');
    const started = performance.now();
    expect(parseRegistry(keys, { external: true })).toMatchObject({
      problem: expect.stringMatching(/^invalid/),
    });
    expect(performance.now() - started).toBeLessThan(2000);
  });

  it('allows no aliases', () => {
    const aliased = remoteText.replace(/^schema_version: 1$/m, 'schema_version: &v 1\nx: *v');
    expect(parseRegistry(aliased, { external: true })).toMatchObject({
      problem: expect.stringMatching(/^not valid YAML: .*alias/i),
    });
  });
});

describe('parseRegistry', () => {
  it('accepts the real registry', async () => {
    const { readFile } = await import('node:fs/promises');
    const text = await readFile(new URL('../registry/models.yaml', import.meta.url), 'utf8');
    expect('registry' in parseRegistry(text)).toBe(true);
  });

  it('reads the bundled formats', () => {
    expect(bundledFormats(bundledFixture).bedrock.geo_prefixes.length).toBeGreaterThan(0);
    expect(() => bundledFormats({ ...bundledFixture, formats: 'bedrock: 1\n' })).toThrow(
      /bundled formats.yaml is invalid/,
    );
  });
});
