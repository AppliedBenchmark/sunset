// The Action: scan, write the SARIF and JSON files, annotate, write the job summary,
// upsert the PR comment with the delta, set the outputs, and fail at `fail-on`. Everything the
// runner provides comes in through ActionIO, so tests can drive it without a runner.
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fixedClock, systemClock } from '../adapters/clock.ts';
import { createGit, type PullRequestEvent } from '../adapters/git.ts';
import { createPrComments } from '../adapters/github-rest.ts';
import { createHttpClient } from '../adapters/http.ts';
import type { BundledData } from '../adapters/registry-source.ts';
import { pullRequestDelta } from '../app/pr-delta.ts';
import { rebaseDelta, rebaseItem, rebaseResult, repositoryPrefix } from '../app/rebase.ts';
import { reportContext, runScan } from '../app/scan.ts';
import {
  atOrAbove,
  ConfigError,
  type Overrides,
  parseFailOn,
  parseFailScope,
  parsePlatforms,
  parseRegistryMode,
} from '../core/config.ts';
import type { PrDelta } from '../core/delta.ts';
import { readLimit } from '../core/pipeline.ts';
import type { Logger, PrCommentPort } from '../core/ports.ts';
import type { Location, ScanResult } from '../core/types.ts';
import { type Annotation, annotations } from '../report/annotations.ts';
import { countFindings, plural, type ReportContext } from '../report/common.ts';
import { jsonReportText } from '../report/json.ts';
import { type ExistingFindings, PR_COMMENT_MARKER, prCommentBody } from '../report/pr-comment.ts';
import { sarifReportText } from '../report/sarif.ts';
import { summaryMarkdown } from '../report/summary-md.ts';

export interface ActionIO {
  /** An input's value, trimmed; '' when unset. */
  input(name: string): string;
  env: Readonly<Record<string, string | undefined>>;
  logger: Logger;
  notice(message: string): void;
  annotate(annotation: Annotation): void;
  setOutput(name: string, value: string | number): void;
  setFailed(message: string): void;
  writeSummary(markdown: string): Promise<void>;
  bundled: BundledData;
  fetch?: typeof fetch;
  /** Overrides how the PR comment is posted (tests). */
  prComments?: (pr: PullRequestEvent) => PrCommentPort;
  /** Overrides the remote registry URL (tests). */
  remoteUrl?: string;
}

function booleanInput(io: ActionIO, name: string, fallback: boolean): boolean {
  const value = io.input(name).toLowerCase();
  if (value === '') return fallback;
  if (['true', 'yes', 'on', '1'].includes(value)) return true;
  if (['false', 'no', 'off', '0'].includes(value)) return false;
  throw new ConfigError(`input ${name}: expected true or false, got "${io.input(name)}"`);
}

