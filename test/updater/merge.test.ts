// Merge rules: add new models; change values only with a new grounded excerpt; never delete; never
// un-retire; keep human-owned fields; re-verify unchanged entries only when their source is stale.
import { describe, expect, it } from 'vitest';
import type { ExtractedRow, Extraction } from '../../src/core/registry/extract.ts';
import type { IsoDate, Registry, RegistryEntry, Source } from '../../src/core/types.ts';
import {
  applyMerges,
  mergeIsClean,
  mergeSource,
  REVERIFY_AFTER_DAYS,
} from '../../updater/merge.ts';

const d = (s: string) => s as IsoDate;
const TODAY = d('2026-10-08');

const source: Source = {
  id: 'openai/deprecations',
  provider: 'openai',
  platforms: ['openai'],
  url: 'https://developers.openai.com/api/docs/deprecations',
  fetch: {
    kind: 'url',
    url: 'https://developers.openai.com/api/docs/deprecations.md',
    format: 'markdown',
  },
  parser: 'openai-deprecations',
};

const PAGE = [
  '| Shutdown date | Model | Replacement |',
  '| 2026-11-05 | `gpt-a` | `gpt-new` |',
  '| 2026-12-01 | `gpt-b` | `gpt-new` |',
  '| 2027-01-10 | `gpt-c` | `gpt-newer` |',
  '',
].join('\n');

const row = (model_id: string, date: string, replacement = 'gpt-new'): ExtractedRow => ({
  platform: 'openai',
  provider: 'openai',
  model_id,
  version: null,
  regions: null,
  state: 'deprecated',
  deprecation: null,
  retirement: { text: date, iso: d(date) },
  qualifier: 'exact',
  replacements: [replacement],
  excerpt: `| ${date} | \`${model_id}\` | \`${replacement}\` |`,
  notes: 'new-entry note',
});

const entry = (
  model_id: string,
  date: string,
  overrides: Partial<RegistryEntry> = {},
): RegistryEntry => ({
  id: `openai:${model_id}`,
  provider: 'openai',
  platform: 'openai',
  model_id,
  version: null,
  aliases: [],
  status: 'deprecated',
  deprecation_date: null,
  retirement_date: d(date),
  retirement_date_qualifier: 'exact',
  recommended_replacements: [{ model_id: 'gpt-new', platform: 'openai' }],
  drop_in: false,
  source: 'openai/deprecations',
  source_url: source.url,
  source_excerpt: `| ${date} | \`${model_id}\` | \`gpt-new\` |`,
  verified_on: TODAY,
  notes: 'human note',
  ...overrides,
});

const registry = (...models: RegistryEntry[]): Registry => ({
  schema_version: 1,
  registry_version: 7,
  generated_at: '2026-10-08T00:00:00Z',
  models,
});

const extraction = (...rows: ExtractedRow[]): Extraction => ({
  rows,
  problems: [],
  exhaustive: true,
});

const merge = (reg: Registry, ext: Extraction, page = PAGE, today = TODAY) =>
  mergeSource({ registry: reg, source, extraction: ext, page, today });

