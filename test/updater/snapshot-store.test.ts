// The .meta.json writer lays files out the way Biome formats JSON, so updater PRs pass `biome ci`.
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { formatMeta, type SnapshotMeta } from '../../updater/snapshot-store.ts';

const snapshots = new URL('../../registry/snapshots/', import.meta.url);

const meta = (urls: string[], rowClasses?: Record<string, string[]>): SnapshotMeta => ({
  source: 'p/s',
  urls,
  fetched_at: '2026-10-08T00:00:00Z',
  etag: null,
  last_modified: null,
  sha256: '0'.repeat(64),
  normalizer_version: 1,
  ...(rowClasses ? { row_classes: rowClasses } : {}),
});

describe('formatMeta', () => {
  it('reproduces every committed .meta.json byte for byte', () => {
    const files = readdirSync(snapshots, { recursive: true, encoding: 'utf8' }).filter((f) =>
      f.endsWith('.meta.json'),
    );
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const text = readFileSync(new URL(file, snapshots), 'utf8');
      expect(formatMeta(JSON.parse(text) as SnapshotMeta), file).toBe(text);
    }
  });

  it('puts an array of strings on one line when the line, with its comma, fits in 100 columns', () => {
    // `  "urls": ["…"],` is 15 characters around the URL.
    const fits = `https://x.dev/${'a'.repeat(85 - 14)}`;
    const long = `${fits}a`;
    expect(formatMeta(meta([fits]))).toContain(`  "urls": ["${fits}"],\n`);
    expect(formatMeta(meta([long]))).toContain(`  "urls": [\n    "${long}"\n  ],\n`);
    expect(formatMeta(meta(['https://a.dev/1', 'https://b.dev/"q"']))).toContain(
      '  "urls": ["https://a.dev/1", "https://b.dev/\\"q\\""],\n',
    );
  });

  it('leaves objects expanded and counts no comma after the last property', () => {
    // `    "row-gray": […]` is 20 characters around the item.
    const item = 'b'.repeat(80);
    expect(formatMeta(meta(['https://a.dev/'], { 'row-gray': [item] }))).toContain(
      `  "row_classes": {\n    "row-gray": ["${item}"]\n  }\n}\n`,
    );
  });
});
