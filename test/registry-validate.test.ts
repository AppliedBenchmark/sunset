// The registry validator, including negative tests for each rule.
import { describe, expect, it } from 'vitest';
import {
  computeEntryId,
  entryErrors,
  looksFloating,
  type RegistryContext,
  validateFormats,
  validateRegistry,
} from '../src/core/registry/validate.ts';
import type { IsoDate, RegistryEntry, SourcesFile } from '../src/core/types.ts';
import { fixtureRegistry, formats } from './helpers.ts';

const TODAY = '2026-10-08' as IsoDate;
const URL_ = 'https://docs.example.com/models/deprecations';

const sources: SourcesFile = {
  schema_version: 1,
  providers: { openai: { allow: ['https://docs.example.com/models/'] } },
  sources: [
    {
      id: 'openai/deprecations',
      provider: 'openai',
      platforms: ['openai', 'azure-openai'],
      url: URL_,
      fetch: { kind: 'url', url: `${URL_}.md`, format: 'markdown' },
      parser: 'openai-deprecations',
    },
  ],
};

const SNAPSHOT = `# Deprecations

| Shutdown date | Model | Recommended replacement |
| Apr 1, 2027 | \`model-a-2025-01-01\` | \`model-b\` |
| Jan 6, 2027 | \`model-c\` | \`model-b\` |

model-d was deprecated on March 3, 2026 and retires on September 3, 2026.
`;

const context: RegistryContext = {
  sources,
  snapshots: new Map([['openai/deprecations', SNAPSHOT]]),
  today: TODAY,
};

function entry(overrides: Partial<RegistryEntry> = {}): RegistryEntry {
  const base: RegistryEntry = {
    id: '',
    provider: 'openai',
    platform: 'openai',
    model_id: 'model-a-2025-01-01',
    version: null,
    aliases: [],
    status: 'deprecated',
    deprecation_date: null,
    retirement_date: '2027-04-01' as IsoDate,
    retirement_date_qualifier: 'exact',
    recommended_replacements: [{ model_id: 'model-b', platform: 'openai' }],
    drop_in: false,
    source: 'openai/deprecations',
    source_url: URL_,
    source_excerpt: '| Apr 1, 2027 | `model-a-2025-01-01` | `model-b` |',
    verified_on: TODAY,
    notes: null,
    ...overrides,
  };
  return { ...base, id: overrides.id ?? computeEntryId(base) };
}

const modelB = entry({
  model_id: 'model-b',
  status: 'active',
  retirement_date: null,
  recommended_replacements: [],
  source_excerpt: '| Jan 6, 2027 | `model-c` | `model-b` |',
});

function registry(...models: RegistryEntry[]) {
  return {
    schema_version: 1,
    registry_version: 1,
    generated_at: '2026-10-08T00:00:00Z',
    models: [...models, modelB],
  };
}

/** The error messages, as `subject: message`. */
function errors(...models: RegistryEntry[]): string[] {
  return validateRegistry(registry(...models), context)
    .issues.filter((i) => i.level === 'error')
    .map((i) => `${i.subject}: ${i.message}`);
}

function warnings(...models: RegistryEntry[]): string[] {
  return validateRegistry(registry(...models), context)
    .issues.filter((i) => i.level === 'warning')
    .map((i) => i.message);
}

