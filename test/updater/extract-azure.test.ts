// The Azure parsers against saved pages: the retirement schedule and the retired-models page.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { LayoutChangedError } from '../../src/core/registry/extract.ts';
import { normalizeText } from '../../src/core/registry/normalize.ts';
import type { IsoDate, Source } from '../../src/core/types.ts';
import { extractor as retired } from '../../updater/extract/azure-retired-models.ts';
import { extractor } from '../../updater/extract/azure-retirement-tables.ts';

const fixture = (name: string, parser = 'azure-retirement-tables') =>
  normalizeText(
    readFileSync(new URL(`../fixtures/pages/${parser}/${name}`, import.meta.url), 'utf8'),
    'markdown',
  );
const page = (text: string) => ({ text, row_classes: {} });
const ctx = {
  source: { id: 'azure-openai/test', provider: 'azure-openai' } as Source,
  today: '2026-10-08' as IsoDate,
};

describe('azure-retirement-tables', () => {
  const text = fixture('current.md');
  const { rows, problems } = extractor.extract(page(text), ctx);
  const find = (model: string, version: string) =>
    rows.find((r) => r.model_id === model && r.version === version);

  it('reads (model, version) rows with the maker from the section', () => {
    expect(problems).toEqual([]);
    expect(find('gpt-4o', '2024-05-13')).toEqual({
      platform: 'azure-openai',
      provider: 'openai',
      model_id: 'gpt-4o',
      version: '2024-05-13',
      regions: null,
      state: 'deprecated',
      deprecation: null,
      retirement: { text: '2026-12-09', iso: '2026-12-09' },
      qualifier: 'exact',
      replacements: ['gpt-5.6-sol'],
      excerpt: '| gpt-4o | 2024-05-13 | Deprecated | 2026-12-09 | gpt-5.6-sol |',
      notes: null,
    });
    expect(find('gpt-4o', '2024-11-20')?.state).toBe('legacy');
    expect(find('claude-sonnet-4-5', '1')).toMatchObject({
      provider: 'anthropic',
      state: 'available',
      replacements: ['claude-sonnet-5-5'],
    });
    expect(find('claude-mythos-5-1', '1')?.retirement).toBeNull();
    expect(find('tsuzumi-7b', '2')?.provider).toBe('ntt-data');
  });

  it('leaves out rows without a version and the fine-tuned table', () => {
    expect(rows.some((r) => r.model_id === 'claude-opus-4-1')).toBe(false);
    expect(rows.some((r) => r.model_id.startsWith('claude-mythos-preview'))).toBe(false);
    expect(rows.filter((r) => r.model_id === 'gpt-4.1')).toHaveLength(1);
    expect(rows.every((r) => r.qualifier === 'exact')).toBe(true);
  });

  it('drops replacements that are not a single model ID', () => {
    expect(find('sora-2', '2025-10-06')?.replacements).toEqual([]);
    const changed = text.replace(
      '| gpt-4o | 2024-05-13 | Deprecated | 2026-12-09 | gpt-5.6-sol |',
      '| gpt-4o | 2024-05-13 | Deprecated | 2026-12-09 | @octocat, #1, gpt-5.6-sol |',
    );
    expect(changed).not.toBe(text);
    const row = extractor
      .extract(page(changed), ctx)
      .rows.find((r) => r.model_id === 'gpt-4o' && r.version === '2024-05-13');
    expect(row?.replacements).toEqual(['gpt-5.6-sol']);
  });

  it('makes a (model, version) listed twice with different dates unverified', () => {
    expect(find('gpt-realtime-mini', '2025-10-06')).toMatchObject({
      state: 'unverified',
      retirement: null,
      replacements: [],
      excerpt: '| gpt-realtime-mini | 2025-10-06 | GA | 2027-04-06 | — |',
    });
    expect(rows.filter((r) => r.model_id === 'gpt-realtime-mini')).toHaveLength(2);
  });

  it('reports a layout change', () => {
    expect(() => extractor.extract(page(fixture('layout-changed.md')), ctx)).toThrow(
      LayoutChangedError,
    );
  });

  it('reports a table with other columns, but not the fine-tuned models', () => {
    const changed = text.replace(
      '| Model | Version | Lifecycle | Retirement date | Replacement |\n|-------|---------|-----------|-----------------|-------------|\n| tsuzumi-7b',
      '| Model | Version | Status | Retirement date | Replacement |\n|-------|---------|-----------|-----------------|-------------|\n| tsuzumi-7b',
    );
    expect(changed).not.toBe(text);
    expect(extractor.extract(page(changed), ctx).problems).toEqual([
      `a table under "NTT Data" has columns the parser doesn't know: Model | Version | Status | Retirement date | Replacement`,
    ]);
  });

  it('reports an unknown date format or lifecycle as a problem', () => {
    const changed = text
      .replace(
        '| codex-mini | 2025-05-16 | Deprecated | 2026-11-15 |',
        '| codex-mini | 2025-05-16 | Deprecated | 11/15/2026 |',
      )
      .replace('| gpt-4.1 | 2025-04-14 | Deprecated |', '| gpt-4.1 | 2025-04-14 | Sunsetting |');
    const result = extractor.extract(page(changed), ctx);
    expect(result.problems).toEqual([
      expect.stringContaining('unrecognized retirement date "11/15/2026"'),
      expect.stringContaining('unrecognized lifecycle "Sunsetting"'),
    ]);
  });
});

