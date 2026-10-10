// The Gemini API deprecations parser on saved pages.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { LayoutChangedError, type NormalizedPage } from '../../src/core/registry/extract.ts';
import { normalizeText } from '../../src/core/registry/normalize.ts';
import type { IsoDate, SourcesFile } from '../../src/core/types.ts';
import { extractor } from '../../updater/extract/gemini-api-deprecations.ts';

const sources = parse(
  readFileSync(new URL('../../registry/sources.yaml', import.meta.url), 'utf8'),
) as SourcesFile;
const source = sources.sources.find((s) => s.id === 'gemini-api/deprecations');
if (!source) throw new Error('gemini-api/deprecations is not in sources.yaml');
const ctx = { source, today: '2026-10-08' as IsoDate };

/** The rows the HTML page marks with `row-gray` in the saved part of the page. */
const GRAY = [
  'gemini-3-pro-preview',
  'gemini-3.1-flash-lite-preview',
  'gemini-robotics-er-1.5-preview',
];

function page(name: string, gray = GRAY): NormalizedPage {
  const raw = readFileSync(
    new URL(`../fixtures/pages/gemini-api-deprecations/${name}`, import.meta.url),
    'utf8',
  );
  return { text: normalizeText(raw, 'markdown'), row_classes: { 'row-gray': gray } };
}

describe('gemini-api-deprecations', () => {
  const extraction = extractor.extract(page('current.md'), ctx);
  const row = (id: string) => extraction.rows.find((r) => r.model_id === id);

  it('reads every model row and skips sub-headings and managed agents', () => {
    expect(extraction.problems).toEqual([]);
    expect(extraction.exhaustive).toBe(true);
    expect(extraction.rows.map((r) => r.model_id)).toContain('gemini-3.8-flash');
    expect(row('antigravity-preview-09-2026')).toBeUndefined();
    expect(
      extraction.rows.every((r) => r.platform === 'gemini-api' && r.provider === 'google'),
    ).toBe(true);
  });

  it('reads an undated row as available', () => {
    expect(row('gemini-3.8-flash')).toMatchObject({
      state: 'available',
      retirement: null,
      qualifier: 'exact',
      replacements: [],
      notes: null,
    });
  });

  it('reads a dated row as available, with the page qualifier and both replacements', () => {
    // The page's dates are the earliest possible ones, and deprecations are announced in the
    // release notes, so a date doesn't make a model deprecated.
    expect(row('gemini-3.1-flash-lite')).toMatchObject({
      state: 'available',
      retirement: { text: 'May 7, 2027', iso: '2027-05-07' },
      qualifier: 'no_earlier_than',
    });
    expect(row('gemini-3.1-flash-tts-preview')).toEqual({
      platform: 'gemini-api',
      provider: 'google',
      model_id: 'gemini-3.1-flash-tts-preview',
      version: null,
      regions: null,
      state: 'available',
      deprecation: null,
      retirement: { text: 'November 17, 2026', iso: '2026-11-17' },
      qualifier: 'no_earlier_than',
      replacements: ['gemini-3.8-flash-tts', 'gemini-3.8-flash-lite-tts'],
      excerpt:
        '| `gemini-3.1-flash-tts-preview` | February 26, 2026 | November 17, 2026 | `gemini-3.8-flash-tts` or `gemini-3.8-flash-lite-tts` |',
      notes: 'The page says its shutdown dates are the earliest possible dates.',
    });
  });

  it('reads a gray row as retired on an exact date', () => {
    expect(row('gemini-3-pro-preview')).toMatchObject({
      state: 'retired',
      retirement: { text: 'March 9, 2026', iso: '2026-03-09' },
      qualifier: 'exact',
      replacements: ['gemini-3.1-pro-preview'],
      notes: null,
    });
  });

  it('keeps a replacement written without code marks, but not prose', () => {
    expect(row('gemini-robotics-er-1.6-preview')?.replacements).toEqual([
      'gemini-robotics-er-2-preview',
    ]);
  });

  it('throws LayoutChangedError when the HTML page marks no row as shut down', () => {
    // Read as "nothing is shut down", every retired model would come back.
    expect(() => extractor.extract(page('current.md', []), ctx)).toThrow(LayoutChangedError);
  });

  it('ignores a gray row in a table it skips, such as a managed agent', () => {
    const extraction = extractor.extract(
      page('current.md', [...GRAY, 'antigravity-preview-09-2026']),
      ctx,
    );
    expect(extraction.problems).toEqual([]);
    expect(row('antigravity-preview-09-2026')).toBeUndefined();
  });

  it('reports a gray row that is not on the page', () => {
    const extraction = extractor.extract(page('current.md', [...GRAY, 'gemini-0-gone']), ctx);
    expect(extraction.problems).toEqual([
      '`gemini-0-gone` is marked as shut down but not in a table',
    ]);
  });

  it('reports an unknown date format instead of guessing', () => {
    const changed = page('current.md');
    changed.text = changed.text.replace(
      '| `gemini-3.1-flash-lite` | May 7, 2026 | May 7, 2027 |',
      '| `gemini-3.1-flash-lite` | May 7, 2026 | Q2 2027 |',
    );
    const extraction = extractor.extract(changed, ctx);
    expect(extraction.problems).toEqual(['`gemini-3.1-flash-lite`: unknown date format "Q2 2027"']);
  });

  it('reports a table keyed on another column, but not the managed agents', () => {
    const changed = page('current.md');
    changed.text = changed.text.replace(
      '## Robotics models',
      '## New family\n\n| **Model ID** | **Release date** | **Shutdown date** | **Recommended replacement** |\n|---|---|---|---|\n| `gemini-9-test` | October 1, 2026 | November 1, 2026 | `gemini-3.8-flash` |\n\n## Robotics models',
    );
    expect(extractor.extract(changed, ctx).problems).toEqual([
      `a table under "New family" has columns the parser doesn't know: Model ID | Release date | Shutdown date | Recommended replacement`,
    ]);
  });

  it('throws LayoutChangedError when the headers change', () => {
    expect(() => extractor.extract(page('layout-changed.md'), ctx)).toThrow(LayoutChangedError);
  });
});
