// The Bedrock parsers against saved pages: the lifecycle tables and the model cards, each with a
// `current` and a `layout-changed` fixture, and a card with a second model ID on bedrock-mantle.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { LayoutChangedError } from '../../src/core/registry/extract.ts';
import { normalizeText } from '../../src/core/registry/normalize.ts';
import type { IsoDate, Source } from '../../src/core/types.ts';
import { extractor as lifecycle } from '../../updater/extract/bedrock-lifecycle-table.ts';
import { extractor as card } from '../../updater/extract/bedrock-model-card.ts';
import { htmlToText } from '../../updater/html-to-text.ts';

const fixture = (parser: string, name: string) =>
  normalizeText(
    htmlToText(
      readFileSync(new URL(`../fixtures/pages/${parser}/${name}`, import.meta.url), 'utf8'),
    ),
    'text',
  );
const page = (text: string) => ({ text, row_classes: {} });
const ctx = {
  source: { id: 'bedrock/test', provider: 'bedrock' } as Source,
  today: '2026-10-08' as IsoDate,
};

describe('bedrock-lifecycle-table', () => {
  const text = fixture('bedrock-lifecycle-table', 'current.html');

  it('reads every row, one entry per model when the regional rows agree', () => {
    const { rows, problems, exhaustive } = lifecycle.extract(page(text), ctx);
    expect(problems).toEqual([]);
    expect(exhaustive).toBe(true);
    const haiku = rows.filter((r) => r.model_id === 'anthropic.claude-3-haiku-20240307-v1:0');
    expect(haiku).toEqual([
      {
        platform: 'bedrock',
        provider: 'anthropic',
        model_id: 'anthropic.claude-3-haiku-20240307-v1:0',
        version: null,
        regions: null,
        state: 'deprecated',
        deprecation: { text: 'March 10, 2026', iso: '2026-03-10' },
        retirement: { text: 'September 10, 2026', iso: '2026-09-10' },
        qualifier: 'exact',
        replacements: [],
        excerpt: expect.stringMatching(
          /^\| Anthropic \| Claude 3 Haiku \| anthropic\.claude-3-haiku/,
        ),
        notes: 'Public extended access starts 2026-06-10.',
      },
    ]);
    const canvas = rows.find((r) => r.model_id === 'amazon.nova-canvas-v1:0');
    expect(canvas?.notes).toBeNull();
    expect(canvas?.provider).toBe('amazon');
  });

  it('scopes rows by region when their dates differ', () => {
    const header =
      '| Model provider | Model name | Model ID | Regions | Legacy date | EOL date | Public extended access start date |';
    const rows = lifecycle.extract(
      page(
        `${header}\n| A | M | a.m-v1:0 | us-west-2, us-east-1 | March 1, 2026 | September 1, 2026 | — |\n| A | M | a.m-v1:0 | us-gov-west-1 | March 1, 2026 | October 1, 2026 | — |\n`,
      ),
      ctx,
    ).rows;
    expect(rows.map((r) => [r.regions, r.retirement?.iso])).toEqual([
      [['us-east-1', 'us-west-2'], '2026-09-01'],
      [['us-gov-west-1'], '2026-10-01'],
    ]);
  });

  it('accepts a page whose lifecycle section has no table yet', () => {
    const text = '# Model lifecycle\n\n## Legacy and end-of-life (EOL) models\n\nLegacy — …\n';
    expect(lifecycle.extract(page(text), ctx)).toEqual({
      rows: [],
      problems: [],
      exhaustive: true,
    });
  });

  it('reports another table with a Model ID column', () => {
    const third =
      '\n| Model provider | Model name | Model ID | Regions | End-of-life date |\n| A | M | a.m-v2:0 | us-east-1 | May 1, 2027 |\n';
    expect(lifecycle.extract(page(`${text}${third}`), ctx).problems).toEqual([
      `a table under "Legacy and end-of-life (EOL) models" has columns the parser doesn't know: Model provider | Model name | Model ID | Regions | End-of-life date`,
    ]);
  });

  it('reports a layout change', () => {
    expect(() =>
      lifecycle.extract(page(fixture('bedrock-lifecycle-table', 'layout-changed.html')), ctx),
    ).toThrow(LayoutChangedError);
    expect(() => lifecycle.extract(page('# Model lifecycle\n\nNothing here.\n'), ctx)).toThrow(
      LayoutChangedError,
    );
  });

  it('reports an unknown date format as a problem', () => {
    const changed = text.replace('September 10, 2026', 'Q3 2026');
    const { rows, problems } = lifecycle.extract(page(changed), ctx);
    expect(problems).toEqual([expect.stringContaining('unrecognized EOL date "Q3 2026"')]);
    expect(rows.some((r) => r.retirement?.text === 'Q3 2026')).toBe(false);
  });
});

