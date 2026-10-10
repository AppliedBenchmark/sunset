// A provider's update end to end, with a fake fetcher: a changed page becomes a grounded change
// and a PR body; a layout change, a parse failure, a missing model or an entry that wouldn't
// validate opens the provider's issue and leaves the registry and snapshot unchanged.
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import type { FetchedPage, Fetcher } from '../../src/core/ports.ts';
import { normalizeText } from '../../src/core/registry/normalize.ts';
import type { IsoDate, Registry, RegistryEntry, SourcesFile } from '../../src/core/types.ts';
import { EXTRACTORS } from '../../updater/extract/index.ts';
import { applyMerges } from '../../updater/merge.ts';
import { issueBody, prBody, prTitle } from '../../updater/proposal.ts';
import { SnapshotStore } from '../../updater/snapshot-store.ts';
import { applicable, runProvider } from '../../updater/update.ts';

const registryDir = fileURLToPath(new URL('../../registry', import.meta.url));
const fixtures = fileURLToPath(new URL('../fixtures/pages', import.meta.url));
// The OpenAI entries and their snapshot, frozen on the day they were verified, so these tests
// don't change when the real registry does.
const frozen = fileURLToPath(new URL('../fixtures/updater', import.meta.url));
const sources = parse(readFileSync(`${registryDir}/sources.yaml`, 'utf8')) as SourcesFile;
const registry = parse(readFileSync(`${frozen}/models.yaml`, 'utf8')) as Registry;
const TODAY = '2026-10-08' as IsoDate;
const SNAPSHOT = readFileSync(`${frozen}/snapshots/openai/deprecations.txt`, 'utf8');

let dir: string;
let store: SnapshotStore;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sunset-update-'));
  cpSync(`${frozen}/snapshots/openai`, join(dir, 'snapshots', 'openai'), { recursive: true });
  store = new SnapshotStore(dir);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const page = (text: string): FetchedPage => ({
  text,
  row_classes: {},
  urls: ['https://developers.openai.com/api/docs/deprecations.md'],
  etag: null,
  last_modified: null,
});

const fetcherOf = (result: FetchedPage | 'not-modified' | Error): Fetcher => ({
  async fetch() {
    if (result instanceof Error) throw result;
    return result;
  },
});

const run = (fetcher: Fetcher) =>
  runProvider('openai', {
    sources,
    registry,
    fetcher,
    store,
    extractors: EXTRACTORS,
    today: TODAY,
  });

