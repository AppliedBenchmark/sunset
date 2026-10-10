// The Action driven through ActionIO, against real git repositories: a pull request
// checked out as GitHub does it (a merge commit, fetched with depth 1), the PR delta comment, the
// fork fallback, outputs, files, annotations, the summary and fail-on.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { type ActionIO, runAction } from '../src/action/run.ts';
import { createGit, fetchAuthEnv, parseNameStatus } from '../src/adapters/git.ts';
import { repositoryPrefix } from '../src/app/rebase.ts';
import type { PrCommentPort } from '../src/core/ports.ts';
import type { Annotation } from '../src/report/annotations.ts';
import { PR_COMMENT_MARKER } from '../src/report/pr-comment.ts';
import { bundledFixture, FIXTURE_TODAY, root } from './helpers.ts';

const FIXTURE_REGISTRY = join(root, 'test/fixtures/registry/models.yaml');
const temp: string[] = [];
afterAll(() => {
  for (const dir of temp) rmSync(dir, { recursive: true, force: true });
});

const emptyConfig = join(mkdtempSync(join(tmpdir(), 'sunset-gitconfig-')), 'config');
temp.push(join(emptyConfig, '..'));
writeFileSync(emptyConfig, '');

const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: emptyConfig,
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
};

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8' }).trim();
}

function write(dir: string, files: Record<string, string>): void {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(dir, path, '..'), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
}

function tempDir(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), `sunset-${name}-`));
  temp.push(dir);
  return dir;
}

interface Repo {
  /** A depth-1 clone of the merge commit, like actions/checkout makes for pull_request. */
  work: string;
  base1: string;
  base2: string;
  head: string;
  eventPath: string;
}

/**
 * main:    B1 ── B2 (adds main-only.py) ── M (GitHub's merge commit)
 *            └── H (the pull request) ─────┘
 */
function pullRequestRepo(): Repo {
  const origin = tempDir('origin');
  git(origin, 'init', '-q', '-b', 'main');
  git(origin, 'config', 'uploadpack.allowReachableSHA1InWant', 'true');
  write(origin, {
    'app/a.py': 'A = "gpt-fixture-retired"\n\nB = "gpt-fixture-3"\n',
    'app/old.py': 'OLD = "gpt-fixture-retired"\n',
    'app/same.py': 'S = "gpt-fixture-retired"\n',
    'README.md': 'Mentions gpt-fixture-retired.\n',
  });
  git(origin, 'add', '.');
  git(origin, 'commit', '-q', '-m', 'B1');
  const base1 = git(origin, 'rev-parse', 'HEAD');

  git(origin, 'checkout', '-q', '-b', 'feature');
  write(origin, {
    // Moved lines, plus one new finding.
    'app/a.py':
      '# moved\nB = "gpt-fixture-3"\n\nA = "gpt-fixture-retired"\nC = "gpt-fixture-2-2099-02-15"\n',
    'app/added.py': 'model = os.environ["MODEL"]\nN = "claude-fixture-opus-9"\n',
  });
  git(origin, 'mv', 'app/old.py', 'app/new.py');
  git(origin, 'add', '.');
  git(origin, 'commit', '-q', '-m', 'H');
  const head = git(origin, 'rev-parse', 'HEAD');

  git(origin, 'checkout', '-q', 'main');
  write(origin, { 'app/main-only.py': 'X = "gpt-fixture-retired"\n' });
  git(origin, 'add', '.');
  git(origin, 'commit', '-q', '-m', 'B2');
  const base2 = git(origin, 'rev-parse', 'HEAD');
  git(origin, 'checkout', '-q', '-b', 'pull/1/merge');
  git(origin, 'merge', '-q', '--no-ff', '--no-edit', 'feature');

  const work = join(tempDir('work'), 'repo');
  git(
    tmpdir(),
    'clone',
    '-q',
    '--depth=1',
    '--branch',
    'pull/1/merge',
    pathToFileURL(origin).href,
    work,
  );
  const eventPath = join(tempDir('event'), 'event.json');
  // base.sha is stale on purpose: the merge commit's first parent must win.
  writeFileSync(
    eventPath,
    JSON.stringify({ pull_request: { number: 1, base: { sha: base1 }, head: { sha: head } } }),
  );
  return { work, base1, base2, head, eventPath };
}

