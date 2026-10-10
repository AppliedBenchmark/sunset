// The updater's issues over the GitHub REST API. One open issue per key, labelled
// `updater-failure`: created on the first failure, updated on repeat failures, closed with a
// comment when the key succeeds again. An issue is the key's only when its body starts with the
// key's hidden marker and the token's own account opened it: anyone can open an issue with the
// marker, and the updater must not edit or close theirs.
import { graphqlUrlFor } from '../src/adapters/github-rest.ts';
import type { IssueTracker } from '../src/core/ports.ts';

export const ISSUE_LABEL = 'updater-failure';

export interface IssueTarget {
  /** `GITHUB_API_URL`, e.g. https://api.github.com */
  apiUrl: string;
  /** `GITHUB_GRAPHQL_URL`, e.g. https://api.github.com/graphql. Derived from `apiUrl` if unset. */
  graphqlUrl?: string | undefined;
  /** `owner/repo` */
  repository: string;
  token: string;
  fetch?: typeof fetch;
}

interface Issue {
  number: number;
  title: string;
  body?: string | null;
  user?: { login?: string } | null;
  pull_request?: unknown;
}

const MAX_PAGES = 10;

export const issueMarker = (key: string) => `<!-- sunset-updater:${key} -->`;

/** Bot logins end in `[bot]` in REST responses but not in every GraphQL field. */
const sameLogin = (a: string, b: string): boolean =>
  a.replace(/\[bot\]$/, '') === b.replace(/\[bot\]$/, '');

export function createIssueTracker(target: IssueTarget): IssueTracker {
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
        'user-agent': 'sunset-registry-updater',
        ...(body !== undefined && { 'content-type': 'application/json' }),
      },
      ...(body !== undefined && { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      const path = url.replace(base, '');
      throw new Error(`${method} ${path}: HTTP ${response.status}${text ? ` (${text})` : ''}`);
    }
    return response.status === 204 ? null : response.json();
  };

  /** The account the token acts as: the App's bot for an installation token. */
  const viewerLogin = async (): Promise<string> => {
    const response = (await call('POST', graphqlUrl, { query: 'query { viewer { login } }' })) as {
      data?: { viewer?: { login?: string } };
    } | null;
    const login = response?.data?.viewer?.login;
    if (!login) throw new Error("couldn't tell which account the token belongs to");
    return login;
  };

  const find = async (key: string): Promise<Issue | null> => {
    const marker = issueMarker(key);
    let login: string | undefined;
    for (let page = 1; page <= MAX_PAGES; page++) {
      const issues = (await call(
        'GET',
        `${base}/issues?state=open&labels=${ISSUE_LABEL}&per_page=100&page=${page}`,
      )) as Issue[];
      for (const issue of issues) {
        if (issue.pull_request || !issue.body?.startsWith(marker) || !issue.user?.login) continue;
        login ??= await viewerLogin();
        if (sameLogin(issue.user.login, login)) return issue;
      }
      if (issues.length < 100) return null;
    }
    return null;
  };

  return {
    async upsert(key, title, body) {
      const full = `${issueMarker(key)}\n${body}`;
      const existing = await find(key);
      if (!existing) {
        await call('POST', `${base}/issues`, { title, body: full, labels: [ISSUE_LABEL] });
        return 'created';
      }
      if (existing.body === full && existing.title === title) return 'unchanged';
      await call('PATCH', `${base}/issues/${existing.number}`, { title, body: full });
      return 'updated';
    },
    async close(key, comment) {
      const existing = await find(key);
      if (!existing) return false;
      await call('POST', `${base}/issues/${existing.number}/comments`, { body: comment });
      await call('PATCH', `${base}/issues/${existing.number}`, {
        state: 'closed',
        state_reason: 'completed',
      });
      return true;
    },
  };
}

/** For dry runs: prints what would be filed. */
export function createLoggingIssueTracker(log: (line: string) => void): IssueTracker {
  return {
    async upsert(key, title, body) {
      log(`[dry run] issue ${key}: ${title}\n${body}`);
      return 'unchanged';
    },
    async close(key) {
      log(`[dry run] would close the issue for ${key}, if one is open`);
      return false;
    },
  };
}