describe('bedrock-model-card', () => {
  const text = fixture('bedrock-model-card', 'current.html');

  it('reads the earliest possible EOL date', () => {
    expect(card.extract(page(text), ctx)).toEqual({
      rows: [
        {
          platform: 'bedrock',
          provider: 'xai',
          model_id: 'xai.grok-4.7',
          version: null,
          regions: null,
          state: 'available',
          deprecation: null,
          retirement: { text: 'September 28, 2027', iso: '2027-09-28' },
          qualifier: 'no_earlier_than',
          replacements: [],
          excerpt: 'EOL no sooner than: September 28, 2027',
          notes: null,
        },
      ],
      problems: [],
      exhaustive: true,
    });
  });

  it('prefers an announced EOL date', () => {
    const legacy = text.replace('Model EOL date: N/A', 'Model EOL date: March 28, 2028');
    const [row] = card.extract(page(legacy), ctx).rows;
    expect(row).toMatchObject({
      state: 'deprecated',
      qualifier: 'exact',
      retirement: { iso: '2028-03-28' },
      excerpt: 'Model EOL date: March 28, 2028',
    });
  });

  it('reads the bedrock-runtime ID of a card with a second ID on bedrock-mantle', () => {
    const twoIds = fixture('bedrock-model-card', 'two-ids.html');
    expect(card.extract(page(twoIds), ctx)).toEqual({
      rows: [
        {
          platform: 'bedrock',
          provider: 'deepseek',
          model_id: 'deepseek.v3-v1:0',
          version: null,
          regions: null,
          state: 'deprecated',
          deprecation: null,
          retirement: { text: 'March 30, 2027', iso: '2027-03-30' },
          qualifier: 'exact',
          replacements: [],
          excerpt: 'Model EOL date: March 30, 2027',
          notes: 'The card also lists deepseek.v3.1, the model ID on bedrock-mantle.',
        },
      ],
      problems: [],
      exhaustive: true,
    });
  });

  it('reports two IDs that are not one per endpoint, and skips cells that are not IDs', () => {
    const twoIds = fixture('bedrock-model-card', 'two-ids.html');
    const sameEndpoint = twoIds.replace(
      '| bedrock-mantle | deepseek.v3.1 |',
      '| bedrock-runtime | deepseek.v3.1 |',
    );
    expect(sameEndpoint).not.toBe(twoIds);
    expect(card.extract(page(sameEndpoint), ctx).problems).toEqual([
      'the card lists more than one base model ID: deepseek.v3-v1:0, deepseek.v3.1',
    ]);
    const none = twoIds.replace(
      '| bedrock-runtime | deepseek.v3-v1:0 |',
      '| bedrock-runtime | N/A |',
    );
    expect(card.extract(page(none), ctx).rows).toEqual([
      expect.objectContaining({ model_id: 'deepseek.v3.1', notes: null }),
    ]);
  });

  it('reports a layout change', () => {
    expect(() =>
      card.extract(page(fixture('bedrock-model-card', 'layout-changed.html')), ctx),
    ).toThrow(LayoutChangedError);
  });

  it('reports a layout change when the Model EOL date line is renamed', () => {
    // Read without it, an announced EOL date would be missed for the earliest possible one.
    const renamed = text.replace('Model EOL date: N/A', 'Model end-of-life date: March 28, 2028');
    expect(renamed).not.toBe(text);
    expect(() => card.extract(page(renamed), ctx)).toThrow(LayoutChangedError);
  });

  it('reports an unknown date format as a problem', () => {
    const changed = text.replace('September 28, 2027', 'late 2027');
    expect(card.extract(page(changed), ctx)).toEqual({
      rows: [],
      problems: [expect.stringContaining('unrecognized date "no sooner than: late 2027"')],
      exhaustive: true,
    });
  });
});