describe('validateRegistry', () => {
  it('accepts a grounded entry', () => {
    const result = validateRegistry(registry(entry()), context);
    expect(result.issues).toEqual([]);
    expect(result.value?.models).toHaveLength(2);
  });

  it('reports a few hundred thousand collisions without overflowing the stack', () => {
    const aliases = Array.from({ length: 200_000 }, (_, i) => `alias-${i}`);
    const twin = (model_id: string) =>
      entry({ model_id, aliases, status: 'active', retirement_date: null });
    const result = validateRegistry(registry(twin('m-0'), twin('m-1')));
    expect(result.value).toBeNull();
    expect(result.issues.length).toBeGreaterThanOrEqual(200_000);
  });

  it('accepts the test-only registry without sources (schema and key checks)', () => {
    const result = validateRegistry(fixtureRegistry);
    expect(result.issues.filter((i) => i.level === 'error')).toEqual([]);
  });

  describe('rejects broken entries', () => {
    it('rejects an entry without source_url', () => {
      const { source_url: _, ...rest } = entry();
      const result = validateRegistry(registry(rest as RegistryEntry), context);
      expect(result.value).toBeNull();
      expect(result.issues.map((i) => i.message)).toContain(
        "schema: / must have required property 'source_url'",
      );
    });

    it('rejects a domain that is not on the allowlist', () => {
      const evil = 'https://evil.example.net/models/deprecations';
      expect(errors(entry({ source_url: evil }))).toEqual([
        `openai:model-a-2025-01-01: source_url must be the source's url, ${URL_}`,
        `openai:model-a-2025-01-01: source_url ${evil} is not on the openai allowlist`,
      ]);
    });

    it('rejects an excerpt that is not in the snapshot', () => {
      expect(
        errors(entry({ source_excerpt: '| Apr 1, 2027 | `model-a-2025-01-01` | `model-b` | x' })),
      ).toEqual([
        'openai:model-a-2025-01-01: source_excerpt is not in the snapshot of `openai/deprecations`',
      ]);
    });

    it('rejects a date that is not in the excerpt', () => {
      expect(errors(entry({ retirement_date: '2027-01-06' as IsoDate }))).toEqual([
        "openai:model-a-2025-01-01: the excerpt doesn't contain retirement_date 2027-01-06",
      ]);
    });

    it('rejects an id that does not match the entry', () => {
      expect(errors(entry({ id: 'openai:model-a' }))).toEqual([
        'openai:model-a: id must be `openai:model-a-2025-01-01` (computed from the entry)',
      ]);
    });

    it('rejects an alias that collides with another entry', () => {
      expect(errors(entry({ aliases: ['model-b'] }))).toContain(
        'openai:model-b: `model-b` is already a model ID or alias of openai:model-a-2025-01-01',
      );
    });

    it('rejects a deprecation date after the retirement date', () => {
      expect(errors(entry({ deprecation_date: '2027-05-01' as IsoDate }))).toContain(
        'openai:model-a-2025-01-01: deprecation_date 2027-05-01 is after retirement_date 2027-04-01',
      );
    });
  });

  it('rejects a model ID, version or replacement missing from the excerpt', () => {
    expect(errors(entry({ model_id: 'model-a' }))).toContain(
      "openai:model-a: the excerpt doesn't contain the model ID `model-a`",
    );
    expect(
      errors(entry({ recommended_replacements: [{ model_id: 'model-z', platform: 'openai' }] })),
    ).toContain("openai:model-a-2025-01-01: the excerpt doesn't contain the replacement `model-z`");
    expect(errors(entry({ platform: 'azure-openai', version: '2024-01-01' }))).toContain(
      "azure-openai:model-a-2025-01-01@2024-01-01: the excerpt doesn't contain the version `2024-01-01`",
    );
  });

  it('accepts dates written out in prose', () => {
    const prose = entry({
      model_id: 'model-d',
      deprecation_date: '2026-03-03' as IsoDate,
      retirement_date: '2026-09-03' as IsoDate,
      status: 'retired',
      recommended_replacements: [],
      source_excerpt: 'model-d was deprecated on March 3, 2026 and retires on September 3, 2026.',
    });
    expect(errors(prose)).toEqual([]);
  });

  it('rejects duplicate ids and overlapping regions', () => {
    const a = entry({ platform: 'openai' });
    expect(errors(a, a)).toContain('openai:model-a-2025-01-01: duplicate id');
    const east = entry({ regions: ['us-east-1', 'us-west-2'] });
    const west = entry({ regions: ['us-west-2'] });
    expect(errors(east, west)).toContain(
      'openai:model-a-2025-01-01#us-west-2: region us-west-2 is also listed by openai:model-a-2025-01-01#us-east-1,us-west-2',
    );
    expect(errors(east, entry())).toEqual([]);
  });

  it('requires sorted regions', () => {
    const unsorted = entry({ regions: ['us-west-2', 'us-east-1'] });
    expect(errors(unsorted)).toContain(
      'openai:model-a-2025-01-01#us-east-1,us-west-2: regions must be sorted',
    );
  });

  it('accepts region names as AWS and Google Cloud write them', () => {
    // GovCloud, the European Sovereign Cloud, a Google Cloud region, Vertex AI's multi-regions.
    for (const region of ['us-gov-west-1', 'eusc-de-east-1', 'us-central1', 'global', 'eu']) {
      expect(errors(entry({ regions: [region] })), region).toEqual([]);
    }
    for (const region of ['US-East-1', 'us_east_1', 'us east 1', 'us--east-1', '-us', 'us-', '']) {
      expect(errors(entry({ regions: [region] })).join('\n'), region).toMatch(
        /schema: \/regions\/0 must match pattern/,
      );
    }
  });

  it('checks versions by platform', () => {
    expect(errors(entry({ platform: 'azure-openai' }))).toContain(
      'azure-openai:model-a-2025-01-01: azure-openai entries need a version',
    );
    expect(errors(entry({ version: '1' }))).toContain(
      'openai:model-a-2025-01-01@1: only azure-openai entries have a version',
    );
  });

  it('lets Azure entries share a model name across versions', () => {
    const v1 = entry({
      platform: 'azure-openai',
      model_id: 'model-c',
      version: '2027',
      retirement_date: '2027-01-06' as IsoDate,
      source_excerpt: '| Jan 6, 2027 | `model-c` | `model-b` |',
      recommended_replacements: [],
    });
    const v2 = { ...v1, version: '6', id: 'azure-openai:model-c@6' };
    expect(errors(v1, v2)).toEqual([]);
  });

  it('checks status against dates and excerpts', () => {
    expect(errors(entry({ retirement_date: null, status: 'retired' }))).toContain(
      'openai:model-a-2025-01-01: a retired entry needs a date; without one it must be unverified',
    );
    const bare = entry({
      status: 'active',
      retirement_date: null,
      recommended_replacements: [],
      source_excerpt: null,
    });
    expect(errors(bare)).toEqual([
      'openai:model-a-2025-01-01: only unverified entries may omit source_excerpt',
    ]);
    expect(errors({ ...bare, status: 'unverified' })).toEqual([]);
    expect(
      errors({ ...bare, status: 'unverified', retirement_date: '2027-04-01' as IsoDate }),
    ).toEqual([
      'openai:model-a-2025-01-01: dates and replacements need a source_excerpt that supports them',
    ]);
  });

  it('checks replacements', () => {
    expect(errors(entry({ drop_in: true, recommended_replacements: [] }))).toContain(
      'openai:model-a-2025-01-01: drop_in is true but there is no replacement',
    );
    expect(
      errors(
        entry({
          recommended_replacements: [{ model_id: 'model-a-2025-01-01', platform: 'openai' }],
        }),
      ),
    ).toContain('openai:model-a-2025-01-01: the entry lists itself as a replacement');
    expect(
      warnings(
        entry({
          model_id: 'model-c',
          retirement_date: '2027-01-06' as IsoDate,
          source_excerpt: '| Jan 6, 2027 | `model-c` | `model-b` |',
          recommended_replacements: [{ model_id: 'model-b', platform: 'vertex' }],
        }),
      ),
    ).toEqual(['replacement `model-b` (vertex) is not in the registry']);
    expect(warnings(entry({ drop_in: true }))).toEqual([
      "drop_in is true, but the excerpt doesn't say drop-in",
    ]);
  });

  it('checks the source record', () => {
    expect(errors(entry({ source: 'openai/missing' }))).toContain(
      'openai:model-a-2025-01-01: source `openai/missing` is not in registry/sources.yaml',
    );
    expect(errors(entry({ platform: 'vertex' }))).toContain(
      "vertex:model-a-2025-01-01: source `openai/deprecations` doesn't cover platform vertex",
    );
    const noSnapshot = validateRegistry(registry(entry()), { ...context, snapshots: new Map() });
    expect(noSnapshot.issues.map((i) => i.message)).toContain(
      'there is no snapshot for source `openai/deprecations`',
    );
  });

  it('rejects verified_on in the future and impossible dates', () => {
    expect(errors(entry({ verified_on: '2026-10-09' as IsoDate }))).toEqual([]);
    expect(errors(entry({ verified_on: '2026-10-10' as IsoDate }))).toContain(
      'openai:model-a-2025-01-01: verified_on 2026-10-10 is in the future',
    );
    expect(errors(entry({ retirement_date: '2027-02-30' as IsoDate }))).toContain(
      'openai:model-a-2025-01-01: retirement_date 2027-02-30 is not a date',
    );
  });

  it('warns about floating aliases and no-earlier-than dates the excerpt lacks', () => {
    expect(warnings(entry({ aliases: ['model-a'] }))).toEqual([
      'alias `model-a` looks like a floating alias; floating aliases need their own entry',
    ]);
    expect(warnings(entry({ retirement_date_qualifier: 'no_earlier_than' }))).toEqual([
      "retirement_date_qualifier is no_earlier_than, but the excerpt doesn't say so",
    ]);
    expect(errors(entry({ aliases: ['model-a-2025-01-01'] }))).toContain(
      'openai:model-a-2025-01-01: alias `model-a-2025-01-01` repeats the model ID',
    );
  });

  it('names the entry in schema errors', () => {
    const result = validateRegistry(registry(entry({ status: 'gone' as 'retired' })), context);
    expect(result.issues).toEqual([
      {
        level: 'error',
        subject: 'openai:model-a-2025-01-01',
        message:
          'schema: /status must be equal to one of the allowed values (active, legacy, deprecated, retired, unverified)',
      },
    ]);
    const extra = validateRegistry({ ...registry(), extra: 1 });
    expect(extra.issues[0]?.message).toBe(
      'schema: / must NOT have additional properties (`extra`)',
    );
  });
});