interface Recorded {
  failed: string[];
  notices: string[];
  warnings: string[];
  annotations: Annotation[];
  outputs: Record<string, string | number>;
  summary: string[];
  comments: { body: string; create: boolean }[];
}

function harness(
  inputs: Record<string, string>,
  env: Record<string, string>,
  opts: { port?: PrCommentPort | 'real'; fetch?: typeof fetch } = {},
): { io: ActionIO; rec: Recorded } {
  const rec: Recorded = {
    failed: [],
    notices: [],
    warnings: [],
    annotations: [],
    outputs: {},
    summary: [],
    comments: [],
  };
  const port: PrCommentPort = {
    upsert: async (marker, body, o) => {
      expect(body.startsWith(marker)).toBe(true);
      rec.comments.push({ body, create: o.create });
      return o.create ? 'created' : 'skipped';
    },
  };
  const io: ActionIO = {
    input: (name) => inputs[name] ?? '',
    env: { SUNSET_TODAY: FIXTURE_TODAY, ...env },
    logger: { info: () => {}, debug: () => {}, warn: (m) => rec.warnings.push(m) },
    notice: (m) => rec.notices.push(m),
    annotate: (a) => rec.annotations.push(a),
    setOutput: (name, value) => {
      rec.outputs[name] = value;
    },
    setFailed: (m) => rec.failed.push(m),
    writeSummary: async (md) => {
      rec.summary.push(md);
    },
    bundled: bundledFixture,
    ...(opts.fetch && { fetch: opts.fetch }),
    ...(opts.port !== 'real' && {
      prComments: () => (opts.port as PrCommentPort | undefined) ?? port,
    }),
  };
  return { io, rec };
}

