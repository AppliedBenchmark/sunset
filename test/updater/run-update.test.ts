// The updater's command end to end, on a temporary copy of the registry with the frozen OpenAI
// entries: arguments, the files it writes for the PR, and the provider's issue over a fake GitHub.
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { issueMarker } from '../../updater/github.ts';
import { runUpdate } from '../../updater/run-update.ts';

const registryDir = fileURLToPath(new URL('../../registry', import.meta.url));
const frozen = fileURLToPath(new URL('../fixtures/updater', import.meta.url));
const PAGE_URL = 'https://developers.openai.com/api/docs/deprecations.md';
const SNAPSHOT = readFileSync(join(frozen, 'snapshots/openai/deprecations.txt'), 'utf8');
const ROW = '| Apr 1, 2027 | `gpt-5.1` | `gpt-6-sol` |';
const CHANGED = '| May 3, 2027 | `gpt-5.1` | `gpt-6-sol` |';
const NOW = new Date('2026-10-08T05:17:00Z');

interface Issue {
  number: number;
  title: string;
  body: string;
  state: string;
  user: { login: string };
  comments: string[];
}

/** Serves `pages` by URL, and the issue endpoints of the GitHub API for `o/r`. */
function fakeWeb(pages: Record<string, string>) {
  const issues: Issue[] = [];
  const calls: string[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    calls.push(`${method} ${url.origin}${url.pathname}`);
    const page = pages[url.toString()];
    if (page !== undefined) return new Response(page);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (url.pathname === '/graphql') {
      return Response.json({ data: { viewer: { login: 'sunset-updater[bot]' } } });
    }
    const path = url.pathname.replace('/repos/o/r', '');
    if (method === 'GET' && path === '/issues') {
      return Response.json(issues.filter((i) => i.state === 'open'));
    }
    if (method === 'POST' && path === '/issues') {
      issues.push({
        number: issues.length + 1,
        ...body,
        state: 'open',
        user: { login: 'sunset-updater[bot]' },
        comments: [],
      });
      return Response.json({}, { status: 201 });
    }
    const match = /^\/issues\/(\d+)(\/comments)?$/.exec(path);
    const issue = issues.find((i) => i.number === Number(match?.[1]));
    if (issue && method === 'PATCH') {
      Object.assign(issue, body);
      return Response.json({});
    }
    if (issue && method === 'POST' && match?.[2]) {
      issue.comments.push(body.body);
      return Response.json({}, { status: 201 });
    }
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
  return { impl, issues, calls };
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sunset-run-update-'));
  for (const file of ['sources.yaml', 'formats.yaml']) {
    cpSync(join(registryDir, file), join(dir, file));
  }
  cpSync(join(frozen, 'models.yaml'), join(dir, 'models.yaml'));
  cpSync(join(frozen, 'snapshots'), join(dir, 'snapshots'), { recursive: true });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const ENV = {
  GITHUB_TOKEN: 't',
  GITHUB_REPOSITORY: 'o/r',
  GITHUB_SERVER_URL: 'https://github.com',
  GITHUB_RUN_ID: '7',
};

async function update(argv: string[], web: ReturnType<typeof fakeWeb>, env = ENV, now = NOW) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runUpdate({
    argv,
    env,
    registryDir: dir,
    stdout: (line) => out.push(line),
    stderr: (line) => err.push(line),
    fetch: web.impl,
    now: () => now,
  });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

const read = (path: string) => readFileSync(join(dir, path), 'utf8');

describe('runUpdate', () => {
  it('checks the arguments and the environment before fetching or writing anything', async () => {
    const web = fakeWeb({ [PAGE_URL]: SNAPSHOT.replace(ROW, CHANGED) });
    const prDir = join(dir, 'pr');
    const twoProviders = ['--provider', 'openai', '--provider', 'mistral', '--pr-dir', prDir];
    expect(await update(twoProviders, web)).toMatchObject({
      code: 2,
      err: '--pr-dir needs exactly one --provider',
    });
    expect(
      await update(['--provider', 'openai', '--issues'], web, { ...ENV, GITHUB_TOKEN: '' }),
    ).toMatchObject({
      code: 2,
      err: '--issues needs GITHUB_TOKEN',
    });
    expect((await update(['--provider', 'nope'], web)).code).toBe(2);
    expect((await update(['--today', '2026-02-30'], web)).code).toBe(2);
    expect(web.calls).toEqual([]);
    expect(read('models.yaml')).toBe(readFileSync(join(frozen, 'models.yaml'), 'utf8'));
    expect(read('snapshots/openai/deprecations.txt')).toBe(SNAPSHOT);
    expect(existsSync(prDir)).toBe(false);
  });

  it('writes the snapshot, models.yaml and the PR files for a changed page', async () => {
    const web = fakeWeb({ [PAGE_URL]: SNAPSHOT.replace(ROW, CHANGED) });
    const prDir = join(dir, 'pr');
    const result = await update(['--provider', 'openai', '--pr-dir', prDir, '--issues'], web);
    expect(result.code).toBe(0);
    expect(read('snapshots/openai/deprecations.txt')).toBe(SNAPSHOT.replace(ROW, CHANGED));
    expect(read('models.yaml')).toContain(`source_excerpt: '${CHANGED}'`);
    expect(read('models.yaml')).toContain('registry_version: 2');
    expect(readFileSync(join(prDir, 'title.txt'), 'utf8')).toBe(
      'chore(registry): update openai (1 changed)',
    );
    expect(readFileSync(join(prDir, 'body.md'), 'utf8')).toContain(
      '([run](https://github.com/o/r/actions/runs/7))',
    );
    expect(web.issues).toEqual([]);
  });

  it('runs a provider named twice once', async () => {
    const added = '| May 3, 2027 | `gpt-9-test` | `gpt-6-sol` |';
    const web = fakeWeb({ [PAGE_URL]: SNAPSHOT.replace(ROW, `${ROW}\n${added}`) });
    const result = await update(['--provider', 'openai', '--provider', 'openai'], web);
    expect(result.code).toBe(0);
    expect(read('models.yaml').match(/^- id: 'openai:gpt-9-test'$/gm)).toHaveLength(1);
  });

  it('writes the same models.yaml when it runs again on the same day', async () => {
    const web = fakeWeb({ [PAGE_URL]: SNAPSHOT.replace(ROW, CHANGED) });
    expect((await update(['--provider', 'openai'], web)).code).toBe(0);
    const first = read('models.yaml');
    cpSync(join(frozen, 'models.yaml'), join(dir, 'models.yaml'));
    cpSync(join(frozen, 'snapshots'), join(dir, 'snapshots'), { recursive: true });
    const later = new Date('2026-10-08T21:03:00Z');
    expect((await update(['--provider', 'openai'], web, ENV, later)).code).toBe(0);
    expect(read('models.yaml')).toBe(first);
    expect(first).toContain("generated_at: '2026-10-08T00:00:00Z'");
  });

  it('files the issue, updates it, and closes it once every source succeeds', async () => {
    const web = fakeWeb({
      [PAGE_URL]: SNAPSHOT.replace(ROW, ROW.replace('Apr 1, 2027', 'Q2 2027')),
    });
    expect((await update(['--provider', 'openai', '--issues'], web)).code).toBe(0);
    expect(web.issues).toHaveLength(1);
    expect(web.issues[0]).toMatchObject({
      title: 'Registry updater: openai (parse failure)',
      state: 'open',
    });
    expect(web.issues[0]?.body.startsWith(issueMarker('provider:openai'))).toBe(true);
    expect((await update(['--provider', 'openai', '--issues'], web)).out).toContain(
      'issue for openai: unchanged',
    );
    // A failed source leaves its snapshot alone.
    expect(read('snapshots/openai/deprecations.txt')).toBe(SNAPSHOT);

    const fixed = fakeWeb({ [PAGE_URL]: SNAPSHOT });
    fixed.issues.push(...web.issues);
    expect((await update(['--provider', 'openai', '--issues'], fixed)).out).toContain(
      'issue for openai: closed',
    );
    expect(fixed.issues[0]).toMatchObject({ state: 'closed' });
    expect(fixed.issues[0]?.comments).toEqual([
      'Fixed: every openai source succeeded on 2026-10-08 ([run](https://github.com/o/r/actions/runs/7)).',
    ]);
  });

  it('files an issue, instead of failing, for a row the validator would reject', async () => {
    const tba = '| To be announced | `gpt-9-test` | `gpt-6-sol` |';
    const web = fakeWeb({ [PAGE_URL]: SNAPSHOT.replace(ROW, `${ROW}\n${tba}`) });
    const result = await update(['--provider', 'openai', '--issues'], web);
    expect(result.code).toBe(0);
    expect(web.issues[0]?.title).toBe('Registry updater: openai (entries that would not validate)');
    expect(web.issues[0]?.body).toContain(
      '```text\n`openai:gpt-9-test`: a deprecated entry needs a date; without one it must be unverified\n```',
    );
    expect(read('snapshots/openai/deprecations.txt')).toBe(SNAPSHOT);
  });

  it('writes nothing and reports in the issue when the registry as a whole fails validation', async () => {
    // A committed snapshot that no longer has its source's page_qualifier, as CI would catch it.
    const gemini = readFileSync(join(registryDir, 'snapshots/gemini-api/deprecations.txt'), 'utf8');
    mkdirSync(join(dir, 'snapshots/gemini-api'));
    writeFileSync(
      join(dir, 'snapshots/gemini-api/deprecations.txt'),
      gemini.replace('*earliest possible\n> dates*', '*planned\n> dates*'),
    );
    const web = fakeWeb({ [PAGE_URL]: SNAPSHOT.replace(ROW, CHANGED) });
    const prDir = join(dir, 'pr');
    const result = await update(['--provider', 'openai', '--pr-dir', prDir, '--issues'], web);
    expect(result.code).toBe(1);
    expect(result.err).toContain(
      'sources.yaml gemini-api/deprecations: page_qualifier.excerpt is not in the snapshot',
    );
    expect(read('models.yaml')).toBe(readFileSync(join(frozen, 'models.yaml'), 'utf8'));
    expect(read('snapshots/openai/deprecations.txt')).toBe(SNAPSHOT);
    expect(existsSync(prDir)).toBe(false);
    expect(web.issues[0]?.title).toBe(
      "Registry updater: openai (the updated registry doesn't validate)",
    );
    expect(web.issues[0]?.body).toContain(
      '```text\nsources.yaml gemini-api/deprecations: page_qualifier.excerpt is not in the snapshot\n```',
    );
  });

  it('writes nothing and files nothing in a dry run', async () => {
    const web = fakeWeb({ [PAGE_URL]: SNAPSHOT.replace(ROW, CHANGED) });
    const result = await update(['--provider', 'openai', '--dry-run', '--issues'], web);
    expect(result.code).toBe(0);
    expect(result.out).toContain('openai/deprecations: page changed; 1 updated');
    expect(read('models.yaml')).toBe(readFileSync(join(frozen, 'models.yaml'), 'utf8'));
    expect(read('snapshots/openai/deprecations.txt')).toBe(SNAPSHOT);
    expect(web.calls).toEqual([`GET ${PAGE_URL}`]);
  });
});
