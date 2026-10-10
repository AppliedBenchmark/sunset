// The Gemini API release-notes parser on a saved part of the page.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { LayoutChangedError, type NormalizedPage } from '../../src/core/registry/extract.ts';
import { normalizeText } from '../../src/core/registry/normalize.ts';
import type { IsoDate, Source } from '../../src/core/types.ts';
import { extractor } from '../../updater/extract/gemini-api-release-notes.ts';

const ctx = {
  source: { id: 'gemini-api/test', provider: 'gemini-api' } as Source,
  today: '2026-10-08' as IsoDate,
};

function page(name: string): NormalizedPage {
  const raw = readFileSync(
    new URL(`../fixtures/pages/gemini-api-release-notes/${name}`, import.meta.url),
    'utf8',
  );
  return { text: normalizeText(raw, 'markdown'), row_classes: {} };
}

describe('gemini-api-release-notes', () => {
  const extraction = extractor.extract(page('current.md'), ctx);
  const row = (id: string) => extraction.rows.find((r) => r.model_id === id);

  it('reads the models a section opens by saying are shut down, retired on its date', () => {
    expect(extraction.problems).toEqual([]);
    expect(extraction.exhaustive).toBe(true);
    expect(row('gemini-1.5-flash')).toEqual({
      platform: 'gemini-api',
      provider: 'google',
      model_id: 'gemini-1.5-flash',
      version: null,
      regions: null,
      state: 'retired',
      deprecation: null,
      retirement: { text: 'September 29, 2025', iso: '2025-09-29' },
      qualifier: 'exact',
      replacements: [],
      excerpt:
        '## September 29, 2025 - The following Gemini 1.5 models are now shut down: - `gemini-1.5-pro` - `gemini-1.5-flash-8b` - `gemini-1.5-flash`',
      notes: null,
    });
    expect(row('gemini-2.5-flash-exp-native-audio-thinking-dialog')).toMatchObject({
      retirement: { iso: '2025-10-20' },
    });
    expect(row('gemini-3.1-flash-lite-preview')).toMatchObject({
      retirement: { text: 'May 25, 2026', iso: '2026-05-25' },
      excerpt: '## May 25, 2026 - The `gemini-3.1-flash-lite-preview` model has been shut down.',
    });
  });

  it('leaves out shut-down bullets further down a section, and announcements', () => {
    expect(extraction.rows.map((r) => r.model_id)).toEqual([
      'gemini-2.0-flash',
      'gemini-2.0-flash-001',
      'gemini-2.0-flash-lite',
      'gemini-2.0-flash-lite-001',
      'gemini-3.1-flash-lite-preview',
      'gemini-2.5-flash-preview-native-audio-dialog',
      'gemini-2.5-flash-exp-native-audio-thinking-dialog',
      'gemini-1.5-pro',
      'gemini-1.5-flash-8b',
      'gemini-1.5-flash',
    ]);
  });

  it('reports a list item it does not read', () => {
    const changed = page('current.md');
    changed.text = changed.text.replace(
      '- `gemini-1.5-flash-8b`\n',
      '- `gemini-1.5-flash-8b` (`gemini-1.5-flash-8b-001`)\n',
    );
    expect(extractor.extract(changed, ctx).problems).toEqual([
      "## September 29, 2025: a list item the parser doesn't read: - `gemini-1.5-flash-8b` (`gemini-1.5-flash-8b-001`)",
    ]);
  });

  it('throws LayoutChangedError without dated sections', () => {
    expect(() => extractor.extract(page('layout-changed.md'), ctx)).toThrow(LayoutChangedError);
  });
});
