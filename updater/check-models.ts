// The secondary list-models check: compares each provider's list-models API with the registry and
// opens one issue per provider for any difference, a second signal next to the pages. It never
// changes the registry. A provider whose credentials aren't set is skipped.
//
//   npm run registry:check-models -- --dry-run     print the differences
//   npm run registry:check-models -- --issues      file or close the issues (GITHUB_TOKEN, GITHUB_REPOSITORY)
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { parse } from 'yaml';
import type { PlatformFormats, Registry } from '../src/core/types.ts';
import { createIssueTracker, createLoggingIssueTracker } from './github.ts';
import { compareListing, listingIssue } from './list-models/compare.ts';
import { envFor, LISTERS } from './list-models/listers.ts';

const registryDir = fileURLToPath(new URL('../registry', import.meta.url));

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      'dry-run': { type: 'boolean', default: false },
      issues: { type: 'boolean', default: false },
    },
  });
  const registry = parse(await readFile(join(registryDir, 'models.yaml'), 'utf8')) as Registry;
  const formats = parse(
    await readFile(join(registryDir, 'formats.yaml'), 'utf8'),
  ) as PlatformFormats;
  const fileIssues = values.issues && !values['dry-run'];
  const tracker = fileIssues
    ? createIssueTracker({
        apiUrl: process.env.GITHUB_API_URL ?? 'https://api.github.com',
        graphqlUrl: process.env.GITHUB_GRAPHQL_URL,
        repository: process.env.GITHUB_REPOSITORY ?? '',
        token: process.env.GITHUB_TOKEN ?? '',
      })
    : createLoggingIssueTracker((line) => console.log(line));

  const results = await Promise.allSettled(
    LISTERS.map(async (lister) => {
      const env = envFor(lister, process.env);
      if (!env) {
        console.log(`${lister.name}: skipped (${lister.env.join(', ')} not set)`);
        return;
      }
      const listed = await lister.list(env, fetch);
      if (listed.length === 0) throw new Error('the API listed no models');
      const found = compareListing(lister, listed, registry, formats);
      console.log(`${lister.name}: ${listed.length} models listed, ${found.length} differences`);
      const key = `list-models:${lister.name}`;
      if (found.length) {
        const issue = listingIssue(lister, found);
        await tracker.upsert(key, issue.title, issue.body);
      } else {
        await tracker.close(key, 'The listing agrees with the registry again.');
      }
    }),
  );
  results.forEach((result, i) => {
    if (result.status === 'rejected') {
      // A failing API is the provider's problem, not the registry's: log it, don't file it.
      console.error(`${LISTERS[i]?.name}: failed: ${(result.reason as Error).message}`);
      process.exitCode = 1;
    }
  });
}

await main();