describe('mergeSource', () => {
  it('confirms entries whose values match, with no change', () => {
    const result = merge(
      registry(entry('gpt-a', '2026-11-05')),
      extraction(row('gpt-a', '2026-11-05')),
    );
    expect(result.changes).toEqual([]);
    expect(result.missing).toEqual([]);
  });

  it('adds new models with the row note', () => {
    const result = merge(registry(), extraction(row('gpt-b', '2026-12-01')));
    expect(result.changes).toHaveLength(1);
    expect(result.changes[0]).toMatchObject({
      kind: 'added',
      after: {
        id: 'openai:gpt-b',
        retirement_date: '2026-12-01',
        notes: 'new-entry note',
        verified_on: TODAY,
      },
    });
  });

  it('changes a date only together with the new excerpt, keeping human fields', () => {
    const before = entry('gpt-a', '2026-10-30', {
      aliases: ['gpt-a-alias'],
      source_excerpt: '| 2026-10-30 | `gpt-a` | `gpt-new` |',
      verified_on: d('2026-09-01'),
    });
    const result = merge(registry(before), extraction(row('gpt-a', '2026-11-05')));
    expect(result.changes).toHaveLength(1);
    const change = result.changes[0];
    expect(change?.kind).toBe('updated');
    expect(change?.fields).toEqual(['retirement_date']);
    expect(change?.after).toEqual({
      ...before,
      retirement_date: '2026-11-05',
      source_excerpt: '| 2026-11-05 | `gpt-a` | `gpt-new` |',
      verified_on: TODAY,
    });
  });

  it('clears drop_in when the replacements it vouched for change', () => {
    const before = entry('gpt-c', '2027-01-10', { drop_in: true });
    const result = merge(registry(before), extraction(row('gpt-c', '2027-01-10', 'gpt-newer')));
    expect(result.changes[0]?.after.drop_in).toBe(false);
    expect(result.changes[0]?.fields).toEqual(['recommended_replacements']);
  });

  it('keeps drop_in when the replacements are unchanged', () => {
    const before = entry('gpt-a', '2026-10-30', { drop_in: true });
    const result = merge(registry(before), extraction(row('gpt-a', '2026-11-05')));
    expect(result.changes[0]?.after.drop_in).toBe(true);
  });

  it('refreshes an excerpt that is no longer on the page, values unchanged', () => {
    const before = entry('gpt-a', '2026-11-05', {
      source_excerpt: '| 2026-11-05 | `gpt-a` | old layout |',
    });
    const result = merge(registry(before), extraction(row('gpt-a', '2026-11-05')));
    expect(result.changes.map((c) => c.kind)).toEqual(['excerpt']);
    expect(result.changes[0]?.after.source_excerpt).toBe('| 2026-11-05 | `gpt-a` | `gpt-new` |');
  });

  it('reports a change that would bring a retired model back, instead of applying it', () => {
    const retired = entry('gpt-a', '2026-09-01', { status: 'retired' });
    const result = merge(registry(retired), extraction(row('gpt-a', '2026-11-05')));
    expect(result.changes).toEqual([]);
    expect(result.problems).toEqual([
      "`openai:gpt-a` would go from retired to deprecated; providers don't bring retired models back, so check the page and the parser",
    ]);
    expect(mergeIsClean(result)).toBe(false);
  });

  it('reports a change that would drop a retirement date', () => {
    const undated = {
      ...row('gpt-a', '2026-11-05'),
      retirement: null,
      excerpt: '| 2026-11-05 | `gpt-a` | `gpt-new` |',
    };
    const result = merge(registry(entry('gpt-a', '2026-11-05')), extraction(undated));
    expect(result.changes).toEqual([]);
    expect(result.problems).toEqual([
      '`openai:gpt-a` would lose its retirement date 2026-11-05; check the page and the parser',
    ]);
  });

  it('never deletes: a model missing from the page is reported', () => {
    const gone = entry('gpt-gone', '2026-11-05');
    const result = merge(
      registry(entry('gpt-a', '2026-11-05'), gone),
      extraction(row('gpt-a', '2026-11-05')),
    );
    expect(result.missing).toEqual([gone]);
    expect(applyMerges(registry(gone), [result], TODAY).models).toContainEqual(gone);
  });

  it('rejects ungrounded rows, which makes the merge unclean', () => {
    const bad = {
      ...row('gpt-a', '2026-11-05'),
      retirement: { text: '2026-12-01', iso: d('2026-12-01') },
    };
    const result = merge(registry(entry('gpt-a', '2026-11-05')), extraction(bad));
    expect(result.rejected).toHaveLength(1);
    expect(mergeIsClean(result)).toBe(false);
    expect(
      applyMerges(registry(entry('gpt-a', '2026-11-05')), [result], TODAY).registry_version,
    ).toBe(7);
  });

  it('reports duplicate rows and rows owned by another source', () => {
    const other = entry('gpt-b', '2026-12-01', { source: 'openai/other' });
    const result = merge(
      registry(other),
      extraction(
        row('gpt-a', '2026-11-05'),
        row('gpt-a', '2026-11-05'),
        row('gpt-b', '2026-12-01'),
      ),
    );
    expect(result.problems).toEqual([
      'the page lists `openai:gpt-a` more than once',
      '`openai:gpt-b` is also on this page, but its entry comes from openai/other',
    ]);
  });

  it('leaves rows for entries another source owns to it, on a page that only adds models', () => {
    const other = entry('gpt-b', '2026-11-30', { source: 'openai/other' });
    const result = mergeSource({
      registry: registry(other),
      source: { ...source, parser: 'azure-retired-models' },
      extraction: extraction(row('gpt-a', '2026-11-05'), row('gpt-b', '2026-12-01')),
      page: PAGE,
      today: TODAY,
    });
    expect(result.problems).toEqual([]);
    expect(result.changes.map((c) => [c.kind, c.after.id])).toEqual([['added', 'openai:gpt-a']]);
  });

  it(`re-verifies unchanged entries once the source's newest check is ${REVERIFY_AFTER_DAYS} days old`, () => {
    const old = entry('gpt-a', '2026-11-05', { verified_on: d('2026-09-01') });
    expect(
      merge(registry(old), extraction(row('gpt-a', '2026-11-05')), PAGE, d('2026-09-14')).changes,
    ).toEqual([]);
    const result = merge(
      registry(old),
      extraction(row('gpt-a', '2026-11-05')),
      PAGE,
      d('2026-09-15'),
    );
    expect(result.changes.map((c) => [c.kind, c.after.verified_on])).toEqual([
      ['reverified', '2026-09-15'],
    ]);
  });

  it('proposes nothing from a best-effort source, and lists unknown models for review', () => {
    const result = merge(registry(entry('gpt-a', '2026-10-30')), {
      rows: [row('gpt-a', '2026-11-05'), row('gpt-b', '2026-12-01')],
      problems: [],
      exhaustive: false,
    });
    expect(result.changes).toEqual([]);
    expect(result.missing).toEqual([]);
    expect(result.unreviewed.map((r) => r.model_id)).toEqual(['gpt-b']);
  });
});

