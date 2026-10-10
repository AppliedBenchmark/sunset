// The parsers against the committed snapshots: when the registry is up to date, there is no diff.
// Every source's rows must reproduce its registry entries exactly: no additions, no value
// changes, nothing missing, every row grounded.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import type { IsoDate, Registry, RegistryEntry, SourcesFile } from '../../src/core/types.ts';
import { EXTRACTORS } from '../../updater/extract/index.ts';
import { mergeSource } from '../../updater/merge.ts';
import { SnapshotStore } from '../../updater/snapshot-store.ts';

const registryDir = fileURLToPath(new URL('../../registry', import.meta.url));
const sources = parse(readFileSync(`${registryDir}/sources.yaml`, 'utf8')) as SourcesFile;
const registry = parse(readFileSync(`${registryDir}/models.yaml`, 'utf8')) as Registry;
const store = new SnapshotStore(registryDir);

/**
 * Statuses depend on the date, so a source is judged as of its newest `verified_on`: the day the
 * updater last wrote its entries.
 */
function asOf(sourceId: string): IsoDate {
  const dates = registry.models.filter((e) => e.source === sourceId).map((e) => e.verified_on);
  return dates.reduce((max, d) => (d > max ? d : max), dates[0] ?? ('1970-01-01' as IsoDate));
}

describe.each(sources.sources.map((s) => [s.id, s] as const))('%s', (_, source) => {
  it('reproduces the registry from the committed snapshot', async () => {
    const snapshot = await store.read(source.id);
    expect(snapshot, 'snapshot').not.toBeNull();
    const extractor = EXTRACTORS.get(source.parser);
    expect(extractor, `parser ${source.parser}`).toBeDefined();
    const page = snapshot?.page ?? { text: '', row_classes: {} };
    const today = asOf(source.id);
    const extraction = extractor?.extract(page, { source, today });
    expect(extraction?.problems).toEqual([]);
    if (!extraction) return;
    const merge = mergeSource({ registry, source, extraction, page: page.text, today });
    expect({
      changes: merge.changes.map(
        (c) =>
          `${c.kind} ${c.after.id}${c.fields.length ? ` (${c.fields.map((f) => `${f}: ${JSON.stringify(c.before?.[f as keyof RegistryEntry])} → ${JSON.stringify(c.after[f as keyof RegistryEntry])}`).join('; ')})` : ''}`,
      ),
      missing: merge.missing.map((e) => e.id),
      rejected: merge.rejected.map(
        (r) => `${r.row.model_id}: ${r.problems.map((p) => p.message).join('; ')}`,
      ),
      problems: merge.problems,
      unreviewed: merge.unreviewed.map((r) => r.model_id),
    }).toEqual({ changes: [], missing: [], rejected: [], problems: [], unreviewed: [] });
  });
});
