// The Vertex AI parsers on saved pages: Google's model versions, the deprecated partner and open
// models, the per-model Claude pages, and model pages with a deprecation notice or Versions rows.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { LayoutChangedError, type NormalizedPage } from '../../src/core/registry/extract.ts';
import { normalizeText } from '../../src/core/registry/normalize.ts';
import type { IsoDate, Source, SourcesFile } from '../../src/core/types.ts';
import { extractor as claudePage } from '../../updater/extract/vertex-claude-model-page.ts';
import { extractor as notice } from '../../updater/extract/vertex-deprecation-notice.ts';
import { extractor as pageVersions } from '../../updater/extract/vertex-model-page-versions.ts';
import { extractor as modelVersions } from '../../updater/extract/vertex-model-versions.ts';
import { extractor as openModels } from '../../updater/extract/vertex-open-model-deprecations.ts';
import { extractor as partner } from '../../updater/extract/vertex-partner-deprecations.ts';
import { htmlToText } from '../../updater/html-to-text.ts';

const sources = parse(
  readFileSync(new URL('../../registry/sources.yaml', import.meta.url), 'utf8'),
) as SourcesFile;
const ctxFor = (id: string) => {
  const source = sources.sources.find((s) => s.id === id);
  if (!source) throw new Error(`${id} is not in sources.yaml`);
  return { source, today: '2026-10-08' as IsoDate };
};

function page(parser: string, name: string): NormalizedPage {
  const raw = readFileSync(new URL(`../fixtures/pages/${parser}/${name}`, import.meta.url), 'utf8');
  return {
    text: name.endsWith('.html')
      ? normalizeText(htmlToText(raw), 'text')
      : normalizeText(raw, 'markdown'),
    row_classes: {},
  };
}

describe('vertex-model-versions', () => {
  const ctx = ctxFor('vertex/model-versions');
  const extraction = modelVersions.extract(page('vertex-model-versions', 'current.md'), ctx);
  const row = (id: string) => extraction.rows.find((r) => r.model_id === id);

  it('reads every table without problems', () => {
    expect(extraction.problems).toEqual([]);
    expect(extraction.rows).toHaveLength(30);
  });

  it('reads `or later` as a no-earlier-than date on an available model', () => {
    expect(row('gemini-3.5-flash')).toEqual({
      platform: 'vertex',
      provider: 'google',
      model_id: 'gemini-3.5-flash',
      version: null,
      regions: null,
      state: 'available',
      deprecation: null,
      retirement: { text: 'May 19, 2027 or later', iso: '2027-05-19' },
      qualifier: 'no_earlier_than',
      replacements: [],
      excerpt: '| `gemini-3.5-flash` | May 19, 2026 | May 19, 2027 or later | |',
      notes: null,
    });
    expect(row('gemini-embedding-001')).toMatchObject({
      retirement: { text: 'No sooner than May 20, 2028', iso: '2028-05-20' },
      qualifier: 'no_earlier_than',
    });
  });

  it('keeps only replacement IDs, not display names', () => {
    expect(row('gemini-2.5-flash-lite')).toMatchObject({
      state: 'available',
      retirement: { text: 'October 20, 2026', iso: '2026-10-20' },
      qualifier: 'exact',
      replacements: ['gemini-3.8-flash', 'gemini-3.1-flash-lite'],
    });
  });

  it('reads an empty date cell as no date', () => {
    expect(row('gemini-embedding-2')).toMatchObject({ retirement: null, qualifier: 'exact' });
  });

  it('marks the retired table as retired and drops footnote marks', () => {
    expect(row('textembedding-gecko@003')).toMatchObject({
      state: 'retired',
      retirement: { text: 'May 24, 2025', iso: '2025-05-24' },
      replacements: ['gemini-embedding-001'],
    });
  });

  it('reports an unknown date format', () => {
    const changed = page('vertex-model-versions', 'current.md');
    changed.text = changed.text.replace('| April 1, 2027 |', '| 2027 Q2 |');
    expect(modelVersions.extract(changed, ctx).problems).toEqual([
      '`text-embedding-005`: unknown date format "2027 Q2"',
    ]);
  });

  it('reports a table with a retirement date but other columns', () => {
    const changed = page('vertex-model-versions', 'current.md');
    changed.text = changed.text.replace(
      '### Embeddings models',
      '### New models\n\n| Model | Release date | Retirement date | Replacement model ID |\n| `gemini-9` | May 1, 2026 | May 1, 2027 | |\n\n### Embeddings models',
    );
    expect(modelVersions.extract(changed, ctx).problems).toEqual([
      `a table under "New models" has columns the parser doesn't know: Model | Release date | Retirement date | Replacement model ID`,
    ]);
  });

  it('throws LayoutChangedError when the headers change', () => {
    expect(() =>
      modelVersions.extract(page('vertex-model-versions', 'layout-changed.md'), ctx),
    ).toThrow(LayoutChangedError);
  });
});