describe('entryErrors', () => {
  it('checks one entry on its own, without its sources or the other entries', () => {
    expect(entryErrors(entry())).toEqual([]);
    // Not a problem of one entry: the replacement isn't in the registry, and the source is unknown.
    expect(
      entryErrors(entry({ recommended_replacements: [{ model_id: 'x', platform: 'openai' }] })),
    ).toEqual([]);
    expect(entryErrors(entry({ source: 'openai/missing' }))).toEqual([]);
    expect(entryErrors(entry({ regions: ['us-east-1', 'EU'] }))[0]).toEqual({
      level: 'error',
      subject: 'openai:model-a-2025-01-01#EU,us-east-1',
      message: 'schema: /regions/1 must match pattern "^[a-z0-9]+(-[a-z0-9]+)*$"',
    });
    expect(entryErrors({ ...entry(), id: 'openai:other' })).toEqual([
      {
        level: 'error',
        subject: 'openai:other',
        message: 'id must be `openai:model-a-2025-01-01` (computed from the entry)',
      },
    ]);
    expect(entryErrors('x')[0]).toMatchObject({
      subject: null,
      message: 'schema: / must be object',
    });
  });
});

describe('computeEntryId', () => {
  it('adds the version and sorted regions', () => {
    expect(
      computeEntryId({ platform: 'bedrock', model_id: 'a.b-v1:0', version: null, regions: null }),
    ).toBe('bedrock:a.b-v1:0');
    expect(
      computeEntryId({
        platform: 'bedrock',
        model_id: 'a.b-v1:0',
        version: null,
        regions: ['us-west-2', 'us-east-1'],
      }),
    ).toBe('bedrock:a.b-v1:0#us-east-1,us-west-2');
    expect(
      computeEntryId({ platform: 'azure-openai', model_id: 'gpt-4o', version: '2024-08-06' }),
    ).toBe('azure-openai:gpt-4o@2024-08-06');
  });
});

describe('looksFloating', () => {
  it.each([
    ['gpt-4o', 'gpt-4o-2024-08-06', true],
    ['claude-3-5-sonnet-latest', 'claude-3-5-sonnet-20241022', true],
    ['claude-3-haiku', 'claude-3-haiku-20240307', true],
    ['gpt-4', 'gpt-4-0613', true],
    ['gemini-1.5-flash', 'gemini-1.5-flash-002', true],
    ['gpt-4o', 'gpt-4o-mini', false],
    ['text-davinci', 'davinci-002', false],
  ])('%s for %s → %s', (alias, modelId, expected) => {
    expect(looksFloating(alias, modelId)).toBe(expected);
  });
});

describe('validateFormats', () => {
  it('accepts registry/formats.yaml and rejects unknown platforms', () => {
    expect(validateFormats(formats).issues).toEqual([]);
    const bad = { ...formats, openrouter: { vendors: { acme: ['acme'] } } };
    expect(validateFormats(bad).value).toBeNull();
  });
});