/** Runs the Action. Never throws: every failure ends in `setFailed`. */
export async function runAction(io: ActionIO): Promise<void> {
  try {
    await run(io);
  } catch (error) {
    if (error instanceof ConfigError) {
      io.setFailed(error.message);
      return;
    }
    io.logger.debug(error instanceof Error ? (error.stack ?? error.message) : String(error));
    io.setFailed(`Sunset failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function run(io: ActionIO): Promise<void> {
  const { env, logger } = io;
  const workspace = env.GITHUB_WORKSPACE ?? process.cwd();
  const inWorkspace = (path: string) => (isAbsolute(path) ? path : resolve(workspace, path));
  const root = inWorkspace(io.input('path') || '.');
  if (!(await stat(root).catch(() => null))?.isDirectory()) {
    throw new ConfigError(`input path: "${io.input('path') || '.'}" is not a directory`);
  }

  const overrides: Overrides = {};
  const registry = io.input('registry');
  if (registry) {
    const mode = parseRegistryMode(registry);
    overrides.registry =
      mode.kind === 'file' ? { kind: 'file', path: inWorkspace(mode.path) } : mode;
  }
  if (io.input('fail-on')) overrides.failOn = parseFailOn(io.input('fail-on'));
  if (io.input('fail-scope')) overrides.failScope = parseFailScope(io.input('fail-scope'));
  if (io.input('platforms')) overrides.platforms = parsePlatforms(io.input('platforms'));
  const wantAnnotations = booleanInput(io, 'annotations', true);
  const wantSummary = booleanInput(io, 'summary', true);
  const wantComment = booleanInput(io, 'pr-comment', true);
  // For tests and the fixture self-test only.
  const clock = env.SUNSET_TODAY ? fixedClock(env.SUNSET_TODAY) : systemClock;

  const outputs = ['sarif-file', 'json-file'].flatMap((name) =>
    io.input(name) ? [inWorkspace(io.input(name))] : [],
  );
  const scanRun = await runScan({
    root,
    configPath: io.input('config') ? inWorkspace(io.input('config')) : null,
    outputs,
    overrides,
    bundled: io.bundled,
    http: () => createHttpClient(io.fetch),
    clock,
    logger,
    ...(io.remoteUrl && { remoteUrl: io.remoteUrl }),
  });

  // Reports use paths from the repository root, which is where annotations and SARIF expect them.
  const git = createGit(root, {
    // The scan reads a notebook past max-file-size (the cap applies to its code cells), so the
    // base revision's copy has to be read the same way.
    maxFileSize: readLimit(scanRun.settings.maxFileSize),
    ...(env.GITHUB_SERVER_URL && { serverUrl: env.GITHUB_SERVER_URL }),
  });
  // Outside a work tree, the workspace stands in for the repository's root.
  const prefix = await repositoryPrefix(git, root, workspace);
  const result = rebaseResult(scanRun.result, prefix);
  const pr = await pullRequest(env);
  // Links point at the commit that was scanned: on a pull request, GitHub's merge commit, where a
  // file the base branch added exists and line numbers match the report.
  const commit = (await git.revParse('HEAD').catch(() => null)) ?? env.GITHUB_SHA;
  const fileUrl =
    env.GITHUB_SERVER_URL && env.GITHUB_REPOSITORY && commit
      ? (l: Location) =>
          `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/blob/${commit}/${l.path.split('/').map(urlSegment).join('/')}#L${l.line}`
      : undefined;
  const ctx = reportContext(scanRun, fileUrl);

  const sarifFile = io.input('sarif-file');
  if (sarifFile) await write(inWorkspace(sarifFile), sarifReportText(result, ctx));
  const jsonFile = io.input('json-file');
  if (jsonFile) await write(inWorkspace(jsonFile), jsonReportText(result, ctx));

  if (wantAnnotations) for (const a of annotations(result)) io.annotate(a);
  if (wantSummary) await io.writeSummary(summaryMarkdown(result, ctx));

  const { failOn, failScope } = scanRun.settings;
  let delta: PrDelta | null = null;
  // The findings the pull request adds, as the scan returned them. Rebasing copies findings, so
  // the comment's "existing" list below is worked out from these, before rebasing.
  let added: ReadonlySet<unknown> = new Set();
  if (pr && (wantComment || failScope === 'new')) {
    try {
      const raw = await pullRequestDelta({
        run: scanRun,
        git,
        pr,
        ...(io.input('github-token') && { token: io.input('github-token') }),
        logger,
      });
      added = new Set(raw.findings);
      delta = rebaseDelta(raw, prefix);
    } catch (error) {
      logger.warn(
        `Couldn't work out what the pull request changed, so there is no PR comment${failScope === 'new' ? ' and every finding counts for fail-on' : ''}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  // fail-scope: new counts only what the pull request adds, when that is known. Everywhere else
  // (pushes, or a delta that couldn't be computed) every finding counts.
  const failing = atOrAbove(result.findings, failOn);
  const newOnly = failScope === 'new' && delta !== null;
  const blockers = newOnly && delta ? atOrAbove(delta.findings, failOn) : failing;

  if (wantComment && pr && delta) {
    const existing =
      failOn === 'never'
        ? []
        : atOrAbove(scanRun.result.findings, failOn)
            .filter((f) => !added.has(f))
            .map((f) => rebaseItem(f, prefix));
    await comment(io, pr, delta, result, ctx, {
      findings: existing,
      failOn: failOn === 'never' ? 'error' : failOn,
      blocking: !newOnly,
    });
  }

  const counts = countFindings(result.findings);
  io.setOutput('errors', counts.error);
  io.setOutput('warnings', counts.warning);
  io.setOutput('notices', counts.notice);
  io.setOutput('sarif-file', sarifFile ? inWorkspace(sarifFile) : '');
  io.setOutput('json-file', jsonFile ? inWorkspace(jsonFile) : '');
  io.setOutput('registry-origin', scanRun.registry.origin);
  io.setOutput('registry-version', scanRun.registry.version ?? '');

  if (blockers.length > 0) {
    const n = blockers.length;
    const which = newOnly ? ' that this pull request adds' : '';
    io.setFailed(
      `Sunset found ${plural(n, 'finding')}${which} at or above fail-on (${failOn}). See the job summary.`,
    );
  }
}

async function comment(
  io: ActionIO,
  pr: PullRequestEvent,
  delta: PrDelta,
  result: ScanResult,
  ctx: ReportContext,
  existing: ExistingFindings,
): Promise<void> {
  const { env, logger } = io;
  const token = io.input('github-token');
  const port =
    io.prComments?.(pr) ??
    (token && env.GITHUB_REPOSITORY
      ? createPrComments({
          apiUrl: env.GITHUB_API_URL ?? 'https://api.github.com',
          ...(env.GITHUB_GRAPHQL_URL && { graphqlUrl: env.GITHUB_GRAPHQL_URL }),
          repository: env.GITHUB_REPOSITORY,
          issueNumber: pr.number,
          token,
          ...(io.fetch && { fetch: io.fetch }),
        })
      : null);
  if (!port) {
    logger.warn('No github-token, so there is no PR comment.');
    return;
  }
  const summaryUrl =
    env.GITHUB_SERVER_URL && env.GITHUB_REPOSITORY && env.GITHUB_RUN_ID
      ? `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}${env.GITHUB_RUN_ATTEMPT ? `/attempts/${env.GITHUB_RUN_ATTEMPT}` : ''}`
      : undefined;
  const body = prCommentBody(delta, result, ctx, {
    existing,
    ...(summaryUrl && { summaryUrl }),
  });
  // A comment appears when there is something new, or when the check fails because of old findings.
  const create =
    delta.findings.length > 0 ||
    delta.unresolved.length > 0 ||
    (existing.blocking && existing.findings.length > 0);
  try {
    const outcome = await port.upsert(PR_COMMENT_MARKER, body, { create });
    if (outcome === 'forbidden') {
      // Pull requests from forks get a read-only token; the summary still has everything.
      io.notice(
        "Sunset couldn't comment on this pull request because the token can't write to it: pull requests from forks get a read-only token, and other pull requests need `pull-requests: write`. The job summary has the results.",
      );
    } else {
      logger.info(`PR comment: ${outcome}`);
    }
  } catch (error) {
    logger.warn(
      `Couldn't post the PR comment: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** The pull request from the event payload, or null for other events. */
async function pullRequest(
  env: Readonly<Record<string, string | undefined>>,
): Promise<PullRequestEvent | null> {
  if (!env.GITHUB_EVENT_PATH) return null;
  const event = JSON.parse(await readFile(env.GITHUB_EVENT_PATH, 'utf8').catch(() => '{}')) as {
    pull_request?: PullRequestEvent;
  };
  const pr = event.pull_request;
  if (!pr || typeof pr.number !== 'number' || !pr.base?.sha || !pr.head?.sha) return null;
  return { number: pr.number, base: { sha: pr.base.sha }, head: { sha: pr.head.sha } };
}

/** A path segment for a URL that also works as a Markdown link target: `(` and `)` are encoded too. */
const urlSegment = (segment: string): string =>
  encodeURIComponent(segment).replace(
    /[()]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );

async function write(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
}
