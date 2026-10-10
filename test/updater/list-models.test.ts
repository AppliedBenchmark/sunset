// The secondary list-models check: only reports, never edits the registry.
import { describe, expect, it } from 'vitest';
import type { IsoDate, PlatformFormats, Registry, RegistryEntry } from '../../src/core/types.ts';
import { compareListing, listingIssue } from '../../updater/list-models/compare.ts';
import { envFor, LISTERS, type Lister, toIsoDate } from '../../updater/list-models/listers.ts';
import { sigV4Headers } from '../../updater/list-models/sigv4.ts';

const lister = (name: Lister['name']) => LISTERS.find((l) => l.name === name) as Lister;

const entry = (overrides: Partial<RegistryEntry>): RegistryEntry => ({
  id: `${overrides.platform ?? 'openai'}:${overrides.model_id ?? 'm'}`,
  provider: 'openai',
  platform: 'openai',
  model_id: 'm',
  version: null,
  aliases: [],
  status: 'active',
  deprecation_date: null,
  retirement_date: null,
  retirement_date_qualifier: 'exact',
  recommended_replacements: [],
  drop_in: false,
  source: 'openai/deprecations',
  source_url: 'https://developers.openai.com/api/docs/deprecations',
  source_excerpt: 'x',
  verified_on: '2026-10-08' as IsoDate,
  notes: null,
  ...overrides,
});

const registry = (...models: RegistryEntry[]): Registry => ({
  schema_version: 1,
  registry_version: 1,
  generated_at: '2026-10-08T00:00:00Z',
  models,
});

const formats: PlatformFormats = {
  bedrock: { geo_prefixes: ['us'], arn_partitions: ['aws'] },
  openrouter: { vendors: { openai: ['openai'], google: ['gemini-api', 'vertex'] } },
};

describe('compareListing', () => {
  it('reports date mismatches, retired models still listed and live models not listed', () => {
    const reg = registry(
      entry({ model_id: 'gpt-a', status: 'deprecated', retirement_date: '2026-12-01' as IsoDate }),
      entry({ model_id: 'gpt-b', status: 'retired', retirement_date: '2026-01-01' as IsoDate }),
      entry({ model_id: 'gpt-c' }),
      entry({ model_id: 'gpt-d', status: 'deprecated', retirement_date: '2027-01-01' as IsoDate }),
      entry({ model_id: 'gpt-gone', status: 'retired', retirement_date: '2025-01-01' as IsoDate }),
    );
    const found = compareListing(
      lister('openai'),
      [
        { id: 'gpt-a', end_date: '2026-12-15' },
        { id: 'gpt-b', end_date: null },
        { id: 'gpt-d', end_date: '2027-01-01' },
        { id: 'unknown-model', end_date: null },
      ],
      reg,
      formats,
    );
    expect(found).toEqual([
      {
        model: 'gpt-a',
        message: 'the API says 2026-12-15; the registry says 2026-12-01 (`openai:gpt-a`)',
      },
      { model: 'gpt-b', message: 'still listed, but the registry says it retired on 2026-01-01' },
      { model: 'gpt-c', message: "in the registry as active, but the API doesn't list it" },
    ]);
  });

  it('reports a dated OpenAI entry the API gives no date', () => {
    const reg = registry(
      entry({ model_id: 'gpt-a', status: 'deprecated', retirement_date: '2026-12-01' as IsoDate }),
    );
    expect(
      compareListing(lister('openai'), [{ id: 'gpt-a', end_date: null }], reg, formats),
    ).toEqual([
      {
        model: 'gpt-a',
        message: 'the API announces no shutdown date; the registry says 2026-12-01',
      },
    ]);
  });

  it('checks Mistral replacements and Bedrock lifecycle states', () => {
    const mistral = registry(
      entry({ platform: 'mistral', model_id: 'mistral-x', id: 'mistral:mistral-x' }),
    );
    expect(
      compareListing(
        lister('mistral'),
        [{ id: 'mistral-x', end_date: null, replacement: 'mistral-y' }],
        mistral,
        formats,
      ),
    ).toEqual([
      {
        model: 'mistral-x',
        message: "the API names the replacement `mistral-y`, which the registry doesn't list",
      },
    ]);
    const bedrock = registry(
      entry({ platform: 'bedrock', model_id: 'a.b-v1:0', id: 'bedrock:a.b-v1:0' }),
    );
    expect(
      compareListing(
        lister('bedrock'),
        [{ id: 'a.b-v1:0', end_date: null, lifecycle: 'LEGACY' }],
        bedrock,
        formats,
      ),
    ).toEqual([{ model: 'a.b-v1:0', message: 'the API says LEGACY; the registry says active' }]);
  });

  it('compares OpenRouter expiration dates with the upstream entry', () => {
    const reg = registry(
      entry({ platform: 'gemini-api', model_id: 'gemini-x', id: 'gemini-api:gemini-x' }),
    );
    const found = compareListing(
      lister('openrouter'),
      [
        { id: 'google/gemini-x', end_date: '2026-10-20' },
        { id: 'google/unknown', end_date: '2026-10-20' },
        { id: 'meta/llama', end_date: '2026-10-20' },
      ],
      reg,
      formats,
    );
    expect(found).toEqual([
      {
        model: 'google/gemini-x',
        message:
          'OpenRouter expires it on 2026-10-20; the registry says no date for `gemini-api:gemini-x`',
      },
    ]);
  });

  it("agrees when one of OpenRouter's platforms has its date", () => {
    const reg = registry(
      entry({ platform: 'gemini-api', model_id: 'gemini-x', id: 'gemini-api:gemini-x' }),
      entry({
        platform: 'vertex',
        model_id: 'gemini-x',
        id: 'vertex:gemini-x',
        retirement_date: '2026-10-20' as IsoDate,
      }),
      entry({ platform: 'gemini-api', model_id: 'gemini-y', id: 'gemini-api:gemini-y' }),
      entry({
        platform: 'vertex',
        model_id: 'gemini-y',
        id: 'vertex:gemini-y',
        retirement_date: '2026-11-01' as IsoDate,
      }),
    );
    const found = compareListing(
      lister('openrouter'),
      [
        { id: 'google/gemini-x', end_date: '2026-10-20' },
        { id: 'google/gemini-y', end_date: '2026-10-20' },
      ],
      reg,
      formats,
    );
    expect(found).toEqual([
      {
        model: 'google/gemini-y',
        message:
          'OpenRouter expires it on 2026-10-20; the registry says no date for `gemini-api:gemini-y`, 2026-11-01 for `vertex:gemini-y`',
      },
    ]);
  });

  it('builds an issue that says the check never changes the registry', () => {
    const issue = listingIssue(lister('openai'), [{ model: 'gpt-a', message: 'x' }]);
    expect(issue.title).toBe('List-models check: openai (1 difference)');
    expect(issue.body).toContain('never changes the registry');
    expect(issue.body).toContain('- `gpt-a`: x');
  });
});

