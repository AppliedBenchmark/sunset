// The registry updater's command. For each provider: fetch its pages, refresh the snapshots,
// parse them, and merge grounded changes into registry/models.yaml; failures go to one issue per
// provider. The workflow (registry-update.yml) runs one provider per job and opens one PR per
// provider from the files this leaves in the working tree. run.ts wires it to the process.
//
//   npm run registry:update -- --dry-run                 every provider; print, write nothing
//   npm run registry:update -- --provider openai         write snapshots and models.yaml
//   npm run registry:update -- --provider openai --pr-dir <dir> --issues
//       also write <dir>/title.txt and <dir>/body.md for the PR, and file or close the issue
//       (needs GITHUB_TOKEN and GITHUB_REPOSITORY)
//
// Exit codes: 0 done (a failed source is reported in its provider's issue), 1 the updated
// registry doesn't validate (reported in the issues too) or something unexpected failed, 2 a usage
// or configuration error. Arguments and the environment are checked before anything is fetched or
// written.
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { parse } from 'yaml';
import { validateRegistryDir } from '../src/adapters/registry-files.ts';
import { parseIsoDate } from '../src/core/dates.ts';
import { validateRegistry, validateSources } from '../src/core/registry/validate.ts';
import type { IsoDate, Platform } from '../src/core/types.ts';
import { EXTRACTORS } from './extract/index.ts';
import { createFetcher } from './fetch-source.ts';
import { createIssueTracker, createLoggingIssueTracker } from './github.ts';
import { applyMerges } from './merge.ts';
import { changesOf, issueBody, prBody, prTitle } from './proposal.ts';
import { formatRegistry, headerOf } from './registry-yaml.ts';
import { SnapshotStore } from './snapshot-store.ts';
import { applicable, type ProviderRun, runProvider, type SourceRun } from './update.ts';

export interface UpdateIO {
  argv: readonly string[];
  env: Readonly<Record<string, string | undefined>>;
  /** The registry directory: sources.yaml, models.yaml and the snapshots. */
  registryDir: string;
  stdout(line: string): void;
  stderr(line: string): void;
  /** Fetches the pages and calls the GitHub API; defaults to the global fetch. */
  fetch?: typeof fetch;
  now?: () => Date;
}

class UsageError extends Error {
  override name = 'UsageError';
}

export async function runUpdate(io: UpdateIO): Promise<number> {
  try {
    return await update(io);
  } catch (error) {
    if (error instanceof UsageError) {
      io.stderr(error.message);
      return 2;
    }
    io.stderr(error instanceof Error ? (error.stack ?? error.message) : String(error));
    return 1;
  }
}

const OPTIONS = {
  provider: { type: 'string', multiple: true },
  'dry-run': { type: 'boolean', default: false },
  today: { type: 'string' },
  'pr-dir': { type: 'string' },
  issues: { type: 'boolean', default: false },
} as const;

function parseOptions(argv: readonly string[]) {
  try {
    return parseArgs({ args: [...argv], options: OPTIONS }).values;
  } catch (error) {
    throw new UsageError((error as Error).message);
  }
}