describe('azure-retired-models', () => {
  const text = fixture('current.md', 'azure-retired-models');
  const { rows, problems } = retired.extract(page(text), ctx);
  const find = (model: string, version: string) =>
    rows.find((r) => r.model_id === model && r.version === version);

  it('reads the rows with a version as retired, with the maker from the section', () => {
    expect(problems).toEqual([]);
    expect(find('gpt-4o-realtime-preview', '2024-10-01')).toEqual({
      platform: 'azure-openai',
      provider: 'openai',
      model_id: 'gpt-4o-realtime-preview',
      version: '2024-10-01',
      regions: null,
      state: 'retired',
      deprecation: { text: 'February 25, 2025', iso: '2025-02-25' },
      retirement: { text: 'March 26, 2025', iso: '2025-03-26' },
      qualifier: 'exact',
      // The same model in another version isn't a replacement the registry can name.
      replacements: ['gpt-4o-mini-realtime-preview'],
      excerpt:
        '| `gpt-4o-realtime-preview` | `2024-10-01` | February 25, 2025 | March 26, 2025 | `gpt-4o-realtime-preview` (version 2024-12-17) or `gpt-4o-mini-realtime-preview` (version 2024-12-17) |',
      notes: null,
    });
    expect(find('gpt-35-turbo', '0301')).toMatchObject({
      deprecation: null,
      retirement: { iso: '2025-02-13' },
      replacements: ['gpt-4o-mini'],
    });
  });

  it('gives each model of a cell an entry, and drops the versions of replacements', () => {
    const row =
      '| `gpt-4`<br>`gpt-4-32k` | 0314 | — | June 6, 2025 | `gpt-4o` version: `2024-11-20` |';
    for (const model of ['gpt-4', 'gpt-4-32k']) {
      expect(find(model, '0314')).toMatchObject({
        retirement: { iso: '2025-06-06' },
        replacements: ['gpt-4o'],
        excerpt: row,
      });
    }
    expect(find('gpt-35-turbo-16k', '0613')?.replacements).toEqual(['gpt-4.1-mini']);
  });

  it('leaves out rows without a version and the tables without a Version column', () => {
    expect(rows).toHaveLength(14);
    expect(rows.every((r) => r.version !== null && r.provider === 'openai')).toBe(true);
    expect(rows.some((r) => r.model_id === 'o1-preview')).toBe(false);
  });

  it('reports a table with other columns, an unknown date and a row without a date', () => {
    const changed = text
      .replace(
        '| Model | Retirement date | Suggested replacement |\n|-------|-----------------------|-----------------------------|\n| Mistral-Nemo',
        '| Model | Retirement date | Replacement |\n|-------|-----------------------|-----------------------------|\n| Mistral-Nemo',
      )
      .replace('| 0301 | — | February 13, 2025 |', '| 0301 | — | 02/13/2025 |')
      .replace('| 0613 | — | April 30, 2025 |', '| 0613 | — | — |');
    expect(changed).not.toBe(text);
    expect(retired.extract(page(changed), ctx).problems).toEqual([
      `a table under "Mistral AI" has columns the parser doesn't know: Model | Retirement date | Replacement`,
      expect.stringContaining('unrecognized retirement date "02/13/2025"'),
      expect.stringContaining('a retired model without a retirement date: | `gpt-35-turbo-16k`'),
    ]);
  });

  it('makes a (model, version) listed twice with different dates unverified', () => {
    const changed = text.replace(
      '| `babbage-002` | — |',
      '| `gpt-35-turbo` | 0613 | — | March 1, 2025 | N/A |\n| `babbage-002` | — |',
    );
    expect(changed).not.toBe(text);
    const row = retired
      .extract(page(changed), ctx)
      .rows.find((r) => r.model_id === 'gpt-35-turbo' && r.version === '0613');
    expect(row).toMatchObject({ state: 'unverified', retirement: null, replacements: [] });
  });

  it('reports a layout change', () => {
    expect(() =>
      retired.extract(page(fixture('layout-changed.md', 'azure-retired-models')), ctx),
    ).toThrow(LayoutChangedError);
  });
});
