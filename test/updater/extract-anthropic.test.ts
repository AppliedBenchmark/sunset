// The anthropic-deprecations parser on saved pages.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { LayoutChangedError } from '../../src/core/registry/extract.ts';
import { normalizeText } from '../../src/core/registry/normalize.ts';
import type { IsoDate, Source } from '../../src/core/types.ts';
import { extractor } from '../../updater/extract/anthropic-deprecations.ts';

const fixture = (name: string) =>
  normalizeText(
    readFileSync(
      new URL(`../fixtures/pages/anthropic-deprecations/${name}`, import.meta.url),
      'utf8',
    ),
    'markdown',
  );
const source = { id: 'anthropic/model-deprecations', parser: 'anthropic-deprecations' } as Source;
const ctx = { source, today: '2026-10-08' as IsoDate };
const extract = (text: string) => extractor.extract({ text, row_classes: {} }, ctx);
const byId = (text: string) => new Map(extract(text).rows.map((r) => [r.model_id, r]));
const NOTES = 'Dates apply to Anthropic-operated platforms; Bedrock and Vertex set their own.';

describe('anthropic-deprecations', () => {
  const rows = byId(fixture('current.md'));

  it('reads an active model from the status table', () => {
    expect(rows.get('claude-opus-4-5-20251101')).toEqual({
      platform: 'anthropic',
      provider: 'anthropic',
      model_id: 'claude-opus-4-5-20251101',
      version: null,
      regions: null,
      state: 'available',
      deprecation: null,
      retirement: { text: 'Not sooner than November 24, 2026', iso: '2026-11-24' },
      qualifier: 'no_earlier_than',
      replacements: [],
      excerpt: '| claude-opus-4-5-20251101 | Active | N/A | Not sooner than November 24, 2026 |',
      notes: NOTES,
    });
  });

  it('reads a deprecation date and "To be announced"', () => {
    expect(rows.get('claude-mythos-preview')).toMatchObject({
      state: 'deprecated',
      deprecation: { text: 'June 9, 2026', iso: '2026-06-09' },
      retirement: null,
      qualifier: 'exact',
    });
  });

  it('prefers the history row, which names the replacement', () => {
    expect(rows.get('claude-sonnet-4-5-20250929')).toMatchObject({
      state: 'deprecated',
      deprecation: null,
      retirement: { text: 'November 30, 2026', iso: '2026-11-30' },
      replacements: ['claude-sonnet-5-5'],
      excerpt: '| November 30, 2026 | `claude-sonnet-4-5-20250929` | `claude-sonnet-5-5` |',
    });
    // Not in a history table of the fixture: its status row.
    expect(rows.get('claude-3-haiku-20240307')).toMatchObject({
      state: 'retired',
      deprecation: { iso: '2026-02-19' },
      retirement: { iso: '2026-04-20' },
    });
  });

  it('reports unknown states and dates, without guessing', () => {
    const page = fixture('current.md')
      .replace('| claude-opus-4-7 | Active |', '| claude-opus-4-7 | Paused |')
      .replace('Not sooner than May 28, 2027', 'Mid 2027');
    expect(extract(page).problems).toEqual([
      'unrecognized date "Mid 2027" in: | claude-opus-4-8 | Active | N/A | Mid 2027 |',
      'unrecognized state "Paused" in: | claude-opus-4-7 | Paused | N/A | Not sooner than April 16, 2027 |',
    ]);
  });

  it('reports a history table with other columns, and a model name it cannot read', () => {
    const page = fixture('current.md')
      .replace(
        '### 2026-09-30: Claude Sonnet 4.5 model',
        '### 2026-10-07: Claude Test model\n\n| Retirement date | Deprecated model | Recommended replacements |\n| --- | --- | --- |\n| January 7, 2027 | `claude-test-1` | `claude-sonnet-5-5` |\n\n### 2026-09-30: Claude Sonnet 4.5 model',
      )
      .replace('| claude-opus-4-8 | Active |', '| claude-opus-4-8\\* | Active |');
    expect(page).not.toBe(fixture('current.md'));
    expect(extract(page).problems).toEqual([
      'unrecognized model name "claude-opus-4-8*" in: | claude-opus-4-8\\* | Active | N/A | Not sooner than May 28, 2027 |',
      `a table under "2026-10-07: Claude Test model" has columns the parser doesn't know: Retirement date | Deprecated model | Recommended replacements`,
    ]);
  });

  it('throws LayoutChangedError when the status table headers change', () => {
    expect(() => extract(fixture('layout-changed.md'))).toThrow(LayoutChangedError);
  });
});
