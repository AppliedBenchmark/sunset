// One provider's update: fetch → normalize → parse → ground → merge → validate, for each of its
// sources. Every source fails on its own: a failed source opens (or keeps open) the provider's
// issue and leaves its snapshot and registry entries unchanged; the others carry on.

import type { Extractor, FetchedPage, Fetcher } from '../src/core/ports.ts';
import type { ExtractContext } from '../src/core/registry/extract.ts';
import { LayoutChangedError } from '../src/core/registry/extract.ts';
import { validatePageFacts, validateRegistry } from '../src/core/registry/validate.ts';
import type { IsoDate, Platform, Registry, Source, SourcesFile } from '../src/core/types.ts';
import { mergeIsClean, mergeSource, type SourceMerge } from './merge.ts';
import { type Snapshot, SnapshotStore } from './snapshot-store.ts';

export type FailureKind =
  | 'fetch'
  | 'layout-changed'
  | 'parse'
  | 'grounding'
  | 'missing'
  | 'invalid';

export interface SourceFailure {
  kind: FailureKind;
  details: string[];
}

export interface SourceRun {
  source: Source;
  /** The stored snapshot before this run. */
  previous: Snapshot | null;
  /** The fetched page when it differs from the stored snapshot; null when unchanged. */
  changed: FetchedPage | null;
  merge: SourceMerge | null;
  failure: SourceFailure | null;
}

export interface ProviderRun {
  provider: Platform;
  sources: SourceRun[];
}

export interface UpdateDeps {
  sources: SourcesFile;
  registry: Registry;
  fetcher: Fetcher;
  store: SnapshotStore;
  extractors: ReadonlyMap<string, Extractor>;
  today: IsoDate;
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * What sources.yaml says about the whole page (its `page_qualifier` sentence, the `models` of a
 * model card) must still be on it; otherwise the qualifier or the models would vouch for a page
 * that no longer says so.
 */
function pageFactProblems(source: Source, page: string, deps: UpdateDeps): string[] {
  return validatePageFacts(
    { ...deps.sources, sources: [source] },
    new Map([[source.id, page]]),
  ).map((issue) => `sources.yaml: ${issue.message}`);
}

/**
 * The source's entries as the merge leaves them, checked against the page the way `Validate
 * registry` checks them once the page is the committed snapshot. This catches values the validator
 * rejects (a deprecated model with no date) and excerpts that are no longer on the page, which a
 * best-effort source never refreshes.
 */
function invalidEntries(
  source: Source,
  merge: SourceMerge,
  page: string,
  deps: UpdateDeps,
): string[] {
  const after = new Map(merge.changes.map((c) => [c.after.id, c.after]));
  const models = [
    ...deps.registry.models.filter((e) => e.source === source.id).map((e) => after.get(e.id) ?? e),
    ...merge.changes.filter((c) => c.kind === 'added').map((c) => c.after),
  ];
  const { issues } = validateRegistry(
    { ...deps.registry, models },
    { sources: deps.sources, snapshots: new Map([[source.id, page]]), today: deps.today },
  );
  return issues
    .filter((issue) => issue.level === 'error')
    .map((issue) => (issue.subject ? `\`${issue.subject}\`: ${issue.message}` : issue.message));
}

async function runSource(source: Source, deps: UpdateDeps): Promise<SourceRun> {
  const run: SourceRun = { source, previous: null, changed: null, merge: null, failure: null };
  const fail = (kind: FailureKind, details: string[]) => {
    run.failure = { kind, details };
    return run;
  };
  run.previous = await deps.store.read(source.id);

  let fetched: FetchedPage | 'not-modified';
  try {
    fetched = await deps.fetcher.fetch(source, run.previous?.meta ?? null);
  } catch (error) {
    return fail('fetch', [message(error)]);
  }
  if (fetched !== 'not-modified' && SnapshotStore.changed(run.previous, fetched)) {
    run.changed = fetched;
  }
  const page = run.changed ?? run.previous?.page;
  if (!page)
    return fail('fetch', ['the server answered 304 Not Modified, but there is no snapshot']);

  const facts = pageFactProblems(source, page.text, deps);
  if (facts.length) return fail('layout-changed', facts);

  const extractor = deps.extractors.get(source.parser);
  if (!extractor) return fail('parse', [`no parser named \`${source.parser}\``]);
  const ctx: ExtractContext = { source, today: deps.today };
  let extraction: ReturnType<Extractor['extract']>;
  try {
    extraction = extractor.extract(page, ctx);
  } catch (error) {
    if (error instanceof LayoutChangedError) return fail('layout-changed', [error.message]);
    return fail('parse', [`the parser failed: ${message(error)}`]);
  }
  if (extraction.problems.length) return fail('parse', extraction.problems);

  const merge = mergeSource({
    registry: deps.registry,
    source,
    extraction,
    page: page.text,
    today: deps.today,
  });
  run.merge = merge;
  if (merge.rejected.length) {
    return fail(
      'grounding',
      merge.rejected.map(
        (r) => `\`${r.row.model_id}\`: ${r.problems.map((p) => p.message).join('; ')}`,
      ),
    );
  }
  if (!mergeIsClean(merge)) return fail('parse', merge.problems);
  if (merge.missing.length) {
    // Nothing is deleted; a human decides whether the model was removed or the parser missed it.
    return fail(
      'missing',
      merge.missing.map((e) => `\`${e.id}\` is in the registry but no longer on the page`),
    );
  }
  const invalid = invalidEntries(source, merge, page.text, deps);
  if (invalid.length) return fail('invalid', invalid);
  return run;
}

/** Runs every source of `provider`, each in isolation. */
export async function runProvider(provider: Platform, deps: UpdateDeps): Promise<ProviderRun> {
  const sources = deps.sources.sources.filter((s) => s.provider === provider);
  const settled = await Promise.allSettled(sources.map((s) => runSource(s, deps)));
  return {
    provider,
    sources: settled.map((result, i) =>
      result.status === 'fulfilled'
        ? result.value
        : {
            source: sources[i] as Source,
            previous: null,
            changed: null,
            merge: null,
            failure: { kind: 'fetch', details: [message(result.reason)] },
          },
    ),
  };
}

/** The sources whose snapshot and registry changes may be written. */
export function applicable(run: ProviderRun): SourceRun[] {
  return run.sources.filter((s) => s.failure === null);
}

/** Best-effort rows (DeepSeek) whose model isn't in the registry yet. */
export function unreviewed(run: ProviderRun): SourceRun[] {
  return run.sources.filter((s) => s.merge?.unreviewed.length);
}
