// The PR comment adapter: REST calls behind PrCommentPort, with a fake fetch.
import { describe, expect, it } from 'vitest';
import { createPrComments, GitHubApiError, graphqlUrlFor } from '../src/adapters/github-rest.ts';

const MARKER = '<!-- sunset:pr-comment -->';
/** What `GITHUB_TOKEN` comments as, in REST responses. */
const BOT = { login: 'github-actions[bot]' };

interface Call {
  method: string;
  path: string;
  body?: unknown;
  auth: string | null;
}

interface FakeComment {
  id: number;
  body: string;
  user?: { login: string };
}

function fakeGitHub(comments: FakeComment[], status: Record<string, number> = {}) {
  const calls: Call[] = [];
  const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const headers = new Headers(init?.headers);
    calls.push({
      method,
      path: `${url.pathname}${url.search}`,
      ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
      auth: headers.get('authorization'),
    });
    // The token's own account, as GraphQL reports it.
    if (url.pathname === '/graphql') return Response.json({ data: { viewer: BOT } });
    const forced = status[method];
    if (forced) {
      return new Response(JSON.stringify({ message: 'Resource not accessible by integration' }), {
        status: forced,
      });
    }
    if (method === 'GET') {
      const page = Number(url.searchParams.get('page'));
      return Response.json(comments.slice((page - 1) * 100, page * 100));
    }
    return Response.json({ id: 1 }, { status: method === 'POST' ? 201 : 200 });
  }) as typeof globalThis.fetch;
  const port = createPrComments({
    apiUrl: 'https://api.github.test/',
    repository: 'octo/repo',
    issueNumber: 7,
    token: 'tkn',
    fetch: fakeFetch,
  });
  return { port, calls };
}

describe('createPrComments', () => {
  it('creates the comment when there is none', async () => {
    const { port, calls } = fakeGitHub([{ id: 1, body: 'LGTM' }]);
    expect(await port.upsert(MARKER, `${MARKER}\nhello`, { create: true })).toBe('created');
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      'GET /repos/octo/repo/issues/7/comments?per_page=100&page=1',
      'POST /repos/octo/repo/issues/7/comments',
    ]);
    expect(calls[1]?.body).toEqual({ body: `${MARKER}\nhello` });
    expect(calls.every((c) => c.auth === 'Bearer tkn')).toBe(true);
  });

  it("doesn't create one when told not to", async () => {
    const { port, calls } = fakeGitHub([]);
    expect(await port.upsert(MARKER, `${MARKER}\nnothing new`, { create: false })).toBe('skipped');
    expect(calls).toHaveLength(1);
  });

  it('updates the marked comment, looking past the first page', async () => {
    const others = Array.from({ length: 100 }, (_, i) => ({ id: i + 1, body: `comment ${i}` }));
    const { port, calls } = fakeGitHub([...others, { id: 555, body: `${MARKER}\nold`, user: BOT }]);
    expect(await port.upsert(MARKER, `${MARKER}\nnew`, { create: false })).toBe('updated');
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      'GET /repos/octo/repo/issues/7/comments?per_page=100&page=1',
      'GET /repos/octo/repo/issues/7/comments?per_page=100&page=2',
      'POST /graphql',
      'PATCH /repos/octo/repo/issues/comments/555',
    ]);
  });

  it('leaves an identical comment alone', async () => {
    const { port, calls } = fakeGitHub([{ id: 9, body: `${MARKER}\nsame`, user: BOT }]);
    expect(await port.upsert(MARKER, `${MARKER}\nsame`, { create: true })).toBe('unchanged');
    expect(calls.map((c) => c.method)).toEqual(['GET', 'POST']);
  });

  it("ignores a marked comment that someone else wrote, and doesn't edit it", async () => {
    const { port, calls } = fakeGitHub([
      { id: 3, body: `${MARKER}\nLGTM`, user: { login: 'mallory' } },
    ]);
    expect(await port.upsert(MARKER, `${MARKER}\nnew`, { create: true })).toBe('created');
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      'GET /repos/octo/repo/issues/7/comments?per_page=100&page=1',
      'POST /graphql',
      'POST /repos/octo/repo/issues/7/comments',
    ]);
  });

  it('matches a bot by its REST login even when GraphQL leaves out `[bot]`', async () => {
    const calls: string[] = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      calls.push(`${init?.method ?? 'GET'} ${url.pathname}`);
      if (url.pathname === '/graphql') {
        return Response.json({ data: { viewer: { __typename: 'Bot', login: 'my-app' } } });
      }
      if ((init?.method ?? 'GET') === 'GET') {
        return Response.json([
          // A person whose login is the app's name doesn't count.
          { id: 1, body: `${MARKER}\nfake`, user: { login: 'my-app' } },
          { id: 2, body: `${MARKER}\nold`, user: { login: 'my-app[bot]' } },
        ]);
      }
      return Response.json({ id: 2 });
    }) as typeof globalThis.fetch;
    const port = createPrComments({
      apiUrl: 'https://api.github.test',
      repository: 'octo/repo',
      issueNumber: 7,
      token: 'tkn',
      fetch: fetchImpl,
    });
    expect(await port.upsert(MARKER, `${MARKER}\nnew`, { create: true })).toBe('updated');
    expect(calls.at(-1)).toBe('PATCH /repos/octo/repo/issues/comments/2');
  });

  it('finds GraphQL next to the REST API, on GitHub Enterprise Server too', () => {
    expect(graphqlUrlFor('https://api.github.com')).toBe('https://api.github.com/graphql');
    expect(graphqlUrlFor('https://ghe.example/api/v3/')).toBe('https://ghe.example/api/graphql');
  });

  it('maps a read-only token (fork pull requests) to forbidden', async () => {
    expect(await fakeGitHub([], { POST: 403 }).port.upsert(MARKER, MARKER, { create: true })).toBe(
      'forbidden',
    );
    expect(
      await fakeGitHub([{ id: 1, body: `${MARKER}\nold`, user: BOT }], { PATCH: 403 }).port.upsert(
        MARKER,
        `${MARKER}\nnew`,
        { create: true },
      ),
    ).toBe('forbidden');
  });

  it('throws other API errors with their message', async () => {
    const { port } = fakeGitHub([], { GET: 500 });
    const error = await port.upsert(MARKER, MARKER, { create: true }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GitHubApiError);
    expect((error as GitHubApiError).status).toBe(500);
    expect((error as Error).message).toContain('Resource not accessible by integration');
  });
});
