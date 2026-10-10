// The models.yaml writer keeps the committed layout, so updater PRs touch only changed entries.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import type { Registry } from '../../src/core/types.ts';
import { formatRegistry, headerOf } from '../../updater/registry-yaml.ts';

const text = readFileSync(new URL('../../registry/models.yaml', import.meta.url), 'utf8');

describe('formatRegistry', () => {
  it('reproduces the committed models.yaml byte for byte', () => {
    expect(formatRegistry(parse(text) as Registry, headerOf(text))).toBe(text);
  });

  it('round-trips quotes, regions, aliases and an empty list', () => {
    const registry = parse(text) as Registry;
    const entry = registry.models[0];
    if (!entry) throw new Error('empty registry');
    const odd: Registry = {
      ...registry,
      models: [
        {
          ...entry,
          model_id: "it's",
          regions: ['us-gov-east-1', 'us-gov-west-1'],
          aliases: ['a', "b'c"],
          source_excerpt: "| it's | 'quoted' |",
          notes: 'line: with # and "double" quotes\nand a second line\twith a tab',
        },
      ],
    };
    expect(parse(formatRegistry(odd, '# header'))).toEqual(odd);
    const empty: Registry = { ...registry, models: [] };
    expect(parse(formatRegistry(empty, '# header'))).toEqual(empty);
  });
});
