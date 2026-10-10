// The sticky PR comment over the GitHub REST API, with `fetch`: list the comments, then
// create one or update ours, the one that starts with the marker and was written by the token's
// own account. Anyone can post a comment that starts with the marker, so the author is checked
// too. A read-only token (pull requests from forks) answers 403, which maps to 'forbidden' so the
// caller can carry on.
import type { PrCommentPort, UpsertOptions } from '../core/ports.ts';

export interface PrCommentTarget {
  /** `GITHUB_API_URL`, e.g. https://api.github.com */
  apiUrl: string;
  /** `GITHUB_GRAPHQL_URL`, e.g. https://api.github.com/graphql. Derived from `apiUrl` if unset. */
  graphqlUrl?: string;
  /** `owner/repo` */
  repository: string;
  issueNumber: number;
  token: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

interface Comment {
  id: number;
  body?: string | null;
  user?: { login?: string } | null;
}

/** An HTTP error from the GitHub API. */
export class GitHubApiError extends Error {
  override name = 'GitHubApiError';
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const MAX_PAGES = 30;

/** GitHub Enterprise Server serves REST at `/api/v3` and GraphQL at `/api/graphql`. */
export function graphqlUrlFor(apiUrl: string): string {
  const api = apiUrl.replace(/\/$/, '');
  return api.endsWith('/api/v3') ? `${api.slice(0, -'/v3'.length)}/graphql` : `${api}/graphql`;
}

export function createPrComments(target: PrCommentTarget): PrCommentPort {
  const fetchImpl = target.fetch ?? fetch;
  const base = `${target.apiUrl.replace(/\/$/, '')}/repos/${target.repository}`;
  const graphqlUrl = target.graphqlUrl ?? graphqlUrlFor(target.apiUrl);

  const call = async (method: string, url: string, body?: unknown): Promise<unknown> => {
    const response = await fetchImpl(url, {
      method,
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${target.token}`,
        'x-github-api-version': '2022-11-28',
        'user-agent': 'sunset-action',
        ...(body !== undefined && { 'content-type': 'application/json' }),
      },
      ...(body !== undefined && { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(target.timeoutMs ?? 15_000),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      const message = (() => {
        try {
          return (JSON.parse(text) as { message?: string }).message ?? text;
        } catch {
          return text;
        }
      })();
      throw new GitHubApiError(
        response.status,
        `${method} ${url.replace(base, '')}: HTTP ${response.status}${message ? ` (${message})` : ''}`,
      );
    }
    return response.status === 204 ? null : response.json();
  };

  /**
   * The account the token acts as, spelled as REST spells comment authors: `github-actions[bot]`
   * for `GITHUB_TOKEN`. REST adds `[bot]` to a bot's login; GraphQL may not.
   */
  const viewerLogin = async (): Promise<string> => {
    const response = (await call('POST', graphqlUrl, {
      query: 'query { viewer { __typename login } }',
    })) as { data?: { viewer?: { __typename?: string; login?: string } } } | null;
    const viewer = response?.data?.viewer;
    if (!viewer?.login) throw new Error("couldn't tell which account the token belongs to");
    const bot = viewer.__typename === 'Bot' && !viewer.login.endsWith('[bot]');
    return bot ? `${viewer.login}[bot]` : viewer.login;
  };

  const findExisting = async (marker: string): Promise<Comment | null> => {
    let login: string | undefined;
    for (let page = 1; page <= MAX_PAGES; page++) {
      const comments = (await call(
        'GET',
        `${base}/issues/${target.issueNumber}/comments?per_page=100&page=${page}`,
      )) as Comment[];
      for (const c of comments) {
        if (!c.body?.startsWith(marker) || !c.user?.login) continue;
        login ??= await viewerLogin();
        if (c.user.login === login) return c;
      }
      if (comments.length < 100) return null;
    }
    return null;
  };

  return {
    async upsert(marker: string, body: string, opts: UpsertOptions) {
      try {
        const existing = await findExisting(marker);
        if (existing) {
          if (existing.body === body) return 'unchanged';
          await call('PATCH', `${base}/issues/comments/${existing.id}`, { body });
          return 'updated';
        }
        if (!opts.create) return 'skipped';
        await call('POST', `${base}/issues/${target.issueNumber}/comments`, { body });
        return 'created';
      } catch (error) {
        if (error instanceof GitHubApiError && error.status === 403) return 'forbidden';
        throw error;
      }
    },
  };
}