describe('runProvider', () => {
  it('confirms the registry when the server says the page is not modified', async () => {
    const result = await run(fetcherOf('not-modified'));
    expect(result.sources.map((s) => [s.failure, s.changed, s.merge?.changes])).toEqual([
      [null, null, []],
    ]);
    expect(issueBody(result, TODAY, null)).toBeNull();
  });

  it('turns a changed date into one grounded change, a PR title and body', async () => {
    const before = '| Apr 1, 2027 | `gpt-5.1` | `gpt-6-sol` |';
    const after = '| May 3, 2027 | `gpt-5.1` | `gpt-6-sol` |';
    expect(SNAPSHOT).toContain(before);
    const result = await run(fetcherOf(page(SNAPSHOT.replace(before, after))));
    const [source] = result.sources;
    expect(source?.failure).toBeNull();
    expect(source?.changed).not.toBeNull();
    const changes = source?.merge?.changes ?? [];
    expect(changes.map((c) => [c.kind, c.after.id, c.fields])).toEqual([
      ['updated', 'openai:gpt-5.1', ['retirement_date']],
    ]);
    expect(changes[0]?.after).toMatchObject({
      status: 'deprecated',
      retirement_date: '2027-05-03',
      source_excerpt: after,
    });

    const updated = applyMerges(
      registry,
      applicable(result).flatMap((s) => (s.merge ? [s.merge] : [])),
      TODAY,
    );
    expect(updated.registry_version).toBe(registry.registry_version + 1);

    expect(prTitle(result)).toBe('chore(registry): update openai (1 changed)');
    const body = prBody(result, TODAY, 'https://github.com/o/r/actions/runs/1');
    expect(body).toContain('<!-- sunset-registry-update:openai -->');
    expect(body).toContain(
      '| updated | `openai:gpt-5.1` | retirement_date: `2027-04-01` → `2027-05-03` |',
    );
    expect(body).toContain(`\`\`\`text\n${after}\n\`\`\``);
    expect(body).toContain('--- a/openai/deprecations.txt\n+++ b/openai/deprecations.txt\n');
    expect(body).toContain(`-${before}\n+${after}`);
    expect(issueBody(result, TODAY, null)).toBeNull();
  });

  it('reports a passed shutdown date that moves into the future instead of un-retiring', async () => {
    const before = '| 2026-09-28 | `babbage-002` | `gpt-5.6-terra` |';
    const after = '| 2026-12-28 | `babbage-002` | `gpt-5.6-terra` |';
    const result = await run(fetcherOf(page(SNAPSHOT.replace(before, after))));
    expect(result.sources[0]?.failure).toEqual({
      kind: 'parse',
      details: [
        "`openai:babbage-002` would go from retired to deprecated; providers don't bring retired models back, so check the page and the parser",
      ],
    });
    expect(applicable(result)).toEqual([]);
  });

  it('opens an issue and changes nothing when the layout changed', async () => {
    const text = normalizeText(
      readFileSync(join(fixtures, 'openai-deprecations', 'layout-changed.md'), 'utf8'),
      'markdown',
    );
    const result = await run(fetcherOf(page(text)));
    expect(result.sources[0]?.failure?.kind).toBe('layout-changed');
    expect(applicable(result)).toEqual([]);
    expect(applyMerges(registry, [], TODAY)).toBe(registry);
    // The stored snapshot is untouched: run.ts writes only applicable sources.
    expect((await store.read('openai/deprecations'))?.page.text).toBe(SNAPSHOT);
    const issue = issueBody(result, TODAY, null);
    expect(issue?.title).toBe('Registry updater: openai (layout changed)');
    expect(issue?.body).toContain('### `openai/deprecations`: layout changed');
    expect(issue?.body).toContain('left unchanged');
  });

  it('opens an issue for a date it cannot parse', async () => {
    const text = SNAPSHOT.replace('| 2026-09-28 | `babbage-002` |', '| Q4 2026 | `babbage-002` |');
    const result = await run(fetcherOf(page(text)));
    expect(result.sources[0]?.failure?.kind).toBe('parse');
    expect(issueBody(result, TODAY, null)?.body).toContain('Q4 2026');
  });

  it('reports a model missing from the page instead of deleting it', async () => {
    const text = SNAPSHOT.split('\n')
      .filter((line) => !line.includes('`chatgpt-4o-latest`'))
      .join('\n');
    const result = await run(fetcherOf(page(text)));
    expect(result.sources[0]?.failure).toEqual({
      kind: 'missing',
      details: ['`openai:chatgpt-4o-latest` is in the registry but no longer on the page'],
    });
    expect(applicable(result)).toEqual([]);
  });

  it('fails the source instead of proposing a row the validator would reject', async () => {
    // A new model with no shutdown date: a deprecated entry needs one.
    const text = SNAPSHOT.replace(
      '| Apr 1, 2027 | `gpt-5.1` | `gpt-6-sol` |',
      '| Apr 1, 2027 | `gpt-5.1` | `gpt-6-sol` |\n| To be announced | `gpt-9-test` | `gpt-6-sol` |',
    );
    const result = await run(fetcherOf(page(text)));
    expect(result.sources[0]?.failure).toEqual({
      kind: 'invalid',
      details: [
        '`openai:gpt-9-test`: a deprecated entry needs a date; without one it must be unverified',
      ],
    });
    expect(applicable(result)).toEqual([]);
    expect(issueBody(result, TODAY, null)?.title).toBe(
      'Registry updater: openai (entries that would not validate)',
    );
  });

  it("fails a best-effort source whose page no longer has an entry's excerpt", async () => {
    const quoted = 'Change the model name to deepseek-flash to call the latest V4.1 Flash model.';
    const entry = {
      ...(registry.models[0] as RegistryEntry),
      id: 'deepseek:deepseek-flash',
      provider: 'deepseek',
      platform: 'deepseek',
      model_id: 'deepseek-flash',
      status: 'active',
      retirement_date: null,
      recommended_replacements: [],
      source: 'deepseek/updates',
      source_url: 'https://api-docs.deepseek.com/updates',
      source_excerpt: quoted,
    } as RegistryEntry;
    const text = `# Change Log\n\n## Date: 2026-09-10\n\n${quoted.replace('latest', 'newest')}\n`;
    const result = await runProvider('deepseek', {
      sources,
      registry: { ...registry, models: [entry] },
      fetcher: fetcherOf(page(text)),
      store,
      extractors: EXTRACTORS,
      today: TODAY,
    });
    expect(result.sources[0]?.failure).toEqual({
      kind: 'invalid',
      details: [
        '`deepseek:deepseek-flash`: source_excerpt is not in the snapshot of `deepseek/updates`',
      ],
    });
  });

  it('fails a page that no longer says what its page_qualifier quotes', async () => {
    const gemini = readFileSync(`${registryDir}/snapshots/gemini-api/deprecations.txt`, 'utf8');
    const reworded = gemini.replace('*earliest possible\n> dates*', '*planned\n> dates*');
    expect(reworded).not.toBe(gemini);
    const result = await runProvider('gemini-api', {
      sources,
      registry: { ...registry, models: [] },
      fetcher: fetcherOf({
        ...page(reworded),
        row_classes: { 'row-gray': ['gemini-3-pro-preview'] },
      }),
      store,
      extractors: EXTRACTORS,
      today: TODAY,
    });
    expect(result.sources[0]?.failure).toEqual({
      kind: 'layout-changed',
      details: ['sources.yaml: page_qualifier.excerpt is not in the snapshot'],
    });
  });

  it('isolates a fetch failure', async () => {
    const result = await run(fetcherOf(new Error('HTTP 503')));
    expect(result.sources[0]?.failure).toEqual({ kind: 'fetch', details: ['HTTP 503'] });
    expect(issueBody(result, TODAY, 'https://run')?.body).toContain(
      'Last checked: 2026-10-08 ([run](https://run))',
    );
  });
});
