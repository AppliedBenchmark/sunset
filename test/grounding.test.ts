// Grounding helpers and the snapshot normalizer.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  dateAppears,
  excerptInSnapshot,
  groundEntry,
  idAppears,
} from '../src/core/registry/grounding.ts';
import { collapseWhitespace, normalizeText } from '../src/core/registry/normalize.ts';
import type { IsoDate, RegistryEntry } from '../src/core/types.ts';
import { fixtureRegistry } from './helpers.ts';

describe('dateAppears', () => {
  const date = '2026-09-05' as IsoDate;

  it.each([
    '2026-09-05',
    '2026/09/05',
    '9/5/2026',
    '09/05/2026',
    'September 5, 2026',
    'September 05, 2026',
    'Sep 5, 2026',
    'Sept. 5, 2026',
    'Sep. 5th, 2026',
    '5 September 2026',
    'on September 5 2026.',
    '| Sep 5, 2026 |',
  ])('finds %s', (text) => {
    expect(dateAppears(date, text)).toBe(true);
  });

  it.each([
    '2026-09-15',
    '15/9/2026',
    'September 15, 2026',
    'October 5, 2026',
    'September 5, 2027',
    '19/5/2026',
    '2026-09-050',
  ])('rejects %s', (text) => {
    expect(dateAppears(date, text)).toBe(false);
  });

  it('handles May, which has no abbreviation', () => {
    expect(dateAppears('2027-05-07' as IsoDate, 'May 7, 2027')).toBe(true);
    expect(dateAppears('2027-05-07' as IsoDate, 'May. 7, 2027')).toBe(false);
  });
});

describe('idAppears', () => {
  it.each([
    ['gpt-4o', '| `gpt-4o` |', true],
    ['gpt-4o', 'use gpt-4o.', true],
    ['gpt-4o', '`gpt-4o-mini`', false],
    ['gpt-4o', 'xgpt-4o', false],
    ['claude-3-haiku', 'claude-3-haiku@20240307', false],
    ['anthropic.claude-v2', 'anthropic.claude-v2:1', false],
    ['anthropic.claude-v2', 'anthropic.claude-v2:free', true],
    ['gemini-1.5-flash', 'gemini-1.5-flash.', true],
    ['gemini-1.5', 'gemini-1.5.1', false],
    ['codestral-2405', "apiNames: ['codestral-2405']", true],
  ])('%s in %s → %s', (id, text, expected) => {
    expect(idAppears(id, text)).toBe(expected);
  });
});

describe('excerptInSnapshot', () => {
  it('ignores whitespace differences, including line breaks', () => {
    expect(excerptInSnapshot('a  b\nc', 'x a b c y')).toBe(true);
    expect(excerptInSnapshot('a b d', 'x a b c y')).toBe(false);
    expect(excerptInSnapshot('  ', 'x')).toBe(false);
  });
});

describe('groundEntry', () => {
  const entry = fixtureRegistry.models.find((e) => e.drop_in) as RegistryEntry;

  it('lists every value the excerpt lacks', () => {
    expect(groundEntry(entry, 'nothing here').map((p) => p.message)).toEqual([
      `the excerpt doesn't contain the model ID \`${entry.model_id}\``,
      `the excerpt doesn't contain deprecation_date ${entry.deprecation_date}`,
      `the excerpt doesn't contain retirement_date ${entry.retirement_date}`,
      `the excerpt doesn't contain the replacement \`${entry.recommended_replacements[0]?.model_id}\``,
      "drop_in is true, but the excerpt doesn't say drop-in",
    ]);
  });

  it('accepts a page-level no-earlier-than qualifier', () => {
    const soon: RegistryEntry = {
      ...entry,
      drop_in: false,
      deprecation_date: null,
      recommended_replacements: [],
      retirement_date_qualifier: 'no_earlier_than',
    };
    const excerpt = `${soon.model_id} retires on ${soon.retirement_date}`;
    expect(groundEntry(soon, excerpt).map((p) => p.level)).toEqual(['warning']);
    expect(groundEntry(soon, excerpt, { qualifier: 'no_earlier_than' })).toEqual([]);
    expect(groundEntry(soon, `${excerpt} at the earliest`)).toEqual([]);
  });

  it("doesn't need the model ID on a page about that model only", () => {
    const card: RegistryEntry = { ...entry, drop_in: false, recommended_replacements: [] };
    const excerpt = `Legacy ${card.deprecation_date}, EOL ${card.retirement_date}`;
    expect(groundEntry(card, excerpt).map((p) => p.message)).toEqual([
      `the excerpt doesn't contain the model ID \`${card.model_id}\``,
    ]);
    expect(groundEntry(card, excerpt, { models: [card.model_id] })).toEqual([]);
    expect(groundEntry(card, excerpt, { models: ['other'] })).toHaveLength(1);
  });
});

describe('normalizeText', () => {
  it('normalizes characters, links, comments and whitespace', () => {
    const page = [
      '﻿# Title  ',
      '',
      '',
      '| Apr 1, 2027 | [`gpt-x`](https://example.com/x "x") | ![logo](a.png) |',
      '<!-- hidden -->Shutdown‑date​\r',
      '\t indented\t\ttext',
      '',
      '',
    ].join('\n');
    expect(normalizeText(page, 'markdown')).toBe(
      '# Title\n\n| Apr 1, 2027 | `gpt-x` | logo |\nShutdown-date\nindented text\n',
    );
  });

  it('leaves links alone in plain text', () => {
    expect(normalizeText('see [x](y)', 'text')).toBe('see [x](y)\n');
  });

  it('is idempotent', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary' }), fc.boolean(), (text, md) => {
        const format = md ? 'markdown' : 'text';
        const once = normalizeText(text, format);
        expect(normalizeText(once, format)).toBe(once);
      }),
    );
  });

  it('collapses whitespace for excerpt matching', () => {
    expect(collapseWhitespace(' a \n\t b ')).toBe('a b');
  });
});