describe('vertex-partner-deprecations', () => {
  const ctx = ctxFor('vertex/partner-deprecations');
  const extraction = partner.extract(page('vertex-partner-deprecations', 'current.md'), ctx);

  it('reads one deprecated model per section, across wrapped lines', () => {
    expect(extraction.problems).toEqual([]);
    expect(extraction.rows.map((r) => [r.model_id, r.provider])).toEqual([
      ['claude-3-haiku', 'anthropic'],
      ['claude-3-5-haiku', 'anthropic'],
      ['jamba-1.5-large', 'ai21'],
    ]);
    const haiku = extraction.rows[1];
    expect(haiku).toMatchObject({
      platform: 'vertex',
      state: 'deprecated',
      deprecation: { text: 'January 5, 2026', iso: '2026-01-05' },
      retirement: { text: 'July 5, 2026', iso: '2026-07-05' },
      qualifier: 'exact',
      replacements: [],
    });
    expect(haiku?.excerpt).toMatch(
      /^Claude 3\.5 Haiku on Google Cloud is \*\*deprecated as of January 5, 2026\*\* and will be \*\*shut down on July 5, 2026\*\*\..* \| Model ID \| `claude-3-5-haiku` \|\|$/,
    );
  });

  it('reports an unknown date format', () => {
    const changed = page('vertex-partner-deprecations', 'current.md');
    changed.text = changed.text.replace(
      '**shut down on July 5, 2026**',
      '**shut down in mid 2026**',
    );
    expect(partner.extract(changed, ctx).problems).toEqual([
      '`claude-3-5-haiku`: no "**shut down on <date>**" sentence',
    ]);
    changed.text = changed.text.replace('**shut down in mid 2026**', '**shut down on 07/05/2026**');
    expect(partner.extract(changed, ctx).problems[0]).toMatch(
      /^`claude-3-5-haiku`: unknown date format in/,
    );
  });

  it('throws LayoutChangedError when no section can be read', () => {
    expect(() =>
      partner.extract(page('vertex-partner-deprecations', 'layout-changed.md'), ctx),
    ).toThrow(LayoutChangedError);
  });
});

describe('vertex-claude-model-page', () => {
  const ctx = ctxFor('vertex/claude-opus-4-5');

  it('reads the retirement line and the model ID', () => {
    const extraction = claudePage.extract(page('vertex-claude-model-page', 'current.md'), ctx);
    expect(extraction).toEqual({
      rows: [
        {
          platform: 'vertex',
          provider: 'anthropic',
          model_id: 'claude-opus-4-5',
          version: null,
          regions: null,
          state: 'available',
          deprecation: null,
          retirement: { text: 'Not sooner than Nov 24, 2026', iso: '2026-11-24' },
          qualifier: 'no_earlier_than',
          replacements: [],
          excerpt: '**Retirement Date:** Not sooner than Nov 24, 2026.',
          notes: null,
        },
      ],
      problems: [],
      exhaustive: true,
    });
  });

  it('reports an unknown date format, and a page about another model', () => {
    const changed = page('vertex-claude-model-page', 'current.md');
    changed.text = changed.text.replace('Not sooner than Nov 24, 2026', 'Late 2026');
    expect(claudePage.extract(changed, ctx).problems).toEqual([
      '`claude-opus-4-5`: unknown date format "Late 2026"',
    ]);
    const other = claudePage.extract(
      page('vertex-claude-model-page', 'current.md'),
      ctxFor('vertex/claude-opus-4-6'),
    );
    expect(other.problems).toEqual(['the page is about `claude-opus-4-5`, not claude-opus-4-6']);
  });

  it('throws LayoutChangedError without the retirement line', () => {
    expect(() =>
      claudePage.extract(page('vertex-claude-model-page', 'layout-changed.md'), ctx),
    ).toThrow(LayoutChangedError);
  });
});