describe('pull request delta, end to end', () => {
  let repo: Repo;
  beforeAll(() => {
    repo = pullRequestRepo();
  }, 30_000);

  it('finds the base from the merge commit and fetches it into the shallow clone', async () => {
    const g = createGit(repo.work, { maxFileSize: 1 << 20 });
    expect(await g.parents('HEAD')).toEqual([repo.base2, repo.head]);
    expect(await g.hasCommit(repo.base2)).toBe(false);
    await g.fetchCommit(repo.base2);
    expect(await g.hasCommit(repo.base2)).toBe(true);
    expect(await g.changedFiles(repo.base2, 'HEAD')).toEqual([
      { path: 'app/a.py', previousPath: null, status: 'modified' },
      { path: 'app/added.py', previousPath: null, status: 'added' },
      { path: 'app/new.py', previousPath: 'app/old.py', status: 'renamed' },
    ]);
  });

  it('comments with only the findings the pull request adds', async () => {
    const { io, rec } = harness(
      {
        registry: FIXTURE_REGISTRY,
        'fail-on': 'never',
        'pr-comment': 'true',
        'sarif-file': 'out/sunset.sarif',
        'json-file': 'out/sunset.json',
      },
      {
        GITHUB_WORKSPACE: repo.work,
        GITHUB_EVENT_PATH: repo.eventPath,
        GITHUB_SERVER_URL: 'https://github.test',
        GITHUB_REPOSITORY: 'octo/repo',
        GITHUB_RUN_ID: '42',
      },
    );
    await runAction(io);
    expect(rec.failed).toEqual([]);
    expect(rec.warnings).toEqual([]);
    expect(rec.comments).toHaveLength(1);
    const { body, create } = rec.comments[0] as { body: string; create: boolean };
    expect(create).toBe(true);
    expect(body).toMatch(new RegExp(`^${PR_COMMENT_MARKER}\n### Sunset: 2 new findings`));
    // New: the added line in a.py and the model in the added file; and the unresolved reference.
    expect(body).toContain('app/a.py:5');
    expect(body).toContain('app/added.py:2');
    expect(body).toContain('1 new unresolved reference');
    // Not new: moved lines, the renamed file, the file only main changed, untouched files, docs.
    for (const path of [
      'app/a.py:4',
      'app/a.py:2',
      'app/new.py',
      'main-only',
      'same.py',
      'README',
    ]) {
      expect(body).not.toContain(path);
    }
    // Links point at the commit that was scanned: the merge commit, not the pull request's head.
    const merge = git(repo.work, 'rev-parse', 'HEAD');
    expect(body).toContain(`https://github.test/octo/repo/blob/${merge}/app/added.py#L2`);
    expect(body).toContain('(https://github.test/octo/repo/actions/runs/42)');

    // The rest of the run covers every file, not just the delta.
    expect(rec.outputs).toMatchObject({
      errors: 4,
      warnings: 2,
      notices: 1,
      'registry-origin': 'file',
      'registry-version': 1,
      'sarif-file': join(repo.work, 'out/sunset.sarif'),
      'json-file': join(repo.work, 'out/sunset.json'),
    });
    const json = JSON.parse(readFileSync(join(repo.work, 'out/sunset.json'), 'utf8'));
    expect(json.findings).toHaveLength(7);
    const sarif = JSON.parse(readFileSync(join(repo.work, 'out/sunset.sarif'), 'utf8'));
    // Later tests scan the same work tree; the reports would be scanned too.
    rmSync(join(repo.work, 'out'), { recursive: true });
    // Seven findings and the unresolved reference.
    expect(sarif.runs[0].results).toHaveLength(8);
    expect(rec.annotations.map((a) => `${a.level} ${a.file}:${a.startLine}`)).toContain(
      'error app/main-only.py:1',
    );
    expect(rec.summary).toHaveLength(1);
    expect(rec.summary[0]).toContain('## Sunset');
  });

  describe('fail-scope', () => {
    const run = async (inputs: Record<string, string>) => {
      const { io, rec } = harness(
        { registry: FIXTURE_REGISTRY, ...inputs },
        { GITHUB_WORKSPACE: repo.work, GITHUB_EVENT_PATH: repo.eventPath },
      );
      await runAction(io);
      return rec;
    };

    // The pull request adds two warnings; the four errors were in the code before it.
    it('all (default): fails on the old errors and says so in the comment', async () => {
      const rec = await run({});
      expect(rec.failed).toEqual([
        'Sunset found 4 findings at or above fail-on (error). See the job summary.',
      ]);
      const body = rec.comments[0]?.body ?? '';
      expect(rec.comments[0]?.create).toBe(true);
      expect(body).toContain('### Sunset: 2 new findings, but 4 existing findings fail this check');
      expect(body).toContain(
        '#### Why this check fails: 4 existing findings at or above `fail-on: error`',
      );
      expect(body).toContain('app/main-only.py:1');
    });

    it('new: passes when the pull request adds no errors, and lists the old ones collapsed', async () => {
      const rec = await run({ 'fail-scope': 'new' });
      expect(rec.failed).toEqual([]);
      const body = rec.comments[0]?.body ?? '';
      expect(body).toContain('### Sunset: 2 new findings\n');
      expect(body).toContain(
        "<summary>4 existing findings at or above `fail-on: error`, which don't fail this check (fail-scope: new)</summary>",
      );
    });

    it('new: fails on what the pull request adds', async () => {
      const rec = await run({ 'fail-scope': 'new', 'fail-on': 'warning' });
      expect(rec.failed).toEqual([
        'Sunset found 2 findings that this pull request adds at or above fail-on (warning). See the job summary.',
      ]);
    });

    it('tells new findings from existing ones when path is a subdirectory', async () => {
      const rec = await run({ path: 'app', 'fail-on': 'warning' });
      const body = rec.comments[0]?.body ?? '';
      expect(body).toContain('### Sunset: 2 new findings, but 4 existing findings fail this check');
      expect(body).toContain('app/added.py:2');
    });

    it('new: works without the PR comment too', async () => {
      const rec = await run({ 'fail-scope': 'new', 'pr-comment': 'false' });
      expect(rec.failed).toEqual([]);
      expect(rec.comments).toEqual([]);
    });

    it("new: counts every finding when the delta can't be computed", async () => {
      const event = join(tempDir('event'), 'event.json');
      writeFileSync(
        event,
        JSON.stringify({
          pull_request: { number: 1, base: { sha: '0'.repeat(40) }, head: { sha: '1'.repeat(40) } },
        }),
      );
      const { io, rec } = harness(
        { registry: FIXTURE_REGISTRY, 'fail-scope': 'new' },
        { GITHUB_WORKSPACE: repo.work, GITHUB_EVENT_PATH: event },
      );
      await runAction(io);
      expect(rec.warnings).toEqual([
        expect.stringContaining('and every finding counts for fail-on'),
      ]);
      expect(rec.failed).toEqual([expect.stringContaining('Sunset found 4 findings at or above')]);
    });

    it('rejects an unknown value', async () => {
      const rec = await run({ 'fail-scope': 'some' });
      expect(rec.failed).toEqual([expect.stringContaining('fail-scope: must be one of all, new')]);
    });
  });

  it('updates an existing comment when nothing new is left, but never creates one', async () => {
    // Head and base are the same commit: nothing is new.
    const event = join(tempDir('event'), 'event.json');
    const sha = git(repo.work, 'rev-parse', 'HEAD');
    writeFileSync(
      event,
      JSON.stringify({ pull_request: { number: 1, base: { sha }, head: { sha: 'f'.repeat(40) } } }),
    );
    const { io, rec } = harness(
      { registry: FIXTURE_REGISTRY, 'fail-on': 'never' },
      { GITHUB_WORKSPACE: repo.work, GITHUB_EVENT_PATH: event },
    );
    await runAction(io);
    expect(rec.comments.map((c) => c.create)).toEqual([false]);
    expect(rec.comments[0]?.body).toContain('no new findings');
  });

  it('degrades on a fork pull request: a notice, the summary, and no failure', async () => {
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      if ((init?.method ?? 'GET') === 'GET') return Response.json([]);
      expect(String(input)).toBe('https://api.github.test/repos/fork/repo/issues/1/comments');
      return new Response(JSON.stringify({ message: 'Resource not accessible by integration' }), {
        status: 403,
      });
    }) as unknown as typeof globalThis.fetch;
    const { io, rec } = harness(
      { registry: FIXTURE_REGISTRY, 'github-token': 'read-only', 'fail-on': 'never' },
      {
        GITHUB_WORKSPACE: repo.work,
        GITHUB_EVENT_PATH: repo.eventPath,
        GITHUB_REPOSITORY: 'fork/repo',
        GITHUB_API_URL: 'https://api.github.test',
      },
      { port: 'real', fetch },
    );
    await runAction(io);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(rec.notices).toEqual([expect.stringContaining("the token can't write to it")]);
    expect(rec.failed).toEqual([]);
    expect(rec.summary).toHaveLength(1);
  });

  it("warns, and skips the comment, when the base can't be found", async () => {
    const event = join(tempDir('event'), 'event.json');
    writeFileSync(
      event,
      JSON.stringify({
        pull_request: { number: 1, base: { sha: '0'.repeat(40) }, head: { sha: '1'.repeat(40) } },
      }),
    );
    const { io, rec } = harness(
      { registry: FIXTURE_REGISTRY, 'fail-on': 'never' },
      { GITHUB_WORKSPACE: repo.work, GITHUB_EVENT_PATH: event },
    );
    await runAction(io);
    expect(rec.warnings).toEqual([
      expect.stringContaining("Couldn't work out what the pull request changed"),
    ]);
    expect(rec.comments).toEqual([]);
    expect(rec.failed).toEqual([]);
  });
});