async function update(io: UpdateIO): Promise<number> {
  const values = parseOptions(io.argv);
  const now = io.now ?? (() => new Date());
  const dryRun = values['dry-run'];
  const prDir = values['pr-dir'];
  const fileIssues = values.issues && !dryRun;
  const today = values.today
    ? parseIsoDate(values.today)
    : (now().toISOString().slice(0, 10) as IsoDate);
  if (!today) throw new UsageError(`--today: not a YYYY-MM-DD date: ${values.today}`);

  const sourcesResult = validateSources(
    parse(await readFile(join(io.registryDir, 'sources.yaml'), 'utf8')),
  );
  const sources =
    sourcesResult.value ??
    usage(sourcesResult.issues.map((i) => `sources.yaml: ${i.subject}: ${i.message}`).join('\n'));
  const modelsPath = join(io.registryDir, 'models.yaml');
  const modelsText = await readFile(modelsPath, 'utf8');
  const loaded = validateRegistry(parse(modelsText));
  const registry =
    loaded.value ??
    usage(loaded.issues.map((i) => `models.yaml: ${i.subject}: ${i.message}`).join('\n'));

  const all = [...new Set(sources.sources.map((s) => s.provider))];
  const providers = [...new Set(values.provider ?? all)] as Platform[];
  const unknown = providers.filter((p) => !all.includes(p));
  if (unknown.length) {
    throw new UsageError(`Unknown providers: ${unknown.join(', ')} (known: ${all.join(', ')})`);
  }
  if (prDir && providers.length !== 1) {
    throw new UsageError('--pr-dir needs exactly one --provider');
  }
  const tracker = fileIssues
    ? createIssueTracker({
        apiUrl: io.env.GITHUB_API_URL ?? 'https://api.github.com',
        graphqlUrl: io.env.GITHUB_GRAPHQL_URL,
        repository: io.env.GITHUB_REPOSITORY || usage('--issues needs GITHUB_REPOSITORY'),
        token: io.env.GITHUB_TOKEN || usage('--issues needs GITHUB_TOKEN'),
        ...(io.fetch ? { fetch: io.fetch } : {}),
      })
    : createLoggingIssueTracker(io.stdout);

  const store = new SnapshotStore(io.registryDir);
  const fetcher = createFetcher(sources, { fetch: io.fetch, githubToken: io.env.GITHUB_TOKEN });
  const deps = { sources, registry, fetcher, store, extractors: EXTRACTORS, today };
  const runs = await Promise.all(providers.map((p) => runProvider(p, deps)));
  for (const run of runs) report(run, io.stdout);

  const { GITHUB_SERVER_URL: server, GITHUB_REPOSITORY: repo, GITHUB_RUN_ID: runId } = io.env;
  const runUrl = server && repo && runId ? `${server}/${repo}/actions/runs/${runId}` : null;

  const merges = runs.flatMap((run) => applicable(run).flatMap((s) => (s.merge ? [s.merge] : [])));
  const updated = applyMerges(registry, merges, today);
  const models = updated === registry ? null : formatRegistry(updated, headerOf(modelsText));
  const changedSnapshots = runs.flatMap((run) => applicable(run).filter((s) => s.changed));
  const errors = await validateStaged(io.registryDir, models, changedSnapshots, today);
  if (errors.length) {
    io.stderr('The updated registry does not validate, so nothing was written:');
    for (const e of errors) io.stderr(`  ${e}`);
  } else if (!dryRun) {
    for (const s of changedSnapshots) {
      if (s.changed) await store.write(s.source.id, s.changed, now());
    }
    if (models !== null) await writeFile(modelsPath, models);
    if (prDir) {
      const run = runs[0] as ProviderRun;
      await mkdir(prDir, { recursive: true });
      await writeFile(join(prDir, 'title.txt'), prTitle(run));
      await writeFile(join(prDir, 'body.md'), prBody(run, today, runUrl));
    }
  }

  for (const run of runs) {
    const key = `provider:${run.provider}`;
    const issue = issueBody(run, today, runUrl, errors);
    if (issue) {
      const outcome = await tracker.upsert(key, issue.title, issue.body);
      if (fileIssues) io.stdout(`issue for ${run.provider}: ${outcome}`);
    } else if (values.issues || dryRun) {
      const comment = `Fixed: every ${run.provider} source succeeded on ${today}${runUrl ? ` ([run](${runUrl}))` : ''}.`;
      if (await tracker.close(key, comment)) io.stdout(`issue for ${run.provider}: closed`);
    }
  }
  return errors.length ? 1 : 0;
}

function usage(message: string): never {
  throw new UsageError(message);
}

function report(run: ProviderRun, out: (line: string) => void): void {
  for (const s of run.sources) {
    const state = s.failure
      ? `failed (${s.failure.kind})`
      : s.changed
        ? 'page changed'
        : 'page unchanged';
    const changes = s.merge?.changes ?? [];
    const counts = ['added', 'updated', 'excerpt', 'reverified']
      .map((kind) => [kind, changes.filter((c) => c.kind === kind).length] as const)
      .filter(([, n]) => n)
      .map(([kind, n]) => `${n} ${kind}`);
    out(`${s.source.id}: ${state}${counts.length && !s.failure ? `; ${counts.join(', ')}` : ''}`);
    for (const detail of s.failure?.details ?? []) out(`  ${detail}`);
  }
  for (const c of changesOf(run).filter((c) => c.kind !== 'reverified')) {
    out(`  ${c.kind} ${c.after.id} ${c.fields.join(', ')}`);
  }
}

/**
 * The PR must pass `Validate registry`. Each source's entries were checked on their own; this runs
 * the same check as CI, `validateRegistryDir`, on a copy of the registry directory with the new
 * models.yaml (null: unchanged) and snapshots, so it also covers what sources share, such as
 * names that two sources both claim. Returns the errors.
 */
async function validateStaged(
  registryDir: string,
  models: string | null,
  snapshots: SourceRun[],
  today: IsoDate,
): Promise<string[]> {
  const dir = await mkdtemp(join(tmpdir(), 'sunset-registry-'));
  try {
    await cp(registryDir, dir, { recursive: true });
    if (models !== null) await writeFile(join(dir, 'models.yaml'), models);
    for (const s of snapshots) {
      if (!s.changed) continue;
      const path = join(dir, 'snapshots', `${s.source.id}.txt`);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, s.changed.text);
    }
    const { issues } = await validateRegistryDir(dir, today);
    return issues
      .filter((issue) => issue.level === 'error')
      .map((issue) => `${issue.file}${issue.subject ? ` ${issue.subject}` : ''}: ${issue.message}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
