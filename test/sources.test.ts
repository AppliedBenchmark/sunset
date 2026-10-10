// registry/sources.yaml validation and the URL allowlists.
import { describe, expect, it } from 'vitest';
import {
  fetchUrlOf,
  isAllowedUrl,
  validatePageFacts,
  validateSources,
} from '../src/core/registry/validate.ts';
import type { Source, SourcesFile } from '../src/core/types.ts';

const ALLOW = ['https://docs.example.com/api/docs/', 'https://example.com/models'];

describe('isAllowedUrl', () => {
  it.each([
    ['https://docs.example.com/api/docs/deprecations', true],
    ['https://docs.example.com/api/docs/', true],
    ['https://example.com/models', true],
    ['https://example.com/models/x', true],
    ['https://example.com/models-evil', false],
    ['https://docs.example.com/api/docsx', false],
    ['https://docs.example.com/api/', false],
    ['http://docs.example.com/api/docs/x', false],
    ['https://user:pw@docs.example.com/api/docs/x', false],
    ['https://docs.example.com.evil.net/api/docs/x', false],
    ['https://docs.example.com:8443/api/docs/x', false],
    ['https://docs.example.com/api/docs/../../admin', false],
    ['not a url', false],
  ])('%s → %s', (url, expected) => {
    expect(isAllowedUrl(url, ALLOW)).toBe(expected);
  });
});

const source = (overrides: Partial<Source>): Source => ({
  id: 'openai/deprecations',
  provider: 'openai',
  platforms: ['openai'],
  url: 'https://docs.example.com/api/docs/deprecations',
  fetch: {
    kind: 'url',
    url: 'https://docs.example.com/api/docs/deprecations.md',
    format: 'markdown',
  },
  parser: 'openai-deprecations',
  ...overrides,
});

function check(...sources: Source[]) {
  const file: SourcesFile = {
    schema_version: 1,
    providers: {
      openai: { allow: ['https://docs.example.com/api/docs/'] },
      mistral: { allow: ['https://raw.githubusercontent.com/acme/docs/'] },
    },
    sources,
  };
  return validateSources(file).issues.map((i) => `${i.subject}: ${i.message}`);
}

describe('validateSources', () => {
  it('accepts a valid file', () => {
    expect(check(source({}))).toEqual([]);
  });

  it('rejects duplicates, wrong prefixes and missing allowlists', () => {
    expect(check(source({}), source({}))).toEqual(['openai/deprecations: duplicate source id']);
    expect(check(source({ id: 'anthropic/x' }))).toEqual([
      'anthropic/x: the id must start with the provider, `openai/`',
    ]);
    expect(check(source({ id: 'vertex/x', provider: 'vertex' }))).toEqual([
      'vertex/x: provider `vertex` has no allowlist',
    ]);
  });

  it('rejects page and fetch URLs off the allowlist', () => {
    expect(
      check(
        source({
          url: 'https://evil.example.net/deprecations',
          fetch: { kind: 'url', url: 'https://evil.example.net/x.md', format: 'markdown' },
        }),
      ),
    ).toEqual([
      'openai/deprecations: url https://evil.example.net/deprecations is not on the allowlist',
      'openai/deprecations: fetch URL https://evil.example.net/x.md is not on the allowlist',
    ]);
  });

  it('rejects a markup URL off the allowlist', () => {
    const markup = (url: string) => source({ markup: { url, row_classes: ['row-gray'] } });
    expect(check(markup('https://docs.example.com/api/docs/deprecations'))).toEqual([]);
    expect(check(markup('https://evil.example.net/deprecations'))).toEqual([
      'openai/deprecations: markup URL https://evil.example.net/deprecations is not on the allowlist',
    ]);
  });

  it('checks GitHub fetches against the raw URL', () => {
    const github = (repo: string) =>
      source({
        id: 'mistral/models',
        provider: 'mistral',
        platforms: ['mistral'],
        url: 'https://raw.githubusercontent.com/acme/docs/main/README.md',
        fetch: { kind: 'github-dir', repo, ref: 'main', path: 'models', include: '.ts' },
      });
    expect(check(github('acme/docs'))).toEqual([]);
    expect(check(github('evil/docs'))).toEqual([
      'mistral/models: fetch URL https://raw.githubusercontent.com/evil/docs/main/models/ is not on the allowlist',
    ]);
  });

  it('rejects schema errors', () => {
    const bad = { schema_version: 1, providers: {}, sources: [{ id: 'x' }] };
    expect(validateSources(bad).value).toBeNull();
  });
});

describe('fetchUrlOf', () => {
  it('derives raw GitHub URLs', () => {
    expect(
      fetchUrlOf(
        source({ fetch: { kind: 'github-file', repo: 'a/b', ref: 'main', path: 'x/y.md' } }),
      ),
    ).toBe('https://raw.githubusercontent.com/a/b/main/x/y.md');
  });
});

describe('validatePageFacts', () => {
  it('requires the listed models on the page', () => {
    const s = source({ models: ['model-a', 'model-b'] });
    const file: SourcesFile = { schema_version: 1, providers: {}, sources: [s] };
    expect(validatePageFacts(file, new Map([[s.id, 'model-a and model-bb']]))).toEqual([
      { level: 'error', subject: s.id, message: 'model `model-b` is not in the snapshot' },
    ]);
  });

  it('requires the qualifier excerpt in the snapshot', () => {
    const s = source({
      page_qualifier: { qualifier: 'no_earlier_than', excerpt: 'dates are the earliest' },
    });
    const file: SourcesFile = { schema_version: 1, providers: {}, sources: [s] };
    expect(validatePageFacts(file, new Map([[s.id, 'All dates are the earliest.']]))).toEqual([]);
    expect(validatePageFacts(file, new Map([[s.id, 'Exact dates.']]))).toEqual([
      {
        level: 'error',
        subject: s.id,
        message: 'page_qualifier.excerpt is not in the snapshot',
      },
    ]);
  });
});
