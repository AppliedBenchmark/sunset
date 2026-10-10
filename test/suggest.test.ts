// `model-id-unknown`: reordered model IDs get a "did you mean", anything else stays inventory.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { createSuggester } from '../src/core/registry/suggest.ts';
import type { Registry } from '../src/core/types.ts';
import { brief, fixtureRegistry } from './helpers.ts';

const real = parse(
  readFileSync(new URL('../registry/models.yaml', import.meta.url), 'utf8'),
) as Registry;

describe('createSuggester', () => {
  const suggest = createSuggester(fixtureRegistry);

  it('suggests the known ID for a reordering', () => {
    expect(suggest('claude-opus-fixture-9')).toEqual(['claude-fixture-opus-9']);
    expect(suggest('gpt-3-fixture-mini')).toEqual(['gpt-fixture-3-mini']);
  });

  it("doesn't suggest for known orders, other dates or unrelated IDs", () => {
    expect(suggest('claude-fixture-opus-9')).toEqual([]);
    expect(suggest('claude-fixture-1-20991231')).toEqual([]);
    expect(suggest('gpt-fixture-7')).toEqual([]);
    // Too short to be sure.
    expect(suggest('fixture-gpt')).toEqual([]);
  });

  it('catches the real typo found while dogfooding', () => {
    expect(createSuggester(real)('claude-haiku-3-5')).toContain('claude-3-5-haiku');
  });

  it('keeps the numbers in order and the shape of the ID', () => {
    // Swapped numbers make another model: `gpt-4-5` is no typo of `gpt-5.4`.
    expect(createSuggester(real)('gpt-4-5')).toEqual([]);
    // A first-party ID or an OpenRouter slug gets a first-party ID, a Bedrock ID a Bedrock ID.
    expect(suggest('anthropic/claude-opus-fixture-9')).toEqual(['anthropic/claude-fixture-opus-9']);
    expect(suggest('anthropic.claude-opus-fixture-9')).toEqual(['anthropic.claude-fixture-opus-9']);
  });
});

describe('model-id-unknown in a scan', () => {
  it('reports a notice in code, but not in docs', async () => {
    const code = await brief('a.ts', "const m = 'claude-opus-fixture-9';\n");
    expect(code.findings).toEqual(['model-id-unknown notice 1:12 claude-opus-fixture-9']);
    expect(code.result.findings[0]?.message).toBe(
      "claude-opus-fixture-9 isn't a model ID any provider lists. Did you mean claude-fixture-opus-9? Requests with an unknown ID fail.",
    );
    expect(code.inventory).toEqual(['claude-opus-fixture-9']);
    expect((await brief('README.md', 'Use claude-opus-fixture-9.\n')).findings).toEqual([]);
  });

  it('can be suppressed', async () => {
    const { findings, suppressed } = await brief(
      'a.ts',
      'const m = \'claude-opus-fixture-9\'; // sunset-ignore reason="gateway alias"\n',
    );
    expect(findings).toEqual([]);
    expect(suppressed).toEqual(['inline 1 claude-opus-fixture-9']);
  });
});
