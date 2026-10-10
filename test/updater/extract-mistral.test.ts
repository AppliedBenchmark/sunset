// The Mistral model-file parser on saved pages: the repo's TypeScript files, read as text and
// concatenated the way the fetcher does it.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { LayoutChangedError } from '../../src/core/registry/extract.ts';
import { normalizeText } from '../../src/core/registry/normalize.ts';
import type { IsoDate, Source } from '../../src/core/types.ts';
import { extractor } from '../../updater/extract/mistral-model-files.ts';

const fixture = (name: string) =>
  normalizeText(
    readFileSync(new URL(`../fixtures/pages/mistral-model-files/${name}`, import.meta.url), 'utf8'),
    'text',
  );
const source = { id: 'mistral/models', parser: 'mistral-model-files' } as Source;
const ctx = { source, today: '2026-10-08' as IsoDate };
const extract = (text: string) => extractor.extract({ text, row_classes: {} }, ctx);

describe('mistral-model-files', () => {
  it('reads API names, dates and states from each model file', () => {
    const { rows, problems, exhaustive } = extract(fixture('current.txt'));
    expect(problems).toEqual([]);
    expect(exhaustive).toBe(true);
    expect(rows.map((r) => r.model_id)).toEqual([
      'magistral-small-2509',
      'magistral-small-latest',
      'open-mistral-7b',
      'zai-glm-5-3',
      'zai-glm-5',
      'zai-glm-latest',
    ]);
    const magistral = rows[0];
    expect(magistral).toMatchObject({
      platform: 'mistral',
      provider: 'mistral',
      state: 'deprecated',
      deprecation: { text: 'April 30, 2026', iso: '2026-04-30' },
      retirement: { text: 'July 31, 2026', iso: '2026-07-31' },
      qualifier: 'exact',
      // "Mistral Small 4" is a display name, not an ID.
      replacements: [],
      notes: null,
    });
    expect(magistral?.excerpt).toMatch(
      /^identifiers: \{ apiNames: \['magistral-small-2509'.*metadata: \{.*\},$/,
    );
  });

  it('collapses an ID listed in two files with the same values', () => {
    const row = extract(fixture('current.txt')).rows.find((r) => r.model_id === 'open-mistral-7b');
    expect(row).toMatchObject({
      state: 'retired',
      retirement: { iso: '2025-03-30' },
      notes: 'Listed in 2 model files with the same dates; the excerpt is from mistral-7b-0-2.ts.',
    });
  });

  it('marks an ID listed in two files with different values unverified', () => {
    const text = fixture('current.txt').replace(
      "retirementDate: '2025-03-30', replacement: 'Ministral 3 8B'},\nplayground",
      "retirementDate: '2025-04-30', replacement: 'Ministral 3 8B'},\nplayground",
    );
    expect(text).not.toBe(fixture('current.txt'));
    const row = extract(text).rows.find((r) => r.model_id === 'open-mistral-7b');
    expect(row).toMatchObject({ state: 'unverified', deprecation: null, retirement: null });
  });

  it('names the other IDs of a file, and the maker of a third-party model', () => {
    const row = extract(fixture('current.txt')).rows.find((r) => r.model_id === 'zai-glm-5');
    expect(row).toMatchObject({
      provider: 'zai',
      state: 'available',
      notes: 'The same model file also lists zai-glm-5-3.',
    });
  });

  it('gives a floating `*-latest` name the values of the model file that lists it', () => {
    const { rows } = extract(fixture('current.txt'));
    const latest = rows.find((r) => r.model_id === 'magistral-small-latest');
    const pinned = rows.find((r) => r.model_id === 'magistral-small-2509');
    expect(latest).toEqual({
      ...pinned,
      model_id: 'magistral-small-latest',
      notes:
        'A floating name, which moves to newer models. The same model file also lists magistral-small-2509.',
    });
  });

  it('makes a `*-latest` name in two model files with different values unverified', () => {
    // A name is in two files while it moves to a newer model.
    const text = fixture('current.txt').replace(
      "apiNames: ['zai-glm-5-3', 'zai-glm-5', 'zai-glm-latest']",
      "apiNames: ['zai-glm-5-3', 'zai-glm-5', 'zai-glm-latest', 'magistral-small-latest']",
    );
    expect(text).not.toBe(fixture('current.txt'));
    const row = extract(text).rows.find((r) => r.model_id === 'magistral-small-latest');
    expect(row).toMatchObject({
      state: 'unverified',
      retirement: null,
      notes:
        'A floating name, which moves to newer models. Listed in 2 model files with different dates; left unverified.',
    });
  });

  it('reports a date in an unknown format', () => {
    const text = fixture('current.txt').replace("'April 30, 2026'", "'30/04/2026'");
    expect(extract(text).problems).toEqual([
      "magistral-small-1-2-25-09.ts: deprecationDate '30/04/2026' isn't an accepted date format",
    ]);
  });

  it('reports a status it does not know instead of reading the model as available', () => {
    const text = fixture('current.txt').replace("status: 'GA',", "status: 'Sunsetting',");
    expect(extract(text).problems).toEqual(["zai-glm-5-3.ts: unknown status 'Sunsetting'"]);
    expect(extract(text).rows.some((r) => r.model_id === 'zai-glm-5')).toBe(false);
  });

  it('throws LayoutChangedError when the files lose their structure', () => {
    expect(() => extract(fixture('layout-changed.txt'))).toThrow(LayoutChangedError);
    expect(() => extract('no files here\n')).toThrow(LayoutChangedError);
  });
});