describe('listers', () => {
  it('skips a lister whose credentials are missing', () => {
    expect(envFor(lister('openai'), {})).toBeNull();
    expect(envFor(lister('openai'), { OPENAI_API_KEY: 'k' })).toEqual({ OPENAI_API_KEY: 'k' });
    expect(envFor(lister('openrouter'), {})).toEqual({});
  });

  it('reads dates as ISO dates', () => {
    expect(toIsoDate('2026-11-05T00:00:00Z')).toBe('2026-11-05');
    expect(toIsoDate(1_793_836_800)).toBe('2026-11-05');
    expect(toIsoDate(null)).toBeNull();
    expect(toIsoDate('soon')).toBeNull();
  });

  it('reads the OpenAI listing', async () => {
    const fetchImpl = (async () =>
      Response.json({
        data: [
          { id: 'gpt-a', shutdown_date: '2026-11-05' },
          { id: 'gpt-b', shutdown_date: null },
          { nope: 1 },
        ],
      })) as unknown as typeof fetch;
    expect(await lister('openai').list({ OPENAI_API_KEY: 'k' }, fetchImpl)).toEqual([
      { id: 'gpt-a', end_date: '2026-11-05' },
      { id: 'gpt-b', end_date: null },
    ]);
  });

  it('follows Anthropic and Gemini pagination', async () => {
    const pages = [
      { data: [{ id: 'a' }], has_more: true, last_id: 'a' },
      { data: [{ id: 'b' }], has_more: false, last_id: 'b' },
    ];
    let i = 0;
    const anthropic = (async () => Response.json(pages[i++])) as unknown as typeof fetch;
    expect(await lister('anthropic').list({ ANTHROPIC_API_KEY: 'k' }, anthropic)).toEqual([
      { id: 'a' },
      { id: 'b' },
    ]);
    const gpages = [
      { models: [{ name: 'models/g1' }], nextPageToken: 't' },
      { models: [{ name: 'models/g2' }] },
    ];
    let j = 0;
    const gemini = (async () => Response.json(gpages[j++])) as unknown as typeof fetch;
    expect(await lister('gemini-api').list({ GEMINI_API_KEY: 'k' }, gemini)).toEqual([
      { id: 'g1' },
      { id: 'g2' },
    ]);
  });
});

describe('sigV4Headers', () => {
  // AWS's published "get-vanilla" test vector.
  it('matches the AWS test suite', () => {
    const headers = sigV4Headers({
      method: 'GET',
      url: 'https://example.amazonaws.com/',
      region: 'us-east-1',
      service: 'service',
      accessKeyId: 'AKIDEXAMPLE',
      secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
      now: new Date('2015-08-30T12:36:00Z'),
    });
    expect(headers).toEqual({
      'x-amz-date': '20150830T123600Z',
      authorization:
        'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31',
    });
  });
});