describe('vertex-open-model-deprecations', () => {
  const ctx = {
    source: { id: 'vertex/test', provider: 'vertex' } as Source,
    today: '2026-10-08' as IsoDate,
  };
  const extraction = openModels.extract(page('vertex-open-model-deprecations', 'current.md'), ctx);
  const row = (id: string) => extraction.rows.find((r) => r.model_id === id);

  it('reads every row as a deprecated model, with the maker from the ID', () => {
    expect(extraction.problems).toEqual([]);
    expect(extraction.rows).toHaveLength(16);
    expect(row('llama-3.3-70b-instruct-maas')).toEqual({
      platform: 'vertex',
      provider: 'meta',
      model_id: 'llama-3.3-70b-instruct-maas',
      version: null,
      regions: null,
      state: 'deprecated',
      deprecation: { text: 'July 21, 2026', iso: '2026-07-21' },
      retirement: { text: 'October 21, 2026', iso: '2026-10-21' },
      qualifier: 'exact',
      replacements: [],
      excerpt:
        '| `llama-3.3-70b-instruct-maas` | July 21, 2026 | October 21, 2026 | Self-deploy Llama 3.3 on Model Garden |',
      notes: null,
    });
    expect(
      Object.fromEntries(
        [
          'gpt-oss-20b-maas',
          'glm-5-maas',
          'kimi-k2-thinking-maas',
          'multilingual-e5-small-maas',
        ].map((id) => [id, row(id)?.provider]),
      ),
    ).toEqual({
      'gpt-oss-20b-maas': 'openai',
      'glm-5-maas': 'zai',
      'kimi-k2-thinking-maas': 'moonshotai',
      'multilingual-e5-small-maas': 'intfloat',
    });
  });

  it('reports an unknown date format and an unknown model maker', () => {
    const changed = page('vertex-open-model-deprecations', 'current.md');
    changed.text = changed.text
      .replace(
        '| `glm-5-maas` | July 21, 2026 | October 21, 2026 |',
        '| `glm-5-maas` | July 21, 2026 | Q4 2026 |',
      )
      .replace('`minimax-m2-maas`', '`falcon-3-maas`');
    expect(openModels.extract(changed, ctx).problems).toEqual([
      '`glm-5-maas`: unknown date format "Q4 2026"',
      '`falcon-3-maas`: unknown model maker',
    ]);
  });

  it('reports a row with no date, and a table with other columns', () => {
    const changed = page('vertex-open-model-deprecations', 'current.md');
    changed.text = changed.text
      .replace(
        '| `glm-5-maas` | July 21, 2026 | October 21, 2026 |',
        '| `glm-5-maas` | To be announced | To be announced |',
      )
      .concat('\n| Model ID | Retirement date |\n|---|---|\n| `glm-9-maas` | May 1, 2027 |\n');
    expect(openModels.extract(changed, ctx).problems).toEqual([
      '`glm-5-maas` is listed as deprecated but has no date',
      `a table under "Deprecation and retirement details" has columns the parser doesn't know: Model ID | Retirement date`,
    ]);
  });

  it('throws LayoutChangedError when the headers change', () => {
    expect(() =>
      openModels.extract(page('vertex-open-model-deprecations', 'layout-changed.md'), ctx),
    ).toThrow(LayoutChangedError);
  });
});

describe('vertex-deprecation-notice', () => {
  const models = ['grok-4.1-fast-reasoning', 'grok-4.1-fast-non-reasoning'];
  const ctx = {
    source: { id: 'vertex/test', provider: 'vertex', models } as Source,
    today: '2026-10-08' as IsoDate,
  };
  const NOTICE =
    '**Deprecated:** The Grok 4.1 model family (including `xai/grok-4.1-fast-reasoning` and `xai/grok-4.1-fast-non-reasoning`) is deprecated on the Gemini Enterprise Agent Platform and will be shut down on August 20, 2026.';

  it('reads the shutdown date for every model of the page', () => {
    const extraction = notice.extract(page('vertex-deprecation-notice', 'current.md'), ctx);
    expect(extraction.problems).toEqual([]);
    expect(extraction.rows).toEqual(
      models.map((model_id) => ({
        platform: 'vertex',
        provider: 'xai',
        model_id,
        version: null,
        regions: null,
        state: 'deprecated',
        deprecation: null,
        retirement: { text: 'August 20, 2026', iso: '2026-08-20' },
        qualifier: 'exact',
        replacements: [],
        excerpt: NOTICE,
        notes: null,
      })),
    );
  });

  it('reports a model the notice does not name, and an unknown date format', () => {
    const changed = page('vertex-deprecation-notice', 'current.md');
    changed.text = changed.text.replace(' and `xai/grok-4.1-fast-non-reasoning`', '');
    expect(notice.extract(changed, ctx).problems).toEqual([
      "the notice doesn't name `grok-4.1-fast-non-reasoning`",
    ]);
    const undated = page('vertex-deprecation-notice', 'current.md');
    undated.text = undated.text.replace(
      'shut down on August 20, 2026.',
      'shut down on 08/20/2026.',
    );
    expect(notice.extract(undated, ctx).problems).toEqual([
      expect.stringMatching(/^unknown date format "08\/20\/2026" in: \*\*Deprecated:\*\*/),
    ]);
  });

  it('reports a page about another model', () => {
    const other = { ...ctx, source: { ...ctx.source, models: ['grok-4.1-fast-reasoning'] } };
    expect(notice.extract(page('vertex-deprecation-notice', 'current.md'), other).problems).toEqual(
      ['the page is about `grok-4.1-fast-non-reasoning`, not grok-4.1-fast-reasoning'],
    );
  });

  it('throws LayoutChangedError without the notice', () => {
    expect(() =>
      notice.extract(page('vertex-deprecation-notice', 'layout-changed.md'), ctx),
    ).toThrow(LayoutChangedError);
  });
});

