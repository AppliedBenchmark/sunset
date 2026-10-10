// The DeepSeek change-log parser, which is best effort, on a saved page.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { LayoutChangedError } from '../../src/core/registry/extract.ts';
import { normalizeText } from '../../src/core/registry/normalize.ts';
import type { IsoDate, Source } from '../../src/core/types.ts';
import { extractor } from '../../updater/extract/deepseek-updates.ts';
import { htmlToText } from '../../updater/html-to-text.ts';

const fixture = (name: string) =>
  normalizeText(
    htmlToText(
      readFileSync(new URL(`../fixtures/pages/deepseek-updates/${name}`, import.meta.url), 'utf8'),
    ),
    'text',
  );
const source = { id: 'deepseek/updates', parser: 'deepseek-updates' } as Source;
const extract = (text: string) =>
  extractor.extract({ text, row_classes: {} }, { source, today: '2026-10-08' as IsoDate });

describe('deepseek-updates', () => {
  it('lists every model name the change log mentions, unverified and not exhaustive', () => {
    const { rows, problems, exhaustive } = extract(fixture('current.html'));
    expect(problems).toEqual([]);
    expect(exhaustive).toBe(false);
    expect(rows.map((r) => r.model_id)).toEqual([
      'deepseek-flash',
      'deepseek-v4-flash',
      'deepseek-v4-flash-vision-exp',
      'deepseek-coder',
      'deepseek-chat',
    ]);
    expect(rows[0]).toEqual({
      platform: 'deepseek',
      provider: 'deepseek',
      model_id: 'deepseek-flash',
      version: null,
      regions: null,
      state: 'unverified',
      deprecation: null,
      retirement: null,
      qualifier: 'exact',
      replacements: [],
      excerpt: 'Change the model name to deepseek-flash to call the latest V4.1 Flash model.',
      notes: 'Mentioned in the change log entry of 2026-09-10.',
    });
    // The first mention of `deepseek-v4-flash` isn't the prefix of a longer name.
    expect(rows[1]?.excerpt).toContain('the model names deepseek-v4-flash and');
  });

  it('throws LayoutChangedError without dated sections', () => {
    expect(() => extract(fixture('layout-changed.html'))).toThrow(LayoutChangedError);
    expect(() => extract('# Change Log\n\n## Date: 2026-01-01\n\nNothing here.\n')).toThrow(
      LayoutChangedError,
    );
  });
});