describe('applyMerges', () => {
  it('inserts new entries after their source block and bumps the version once', () => {
    const a = entry('gpt-a', '2026-11-05');
    const elsewhere = entry('x', '2026-11-05', { id: 'openai:x', source: 'openai/zzz' });
    const reg = registry(a, elsewhere);
    const result = merge(
      reg,
      extraction(
        row('gpt-a', '2026-11-05'),
        row('gpt-b', '2026-12-01'),
        row('gpt-c', '2027-01-10', 'gpt-newer'),
      ),
    );
    const out = applyMerges(reg, [result], d('2026-10-09'));
    expect(out.models.map((m) => m.id)).toEqual([
      'openai:gpt-a',
      'openai:gpt-b',
      'openai:gpt-c',
      'openai:x',
    ]);
    expect(out.registry_version).toBe(8);
    expect(out.generated_at).toBe('2026-10-09T00:00:00Z');
  });

  it("inserts a new source's first entries after their platform's block", () => {
    const a = entry('gpt-a', '2026-11-05', { source: 'openai/other' });
    const anthropic = entry('claude-x', '2026-11-05', {
      id: 'anthropic:claude-x',
      platform: 'anthropic',
      source: 'anthropic/model-deprecations',
    });
    const reg = registry(a, anthropic);
    const result = merge(
      reg,
      extraction(row('gpt-b', '2026-12-01'), row('gpt-c', '2027-01-10', 'gpt-newer')),
    );
    expect(applyMerges(reg, [result], TODAY).models.map((m) => m.id)).toEqual([
      'openai:gpt-a',
      'openai:gpt-b',
      'openai:gpt-c',
      'anthropic:claude-x',
    ]);
  });

  it('returns the registry itself when nothing changed', () => {
    const reg = registry(entry('gpt-a', '2026-11-05'));
    expect(applyMerges(reg, [merge(reg, extraction(row('gpt-a', '2026-11-05')))], TODAY)).toBe(reg);
  });
});
