// The updater's issues: one per key, found by a hidden marker and their author, updated on repeat
// failures, closed when the provider succeeds again.
import { describe, expect, it } from 'vitest';
import { createIssueTracker, ISSUE_LABEL, issueMarker } from '../../updater/github.ts';

/** The App's bot, as REST reports the author of the issues it opens. */
const BOT = { login: 'sunset-updater[bot]' };

interface Issue {
  number: number;
  title: string;
  body: string;
  state: string;
  user: { login: string };
  pull_request?: unknown;
}

function fakeGitHub(initial: Issue[] = []) {
  const issues = [...initial];
  const calls: string[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push(`${method} ${url.pathname}${url.search}`);
    // The token's own account; GraphQL leaves out the `[bot]`.
    if (url.pathname === '/graphql') {
      return Response.json({ data: { viewer: { login: 'sunset-updater' } } });
    }
    const path = url.pathname.replace('/repos/o/r', '');
    if (method === 'GET' && path === '/issues') {
      expect(url.searchParams.get('labels')).toBe(ISSUE_LABEL);
      return Response.json(issues.filter((i) => i.state === 'open'));
    }
    if (method === 'POST' && path === '/issues') {
      expect(body.labels).toEqual([ISSUE_LABEL]);
      issues.push({
        number: issues.length + 1,
        title: body.title,
        body: body.body,
        state: 'open',
        user: BOT,
      });
      return Response.json({}, { status: 201 });
    }
    const match = /^\/issues\/(\d+)(\/comments)?$/.exec(path);
    const issue = issues.find((i) => i.number === Number(match?.[1]));
    if (issue && method === 'PATCH') {
      Object.assign(issue, body);
      return Response.json({});
    }
    if (issue && method === 'POST' && match?.[2]) return Response.json({}, { status: 201 });
    return new Response('nope', { status: 404 });
  }) as typeof fetch;
  const tracker = createIssueTracker({
    apiUrl: 'https://api.github.com',
    repository: 'o/r',
    token: 't',
    fetch: impl,
  });
  return { tracker, issues, calls };
}

describe('createIssueTracker', () => {
  it('creates, then updates, then leaves an unchanged issue alone', async () => {
    const { tracker, issues } = fakeGitHub();
    expect(await tracker.upsert('provider:openai', 'Failed', 'day 1')).toBe('created');
    expect(issues[0]?.body).toBe(`${issueMarker('provider:openai')}\nday 1`);
    expect(await tracker.upsert('provider:openai', 'Failed', 'day 2')).toBe('updated');
    expect(await tracker.upsert('provider:openai', 'Failed', 'day 2')).toBe('unchanged');
    expect(issues).toHaveLength(1);
  });

  it('keeps one issue per key and ignores pull requests with the marker', async () => {
    const { tracker, issues } = fakeGitHub([
      {
        number: 1,
        title: 'PR',
        body: issueMarker('provider:openai'),
        state: 'open',
        user: BOT,
        pull_request: {},
      },
    ]);
    expect(await tracker.upsert('provider:openai', 'Failed', 'x')).toBe('created');
    expect(await tracker.upsert('provider:mistral', 'Failed', 'x')).toBe('created');
    expect(issues.map((i) => i.number)).toEqual([1, 2, 3]);
  });

  it('leaves alone an issue with the marker that someone else opened', async () => {
    const theirs: Issue = {
      number: 1,
      title: 'Not the updater',
      body: `${issueMarker('provider:openai')}\nmine`,
      state: 'open',
      user: { login: 'mallory' },
    };
    const { tracker, issues, calls } = fakeGitHub([theirs]);
    expect(await tracker.close('provider:openai', 'Fixed')).toBe(false);
    expect(await tracker.upsert('provider:openai', 'Failed', 'x')).toBe('created');
    expect(issues[0]).toMatchObject({
      body: `${issueMarker('provider:openai')}\nmine`,
      state: 'open',
    });
    expect(calls.filter((c) => c.startsWith('PATCH'))).toEqual([]);
  });

  it('closes the open issue with a comment, and does nothing without one', async () => {
    const { tracker, issues, calls } = fakeGitHub();
    expect(await tracker.close('provider:openai', 'Fixed')).toBe(false);
    await tracker.upsert('provider:openai', 'Failed', 'x');
    expect(await tracker.close('provider:openai', 'Fixed')).toBe(true);
    expect(issues[0]?.state).toBe('closed');
    expect(calls).toContain('POST /repos/o/r/issues/1/comments');
  });
});