describe('vertex-model-page-versions', () => {
  const models = [
    'imagen-4.0-generate-001',
    'imagen-4.0-fast-generate-001',
    'imagen-4.0-ultra-generate-001',
  ];
  const ctx = {
    source: { id: 'vertex/test', provider: 'vertex', models } as Source,
    today: '2026-10-08' as IsoDate,
  };
  const ROW =
    '| Versions | imagen-4.0-generate-001 Launch stage: GA Release date: August 14, 2025 Discontinuation date: June 30, 2026 | imagen-4.0-generate-001 Launch stage: GA Release date: August 14, 2025 Discontinuation date: June 30, 2026 |';

  it("reads each model's discontinuation date from its Versions row", () => {
    const extraction = pageVersions.extract(
      page('vertex-model-page-versions', 'current.html'),
      ctx,
    );
    expect(extraction.problems).toEqual([]);
    expect(extraction.rows.map((r) => r.model_id)).toEqual(models);
    expect(extraction.rows[0]).toEqual({
      platform: 'vertex',
      provider: 'google',
      model_id: 'imagen-4.0-generate-001',
      version: null,
      regions: null,
      state: 'available',
      deprecation: null,
      retirement: { text: 'June 30, 2026', iso: '2026-06-30' },
      qualifier: 'exact',
      replacements: [],
      excerpt: ROW,
      notes: null,
    });
  });

  it('reads a Deprecated launch stage, and reports one without a date', () => {
    const changed = page('vertex-model-page-versions', 'current.html');
    changed.text = changed.text
      .replaceAll(
        'imagen-4.0-ultra-generate-001 Launch stage: GA',
        'imagen-4.0-ultra-generate-001 Launch stage: Deprecated',
      )
      .replaceAll(
        'imagen-4.0-fast-generate-001 Launch stage: GA Release date: August 14, 2025 Discontinuation date: June 30, 2026',
        'imagen-4.0-fast-generate-001 Launch stage: Deprecated Release date: August 14, 2025',
      );
    const extraction = pageVersions.extract(changed, ctx);
    expect(extraction.problems).toEqual([
      '`imagen-4.0-fast-generate-001` is deprecated but has no discontinuation date',
    ]);
    expect(extraction.rows.find((r) => r.model_id === 'imagen-4.0-ultra-generate-001')?.state).toBe(
      'deprecated',
    );
  });

  it('reports an unknown date format, and a model the source does not list', () => {
    const changed = page('vertex-model-page-versions', 'current.html');
    changed.text = changed.text.replaceAll(
      'imagen-4.0-ultra-generate-001 Launch stage: GA Release date: August 14, 2025 Discontinuation date: June 30, 2026',
      'imagen-4.0-ultra-generate-001 Launch stage: GA Release date: August 14, 2025 Discontinuation date: mid 2026',
    );
    const other = { ...ctx, source: { ...ctx.source, models: models.slice(1) } };
    expect(pageVersions.extract(changed, other).problems).toEqual([
      "the page lists `imagen-4.0-generate-001`, which isn't one of imagen-4.0-fast-generate-001, imagen-4.0-ultra-generate-001",
      '`imagen-4.0-ultra-generate-001`: unknown date format "mid 2026"',
    ]);
  });

  it('throws LayoutChangedError without a Versions row', () => {
    expect(() =>
      pageVersions.extract(page('vertex-model-page-versions', 'layout-changed.html'), ctx),
    ).toThrow(LayoutChangedError);
  });
});
