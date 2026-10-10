// The PR delta: finds the base revision, fetches it when the checkout is shallow, scans
// the base copies of the changed files with the same settings and registry, and keeps the head
// findings that aren't in the base.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  type Git,
  type PullRequestEvent,
  pullRequestBase,
  revisionFiles,
} from '../adapters/git.ts';
import { computeDelta, type LineText, type PrDelta } from '../core/delta.ts';
import { scan } from '../core/pipeline.ts';
import type { Logger } from '../core/ports.ts';
import type { ScanResult } from '../core/types.ts';
import { plural } from '../report/common.ts';
import type { ScanRun } from './scan.ts';

export interface DeltaRequest {
  run: ScanRun;
  git: Git;
  pr: PullRequestEvent;
  /** Used to fetch the base commit when it isn't in the clone. */
  token?: string;
  logger: Logger;
}

export async function pullRequestDelta(req: DeltaRequest): Promise<PrDelta> {
  const { git, logger, run } = req;
  const base = await pullRequestBase(git, req.pr, req.token);
  if (!(await git.hasCommit(base))) {
    logger.debug(`fetching the base commit ${base}`);
    await git.fetchCommit(base, req.token);
  }
  const changed = await git.changedFiles(base, 'HEAD');
  const basePaths = changed
    .filter((c) => c.status !== 'added')
    .map((c) => c.previousPath ?? c.path);

  const baseResult = await scan({
    ...run.options,
    files: revisionFiles(git, base, basePaths),
    now: () => 0,
  });

  const headLines = await linesOf(run.result, new Set(changed.map((c) => c.path)), (path) =>
    readFile(join(run.options.root, path), 'utf8').catch(() => null),
  );
  const baseLines = await linesOf(baseResult, new Set(basePaths), (path) => git.readAt(base, path));
  const delta = computeDelta({
    head: run.result,
    base: baseResult,
    changed,
    headLine: headLines,
    baseLine: baseLines,
  });
  logger.info(
    `pull request: ${plural(changed.length, 'changed file')} against ${base.slice(0, 12)}; ${plural(delta.findings.length, 'new finding')}, ${plural(delta.unresolved.length, 'new unresolved reference')}`,
  );
  return delta;
}

/** Reads the changed files that have a finding, and returns a lookup for their lines. */
async function linesOf(
  result: ScanResult,
  changed: ReadonlySet<string>,
  read: (path: string) => Promise<string | null>,
): Promise<LineText> {
  const paths = new Set(
    [...result.findings, ...result.unresolved]
      .map((i) => i.location.path)
      .filter((p) => changed.has(p)),
  );
  const files = new Map<string, string[]>();
  for (const path of paths) {
    const text = await read(path);
    // Lines end at `\n`, as in the scan's LineIndex, so line numbers agree on both sides.
    if (text !== null) files.set(path, text.split(/\r?\n/));
  }
  return (path, line) => files.get(path)?.[line - 1] ?? '';
}
