// The pure parts of the updater: date strings, statuses, and row grounding,
// including the negative cases that must stop a change.
import { describe, expect, it } from 'vitest';
import { parseDateString } from '../src/core/registry/date-strings.ts';
import {
  type ExtractedRow,
  groundRow,
  rowToEntry,
  statusFor,
} from '../src/core/registry/extract.ts';
import type { IsoDate, Source } from '../src/core/types.ts';

const d = (s: string) => s as IsoDate;

describe('parseDateString', () => {
  it.each([
    ['2026-11-05', '2026-11-05', 'exact'],
    ['November 5, 2026', '2026-11-05', 'exact'],
    ['Nov 5, 2026', '2026-11-05', 'exact'],
    ['Sept 30, 2026', '2026-09-30', 'exact'],
    ['at earliest 2026-11-05', '2026-11-05', 'no_earlier_than'],
    ['Not sooner than November 5, 2026', '2026-11-05', 'no_earlier_than'],
    ['Not sooner than Nov 24, 2026.', '2026-11-24', 'no_earlier_than'],
    ['No sooner than March 1, 2027', '2027-03-01', 'no_earlier_than'],
    ['November 5, 2026 or later', '2026-11-05', 'no_earlier_than'],
    ['No earlier than 2026-11-05', '2026-11-05', 'no_earlier_than'],
  ])('%s → %s (%s)', (text, iso, qualifier) => {
    expect(parseDateString(text)).toMatchObject({ kind: 'date', iso, qualifier });
  });

  it.each([
    'To be announced',
    'No shutdown date announced',
    'No retirement date announced',
    'N/A',
    '—',
    '',
  ])('"%s" is no date', (text) => {
    expect(parseDateString(text)).toEqual({ kind: 'none' });
  });

  it.each([
    '11/5/2026',
    '5 November 2026',
    'Q4 2026',
    'November 2026',
    '2026-02-30',
    'Smarch 5, 2026',
    'soon',
  ])('"%s" is a parse failure', (text) => {
    expect(parseDateString(text)).toEqual({ kind: 'invalid' });
  });
});

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
  '| 2026-11-05 | `gpt-old` | `gpt-new` |',
  '| 2027-01-10 | `gpt-other` | `gpt-newer` |',
  '',
].join('\n');

const row = (overrides: Partial<ExtractedRow> = {}): ExtractedRow => ({
  platform: 'openai',
  provider: 'openai',
  model_id: 'gpt-old',
  version: null,
  regions: null,
  state: 'deprecated',
  deprecation: null,
  retirement: { text: '2026-11-05', iso: d('2026-11-05') },
  qualifier: 'exact',
  replacements: ['gpt-new'],
  excerpt: '| 2026-11-05 | `gpt-old` | `gpt-new` |',
  notes: null,
  ...overrides,
});

describe('statusFor', () => {
  const today = d('2026-10-08');
  it('retires a model whose exact date has passed', () => {
    expect(statusFor(row({ retirement: { text: 'x', iso: d('2026-10-08') } }), today)).toBe(
      'retired',
    );
    expect(
      statusFor(row({ state: 'legacy', retirement: { text: 'x', iso: d('2026-01-01') } }), today),
    ).toBe('retired');
  });

  it('keeps a listed model with a passed no-earlier-than date', () => {
    const past = { text: 'x', iso: d('2026-05-14') };
    expect(
      statusFor(row({ state: 'available', retirement: past, qualifier: 'no_earlier_than' }), today),
    ).toBe('active');
    expect(
      statusFor(
        row({ state: 'deprecated', retirement: past, qualifier: 'no_earlier_than' }),
        today,
      ),
    ).toBe('deprecated');
    expect(
      statusFor(row({ state: 'retired', retirement: past, qualifier: 'no_earlier_than' }), today),
    ).toBe('retired');
  });

  it('uses the page state for future dates', () => {
    expect(statusFor(row(), today)).toBe('deprecated');
    expect(statusFor(row({ state: 'available', retirement: null }), today)).toBe('active');
    expect(statusFor(row({ state: 'unverified', retirement: null }), today)).toBe('unverified');
  });
});

describe('rowToEntry', () => {
  it('builds an entry with a computed id and never sets drop_in', () => {
    const entry = rowToEntry(row({ regions: ['us-west-2', 'us-east-1'] }), source, d('2026-10-08'));
    expect(entry).toMatchObject({
      id: 'openai:gpt-old#us-east-1,us-west-2',
      regions: ['us-east-1', 'us-west-2'],
      retirement_date: '2026-11-05',
      recommended_replacements: [{ model_id: 'gpt-new', platform: 'openai' }],
      drop_in: false,
      source: 'openai/deprecations',
      source_url: source.url,
      verified_on: '2026-10-08',
    });
  });
});

describe('groundRow', () => {
  const today = d('2026-10-08');
  const errors = (r: ExtractedRow, page = PAGE) =>
    groundRow(r, page, source, today)
      .filter((p) => p.level === 'error')
      .map((p) => p.message);

  it('accepts a row whose values are all in its excerpt, and the excerpt in the page', () => {
    expect(errors(row())).toEqual([]);
  });

  it('rejects an excerpt that is not word for word in the page', () => {
    expect(errors(row({ excerpt: '| 2026-11-05 | `gpt-old` | `gpt-new` | extra |' }))).toContain(
      "the excerpt isn't in the page",
    );
  });

  it('rejects a date taken from another row', () => {
    const other = { text: '2027-01-10', iso: d('2027-01-10') };
    expect(errors(row({ retirement: other }))).toEqual([
      'the retirement date "2027-01-10" isn\'t in the excerpt',
      "the excerpt doesn't contain retirement_date 2027-01-10",
    ]);
  });

  it('rejects an ISO date that differs from the parse of the date string', () => {
    expect(errors(row({ retirement: { text: '2026-11-05', iso: d('2026-11-06') } }))).toContain(
      'the retirement date "2026-11-05" doesn\'t parse to 2026-11-06',
    );
  });

  it('rejects a replacement the excerpt does not name', () => {
    expect(errors(row({ replacements: ['gpt-newer'] }))).toEqual([
      "the excerpt doesn't contain the replacement `gpt-newer`",
    ]);
  });

  it('rejects a model ID the excerpt does not contain', () => {
    expect(errors(row({ model_id: 'gpt-other' }))).toEqual([
      "the excerpt doesn't contain the model ID `gpt-other`",
    ]);
  });

  it('rejects an unverified row that carries values', () => {
    expect(errors(row({ state: 'unverified' }))).toContain(
      'an unverified row must not carry dates or replacements',
    );
  });
});
