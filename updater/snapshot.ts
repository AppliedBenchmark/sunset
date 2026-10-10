// Fetches and normalizes source pages into registry/snapshots/<provider>/<slug>.txt, with a
// .meta.json beside each. Each source runs in isolation; one failure doesn't
// stop the others. The full updater (`npm run registry:update`) does this too, then parses the
// pages; this command only refreshes snapshots.
//
//   npm run registry:snapshot                         every source
//   npm run registry:snapshot -- openai/deprecations  only the named sources
//   npm run registry:snapshot -- --dry-run            report changes without writing
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { parse } from 'yaml';
import { validateSources } from '../src/core/registry/validate.ts';
import type { Source } from '../src/core/types.ts';
import { createFetcher } from './fetch-source.ts';
import { SnapshotStore } from './snapshot-store.ts';

const registryDir = fileURLToPath(new URL('../registry', import.meta.url));

type Outcome = 'unchanged' | 'updated' | 'created';

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { 'dry-run': { type: 'boolean', default: false } },
  });
  const { value: sources, issues } = validateSources(
    parse(await readFile(join(registryDir, 'sources.yaml'), 'utf8')),
  );
  if (!sources) {
    for (const issue of issues) console.error(`sources.yaml: ${issue.subject}: ${issue.message}`);
    process.exitCode = 2;
    return;
  }
  const unknown = positionals.filter((id) => !sources.sources.some((s) => s.id === id));
  if (unknown.length) {
    console.error(`Unknown sources: ${unknown.join(', ')}`);
    process.exitCode = 2;
    return;
  }
  const store = new SnapshotStore(registryDir);
  const fetcher = createFetcher(sources, { githubToken: process.env.GITHUB_TOKEN });
  const snapshot = async (source: Source): Promise<Outcome> => {
    const previous = await store.read(source.id);
    // Unconditional: this command also re-normalizes pages after a normalizer change.
    const fetched = await fetcher.fetch(source, null);
    if (fetched === 'not-modified' || !SnapshotStore.changed(previous, fetched)) return 'unchanged';
    if (!values['dry-run']) await store.write(source.id, fetched, new Date());
    return previous ? 'updated' : 'created';
  };
  const selected = sources.sources.filter(
    (s) => positionals.length === 0 || positionals.includes(s.id),
  );
  const results = await Promise.allSettled(selected.map(snapshot));
  results.forEach((result, i) => {
    const id = (selected[i] as Source).id;
    if (result.status === 'fulfilled') console.log(`${result.value.padEnd(9)} ${id}`);
    else {
      console.error(`failed    ${id}: ${(result.reason as Error).message}`);
      process.exitCode = 1;
    }
  });
}

await main();
