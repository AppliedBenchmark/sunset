// The openai-deprecations parser on saved pages.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { LayoutChangedError } from '../../src/core/registry/extract.ts';
import { normalizeText } from '../../src/core/registry/normalize.ts';
import type { IsoDate, Source } from '../../src/core/types.ts';
import { extractor } from '../../updater/extract/openai-deprecations.ts';

const fixture = (name: string) =>
  normalizeText(
    readFileSync(new URL(`../fixtures/pages/openai-deprecations/${name}`, import.meta.url), 'utf8'),
    'markdown',
  );
const source = { id: 'openai/deprecations', parser: 'openai-deprecations' } as Source;
const ctx = { source, today: '2026-10-08' as IsoDate };
const extract = (text: string) => extractor.extract({ text, row_classes: {} }, ctx);
const byId = (text: string) => new Map(extract(text).rows.map((r) => [r.model_id, r]));

describe('openai-deprecations', () => {
  const rows = byId(fixture('current.md'));

  it('reads a row with a Mon D, YYYY date', () => {
    expect(rows.get('gpt-5.1')).toEqual({
      platform: 'openai',
      provider: 'openai',
      model_id: 'gpt-5.1',
      version: null,
      regions: null,
      state: 'deprecated',
      deprecation: null,
      retirement: { text: 'Apr 1, 2027', iso: '2027-04-01' },
      qualifier: 'exact',
      replacements: ['gpt-6-sol'],
      excerpt: '| Apr 1, 2027 | `gpt-5.1` | `gpt-6-sol` |',
      notes: null,
    });
  });

  it('makes every alias in a model cell its own row', () => {
    for (const id of ['gpt-4-0613', 'gpt-4', 'gpt-4-0613-completions', 'gpt-4-completions']) {
      expect(rows.get(id)?.retirement?.iso).toBe('2026-10-23');
      expect(rows.get(id)?.replacements).toEqual(['gpt-5.6-sol']);
    }
    expect(rows.get('gpt-4-turbo-preview')?.retirement?.iso).toBe('2026-03-26');
  });

  it('takes the newest announcement for a model listed twice', () => {
    const row = rows.get('gpt-4-1106-preview');
    expect(row?.retirement).toEqual({ text: 'October 23, 2026', iso: '2026-10-23' });
    // The 2025-09-26 row lists `gpt-5` or `gpt-4.1*`; the footnoted span is not an ID.
    expect(rows.get('gpt-4-0314')?.replacements).toEqual(['gpt-5']);
    // Normalized U+2011 hyphens parse as ISO dates.
    expect(rows.get('gpt-4-0314')?.retirement).toEqual({ text: '2026-03-26', iso: '2026-03-26' });
  });

  it('skips endpoints, systems, fine-tuned versions and non-model cells', () => {
    for (const id of ['/v1/edits', '/v1/fine-tunes', 'ft-gpt-4', 'ft-o4-mini-2025-04-16']) {
      expect(rows.has(id)).toBe(false);
    }
    // "New fine-tuning training on `babbage-002`" isn't a babbage-002 row.
    expect(rows.get('babbage-002')?.retirement?.iso).toBe('2026-09-28');
    expect(rows.get('sora-2')?.replacements).toEqual([]);
  });

  it('reads legacy tables and "at earliest" dates', () => {
    const page = fixture('current.md');
    const legacy = byId(page.slice(page.indexOf('### 2023-06-13')));
    expect(legacy.get('gpt-4-0314')).toMatchObject({
      state: 'legacy',
      retirement: { text: 'at earliest 2024-06-13', iso: '2024-06-13' },
      qualifier: 'no_earlier_than',
    });
  });

  it('reports a date it cannot read, without guessing', () => {
    const page = fixture('current.md').replace(
      '| Apr 1, 2027 | `gpt-5.1`',
      '| Q2 2027 | `gpt-5.1`',
    );
    const result = extract(page);
    expect(result.problems).toEqual([
      'unrecognized shutdown date "Q2 2027" in: | Q2 2027 | `gpt-5.1` | `gpt-6-sol` |',
    ]);
    expect(result.rows.some((r) => r.model_id === 'gpt-5.1')).toBe(false);
  });

  it('reports a table with columns it does not know, instead of dropping its models', () => {
    const announcement = (headers: string) =>
      fixture('current.md').replace(
        '## Upcoming deprecations\n',
        `## Upcoming deprecations\n\n### 2026-10-07: GPT-9 test\n\n| ${headers} |\n| --- | --- | --- |\n| Jan 4, 2027 | \`gpt-9-test\` | \`gpt-6-sol\` |\n`,
      );
    for (const headers of [
      'Shutdown date | Model | Recommended replacement',
      'Shutdown date | Model / system | Replacement',
    ]) {
      expect(extract(announcement(headers)).problems).toEqual([
        `a table under "2026-10-07: GPT-9 test" has columns the parser doesn't know: ${headers}`,
      ]);
    }
  });

  it('reads a bold model ID in code marks, and reports one without code marks', () => {
    const page = (cell: string) =>
      fixture('current.md').replace(
        '| Apr 1, 2027 | `gpt-5.1` | `gpt-6-sol` |',
        `| Apr 1, 2027 | \`gpt-5.1\` | \`gpt-6-sol\` |\n| Apr 1, 2027 | ${cell} | \`gpt-6-sol\` |`,
      );
    expect(byId(page('**`gpt-9-test`**')).get('gpt-9-test')?.retirement?.iso).toBe('2027-04-01');
    for (const cell of ['**gpt-9-test**', 'gpt-9-test']) {
      expect(extract(page(cell)).problems).toEqual([
        `a model without code marks, which the parser doesn't read: | Apr 1, 2027 | ${cell} | \`gpt-6-sol\` |`,
      ]);
    }
  });

  it('throws LayoutChangedError when the headers change', () => {
    expect(() => extract(fixture('layout-changed.md'))).toThrow(LayoutChangedError);
  });
});