describe('pull request delta from a checkout of the head', () => {
  /**
   * main:    B1 ── B2 (edits legacy.py)
   *            └── H (the pull request: adds feature.py)
   * The workflow checks out H, not GitHub's merge commit.
   */
  function headCheckout(depth: number | null): { work: string; eventPath: string } {
    const origin = tempDir('origin');
    git(origin, 'init', '-q', '-b', 'main');
    git(origin, 'config', 'uploadpack.allowReachableSHA1InWant', 'true');
    write(origin, { 'legacy.py': 'L = "gpt-fixture-retired"\n' });
    git(origin, 'add', '.');
    git(origin, 'commit', '-q', '-m', 'B1');
    git(origin, 'checkout', '-q', '-b', 'feature');
    write(origin, { 'we(ird).py': 'F = "gpt-fixture-retired"\n' });
    git(origin, 'add', '.');
    git(origin, 'commit', '-q', '-m', 'H');
    const head = git(origin, 'rev-parse', 'HEAD');
    git(origin, 'checkout', '-q', 'main');
    write(origin, { 'legacy.py': '# migrated\nL = "gpt-fixture-4o"\n' });
    git(origin, 'commit', '-q', '-am', 'B2');
    const base = git(origin, 'rev-parse', 'HEAD');
    const work = join(tempDir('work'), 'repo');
    const shallow = depth === null ? [] : [`--depth=${depth}`];
    git(
      tmpdir(),
      'clone',
      '-q',
      ...shallow,
      '--branch',
      'feature',
      pathToFileURL(origin).href,
      work,
    );
    const eventPath = join(tempDir('event'), 'event.json');
    writeFileSync(
      eventPath,
      JSON.stringify({ pull_request: { number: 2, base: { sha: base }, head: { sha: head } } }),
    );
    return { work, eventPath };
  }

  it('compares against where the pull request branched off, not the current base', async () => {
    const { work, eventPath } = headCheckout(null);
    const { io, rec } = harness(
      { registry: FIXTURE_REGISTRY, 'fail-on': 'never' },
      {
        GITHUB_WORKSPACE: work,
        GITHUB_EVENT_PATH: eventPath,
        GITHUB_SERVER_URL: 'https://github.test',
        GITHUB_REPOSITORY: 'octo/repo',
      },
    );
    await runAction(io);
    const body = rec.comments[0]?.body ?? '';
    // Only the file the pull request added; legacy.py changed on main, not in the pull request.
    expect(body).toMatch(/### Sunset: 1 new finding/);
    expect(body).toContain('we(ird).py:1');
    expect(body).not.toContain('legacy.py');
    // `(` and `)` are encoded, so the Markdown link doesn't end early.
    expect(body).toContain('/we%28ird%29.py#L1');
  });

  it("says it can't tell what changed when a shallow clone doesn't reach the fork point", async () => {
    const { work, eventPath } = headCheckout(1);
    const { io, rec } = harness(
      { registry: FIXTURE_REGISTRY, 'fail-on': 'never' },
      { GITHUB_WORKSPACE: work, GITHUB_EVENT_PATH: eventPath },
    );
    await runAction(io);
    expect(rec.warnings).toEqual([expect.stringContaining('fetch-depth: 0')]);
    expect(rec.comments).toEqual([]);
  });
});

describe('pull request delta with a large notebook', () => {
  /**
   * A notebook whose code is small but whose outputs push the file past `max-file-size`, indented
   * as Jupyter writes it.
   */
  const notebook = (extraCell: string) =>
    JSON.stringify(
      {
        cells: [
          {
            cell_type: 'code',
            metadata: {},
            source: ['MODEL = "gpt-fixture-retired"\n'],
            outputs: [{ output_type: 'stream', name: 'stdout', text: ['x'.repeat(8192)] }],
            execution_count: 1,
          },
          ...(extraCell ? [{ cell_type: 'markdown', metadata: {}, source: [extraCell] }] : []),
        ],
        metadata: { kernelspec: { language: 'python' } },
        nbformat: 4,
        nbformat_minor: 5,
      },
      null,
      1,
    );

  it("reads the base's copy past max-file-size too, so its findings aren't new", async () => {
    const origin = tempDir('origin');
    git(origin, 'init', '-q', '-b', 'main');
    git(origin, 'config', 'uploadpack.allowReachableSHA1InWant', 'true');
    write(origin, { 'nb.ipynb': notebook(''), '.sunset.yml': 'max-file-size: 4096\n' });
    git(origin, 'add', '.');
    git(origin, 'commit', '-q', '-m', 'B1');
    const base = git(origin, 'rev-parse', 'HEAD');
    git(origin, 'checkout', '-q', '-b', 'feature');
    write(origin, { 'nb.ipynb': notebook('A note the pull request adds.') });
    git(origin, 'commit', '-q', '-am', 'H');
    const head = git(origin, 'rev-parse', 'HEAD');
    git(origin, 'checkout', '-q', 'main');
    git(origin, 'checkout', '-q', '-b', 'pull/3/merge');
    git(origin, 'merge', '-q', '--no-ff', '--no-edit', 'feature');
    const work = join(tempDir('work'), 'repo');
    git(
      tmpdir(),
      'clone',
      '-q',
      '--depth=1',
      '--branch',
      'pull/3/merge',
      pathToFileURL(origin).href,
      work,
    );
    const eventPath = join(tempDir('event'), 'event.json');
    writeFileSync(
      eventPath,
      JSON.stringify({ pull_request: { number: 3, base: { sha: base }, head: { sha: head } } }),
    );

    const { io, rec } = harness(
      { registry: FIXTURE_REGISTRY, 'fail-on': 'never' },
      { GITHUB_WORKSPACE: work, GITHUB_EVENT_PATH: eventPath },
    );
    await runAction(io);
    expect(rec.warnings).toEqual([]);
    expect(rec.outputs.errors).toBe(1);
    expect(rec.comments.map((c) => c.body)).toEqual([expect.stringContaining('no new findings')]);
  });
});

describe('fetchAuthEnv', () => {
  it('sends the token to the GitHub server only', () => {
    const env = { ...GIT_ENV, ...fetchAuthEnv('tkn', 'https://github.example/') };
    const header = (url: string) => {
      try {
        return execFileSync('git', ['config', '--get-urlmatch', 'http.extraheader', url], {
          env,
          encoding: 'utf8',
        }).trim();
      } catch {
        return null;
      }
    };
    expect(header('https://github.example/octo/repo')).toMatch(/^AUTHORIZATION: basic /);
    expect(header('https://mirror.example/octo/repo')).toBeNull();
  });
});

describe('runAction', () => {
  let dir: string;
  beforeAll(() => {
    dir = tempDir('action');
    write(dir, {
      'sub/app.py': 'A = "gpt-fixture-retired"\nB = "gpt-fixture-2-2099-02-15"\n',
      'sub/.sunset.yml': 'platforms: [openai]\n',
      'other.py': 'C = "gpt-fixture-retired"\n',
    });
    git(dir, 'init', '-q');
  });

  it('fails at fail-on, with repository-relative paths for a subdirectory', async () => {
    const { io, rec } = harness(
      { path: 'sub', registry: FIXTURE_REGISTRY, 'pr-comment': 'true' },
      { GITHUB_WORKSPACE: dir },
    );
    await runAction(io);
    expect(rec.annotations.map((a) => `${a.level} ${a.file}:${a.startLine}`)).toEqual([
      'error sub/app.py:1',
      'warning sub/app.py:2',
    ]);
    expect(rec.failed).toEqual([
      'Sunset found 1 finding at or above fail-on (error). See the job summary.',
    ]);
    // Not a pull request: no comment.
    expect(rec.comments).toEqual([]);
    expect(rec.outputs['sarif-file']).toBe('');
  });

  it('outside a work tree, gives paths from the workspace', async () => {
    const plain = tempDir('plain');
    write(plain, { 'sub/app.py': 'A = "gpt-fixture-retired"\n' });
    const { io, rec } = harness(
      { path: 'sub', registry: FIXTURE_REGISTRY },
      { GITHUB_WORKSPACE: plain },
    );
    await runAction(io);
    expect(rec.annotations.map((a) => `${a.file}:${a.startLine}`)).toEqual(['sub/app.py:1']);
  });

  it('honours fail-on warning and turns annotations and the summary off', async () => {
    const { io, rec } = harness(
      {
        path: 'sub',
        registry: FIXTURE_REGISTRY,
        'fail-on': 'warning',
        annotations: 'false',
        summary: 'no',
      },
      { GITHUB_WORKSPACE: dir },
    );
    await runAction(io);
    expect(rec.failed).toEqual([
      expect.stringContaining('2 findings at or above fail-on (warning)'),
    ]);
    expect(rec.annotations).toEqual([]);
    expect(rec.summary).toEqual([]);
  });

  it('makes no network calls with registry: bundled', async () => {
    const fetch = vi.fn() as unknown as typeof globalThis.fetch;
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const { io, rec } = harness(
      { path: 'sub', registry: 'bundled', 'fail-on': 'never' },
      { GITHUB_WORKSPACE: dir },
      { fetch },
    );
    await runAction(io);
    expect(rec.outputs['registry-origin']).toBe('bundled');
    expect(fetch).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('reports bad inputs and config as failures', async () => {
    for (const [inputs, message] of [
      [{ 'fail-on': 'sometimes' }, 'fail-on: must be one of'],
      [{ platforms: 'openai,azure' }, 'unknown platform "azure"'],
      [{ annotations: 'maybe' }, 'input annotations: expected true or false'],
      [{ config: 'missing.yml' }, "can't read the config file"],
      [{ registry: 'missing.yaml' }, "registry: can't read"],
      [{ path: 'missing' }, 'input path: "missing" is not a directory'],
      [{ path: 'other.py' }, 'input path: "other.py" is not a directory'],
    ] as const) {
      const { io, rec } = harness({ path: 'sub', ...inputs }, { GITHUB_WORKSPACE: dir });
      await runAction(io);
      expect(rec.failed).toEqual([expect.stringContaining(message)]);
    }
  });

  it('reports internal errors as failures too', async () => {
    const { io, rec } = harness(
      { path: 'sub', registry: 'bundled' },
      { GITHUB_WORKSPACE: dir, SUNSET_TODAY: 'tomorrow' },
    );
    await runAction(io);
    expect(rec.failed).toEqual([expect.stringMatching(/^Sunset failed: not a valid date/)]);
  });

  it('writes nothing to the workspace unless asked', () => {
    expect(existsSync(join(dir, 'sunset.sarif'))).toBe(false);
  });
});

describe('createGit', () => {
  it("reads a revision's text files, and its binary and large ones as null", async () => {
    const repo = tempDir('read-at');
    write(repo, { 'a.py': 'M = "x"\n', 'big.py': 'x'.repeat(2_000) });
    writeFileSync(join(repo, 'image.bin'), Buffer.from([0x89, 0x50, 0x00, 0x47]));
    git(repo, 'init', '-q');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'one');
    const g = createGit(repo, { maxFileSize: 1_000 });
    expect(await g.readAt('HEAD', 'a.py')).toBe('M = "x"\n');
    expect(await g.readAt('HEAD', 'image.bin')).toBeNull();
    expect(await g.readAt('HEAD', 'big.py')).toBeNull();
    expect(await g.readAt('HEAD', 'gone.py')).toBeNull();
  });
});

describe('repositoryPrefix', () => {
  it("asks git for the directory's path, run in that directory", async () => {
    const dir = tempDir('prefix');
    write(dir, { 'sub dir/ünï/a.py': '', 'outside/b.py': '' });
    const repo = join(dir, 'sub dir');
    git(repo, 'init', '-q');
    const prefix = (path: string) => createGit(path, { maxFileSize: 1 }).prefix();
    expect(await prefix(join(repo, 'ünï'))).toBe('ünï/');
    expect(await prefix(repo)).toBe('');
    expect(await prefix(join(dir, 'outside'))).toBeNull();
    if (process.platform !== 'win32') {
      // Only the line break is taken off.
      mkdirSync(join(repo, ' lead '));
      expect(await prefix(join(repo, ' lead '))).toBe(' lead /');
    }
  });

  it("uses git's answer, whatever the directory's path looks like", async () => {
    // On Windows, `--show-toplevel` and the scanned path can differ in case, drive letter or
    // short names, which made the prefix go missing.
    const git = { prefix: async () => 'svc/' };
    expect(await repositoryPrefix(git, 'C:\\Users\\RUNNER~1\\work\\svc')).toBe('svc/');
    expect(await repositoryPrefix(git, '/elsewhere', '/workspace')).toBe('svc/');
  });

  it('outside a work tree, uses the path from the workspace, if any', async () => {
    const dir = tempDir('no-git');
    write(dir, { 'sub/a.py': '' });
    const noGit = { prefix: async () => null };
    expect(await repositoryPrefix(noGit, join(dir, 'sub'), dir)).toBe('sub/');
    expect(await repositoryPrefix(noGit, dir, dir)).toBe('');
    expect(await repositoryPrefix(noGit, dir, join(dir, 'sub'))).toBe('');
    expect(await repositoryPrefix(noGit, join(dir, 'sub'))).toBe('');
  });
});

describe('parseNameStatus', () => {
  it('reads renames, copies and deletions', () => {
    expect(
      parseNameStatus(
        ['M', 'a', 'R087', 'b', 'c', 'C100', 'd', 'e', 'D', 'f', 'T', 'g', 'A', 'h', ''].join('\0'),
      ),
    ).toEqual([
      { path: 'a', previousPath: null, status: 'modified' },
      { path: 'c', previousPath: 'b', status: 'renamed' },
      { path: 'e', previousPath: null, status: 'added' },
      { path: 'g', previousPath: null, status: 'modified' },
      { path: 'h', previousPath: null, status: 'added' },
    ]);
  });
});
