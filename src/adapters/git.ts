// Git for the PR delta: the base revision, the files a pull request changed, and file
// contents at the base. Paths are relative to the scanned directory, like the scan's.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ChangedFile, FileSource, RevisionReader } from '../core/ports.ts';
import { isBinary } from './file-source.ts';

const run = promisify(execFile);

export interface Git extends RevisionReader {
  /**
   * This directory's path from the repository's top level, as git gives it: `svc/`, '' at the top
   * level, or null outside a work tree.
   */
  prefix(): Promise<string | null>;
  /** The parents of a commit, read from the commit object, so it works in shallow clones. */
  parents(rev: string): Promise<string[]>;
  hasCommit(sha: string): Promise<boolean>;
  /** `git fetch --no-tags --depth=1 origin <sha>`, authenticated with `token` when given. */
  fetchCommit(sha: string, token?: string): Promise<void>;
  /** The best common ancestor of two commits, or null when the clone's history doesn't reach it. */
  mergeBase(a: string, b: string): Promise<string | null>;
  revParse(rev: string): Promise<string>;
}

export interface GitOptions {
  /** Files larger than this read as null, like the scan's. */
  maxFileSize: number;
  /** `GITHUB_SERVER_URL`: the fetch token is sent only to this server. */
  serverUrl?: string;
}

/** A fetch of one commit is small; past this, something is stuck. */
const FETCH_TIMEOUT_MS = 120_000;

export function createGit(cwd: string, opts: GitOptions): Git {
  const git = async (
    args: string[],
    extra: { env?: NodeJS.ProcessEnv; timeout?: number } = {},
  ): Promise<string> => {
    const { stdout } = await run('git', args, {
      cwd,
      maxBuffer: 256 * 1024 * 1024,
      encoding: 'utf8',
      ...(extra.env && { env: { ...process.env, ...extra.env } }),
      ...(extra.timeout && { timeout: extra.timeout }),
    });
    return stdout;
  };

  return {
    async prefix() {
      try {
        // Only the line break goes: a directory's name may start with a space.
        return (await git(['rev-parse', '--show-prefix'])).replace(/\r?\n$/, '');
      } catch {
        return null;
      }
    },

    async parents(rev) {
      const raw = await git(['cat-file', 'commit', rev]);
      const header = raw.slice(0, raw.indexOf('\n\n'));
      return [...header.matchAll(/^parent ([0-9a-f]+)$/gm)].map((m) => m[1] as string);
    },

    async hasCommit(sha) {
      try {
        await git(['cat-file', '-e', `${sha}^{commit}`]);
        return true;
      } catch {
        return false;
      }
    },

    async fetchCommit(sha, token) {
      await git(['fetch', '--no-tags', '--no-recurse-submodules', '--depth=1', 'origin', sha], {
        ...(token && { env: fetchAuthEnv(token, opts.serverUrl ?? 'https://github.com') }),
        timeout: FETCH_TIMEOUT_MS,
      });
    },

    async mergeBase(a, b) {
      try {
        return (await git(['merge-base', a, b])).trim() || null;
      } catch {
        return null;
      }
    },

    async revParse(rev) {
      return (await git(['rev-parse', '--verify', `${rev}^{commit}`])).trim();
    },

    async changedFiles(base, head) {
      const out = await git([
        '-c',
        'core.quotepath=off',
        'diff',
        '--name-status',
        '-z',
        '--find-renames',
        '--relative',
        '--no-ext-diff',
        base,
        head,
        '--',
      ]);
      return parseNameStatus(out);
    },

    async readAt(rev, path) {
      let size: number;
      try {
        size = Number((await git(['cat-file', '-s', `${rev}:./${path}`])).trim());
      } catch {
        return null;
      }
      if (size > opts.maxFileSize) return null;
      const { stdout } = await run('git', ['cat-file', 'blob', `${rev}:./${path}`], {
        cwd,
        maxBuffer: Math.max(opts.maxFileSize, 1) + 1024,
        encoding: 'buffer',
      });
      if (isBinary(stdout)) return null;
      return new TextDecoder('utf-8').decode(stdout);
    },
  };
}

/**
 * Git config, as environment variables, that sends `token` to `serverUrl` only, as actions/checkout
 * scopes it, whatever `origin` points to. In the environment rather than argv, the token never
 * shows in a process list.
 */
export function fetchAuthEnv(token: string, serverUrl: string): NodeJS.ProcessEnv {
  return {
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: `http.${new URL(serverUrl).origin}/.extraheader`,
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`,
  };
}

/** Parses `git diff --name-status -z`. Deleted files are left out; copies count as added. */
export function parseNameStatus(out: string): ChangedFile[] {
  const fields = out.split('\0');
  const files: ChangedFile[] = [];
  for (let i = 0; i < fields.length; ) {
    const status = fields[i++] ?? '';
    if (status === '') continue;
    const code = status[0];
    if (code === 'R' || code === 'C') {
      const from = fields[i++] as string;
      const to = fields[i++] as string;
      files.push(
        code === 'R'
          ? { path: to, previousPath: from, status: 'renamed' }
          : { path: to, previousPath: null, status: 'added' },
      );
      continue;
    }
    const path = fields[i++] as string;
    if (code === 'D') continue;
    files.push({ path, previousPath: null, status: code === 'A' ? 'added' : 'modified' });
  }
  return files;
}

export interface PullRequestEvent {
  number: number;
  base: { sha: string };
  head: { sha: string };
}

/**
 * The revision a pull request is compared against. When HEAD is GitHub's merge commit (the
 * default checkout for `pull_request`), that's its first parent. Otherwise (a checkout of the
 * pull request's head, say) it's where the pull request branched off, as on GitHub's "Files
 * changed" tab: a diff against `pull_request.base.sha` itself would count everything the base
 * branch changed since then as the pull request's.
 */
export async function pullRequestBase(
  git: Git,
  pr: PullRequestEvent,
  token?: string,
): Promise<string> {
  const parents = await git.parents('HEAD').catch(() => []);
  if (parents.length === 2 && parents[1] === pr.head.sha) return parents[0] as string;
  if (!(await git.hasCommit(pr.base.sha))) await git.fetchCommit(pr.base.sha, token);
  const base = await git.mergeBase(pr.base.sha, 'HEAD');
  if (base === null) {
    throw new Error(
      "HEAD isn't the merge commit that actions/checkout makes for a pull request, and the clone's history doesn't reach where the pull request branched off. Use the default checkout, or `fetch-depth: 0`.",
    );
  }
  return base;
}

/** A FileSource over some files at another revision, for scanning the base side of the delta. */
export function revisionFiles(
  reader: RevisionReader,
  rev: string,
  paths: readonly string[],
): FileSource {
  const texts = new Map<string, string | null>();
  return {
    async *list() {
      for (const path of [...paths].sort()) {
        const text = await reader.readAt(rev, path);
        texts.set(path, text);
        // Unreadable files (binary, too large, gone) are listed with size 0 and read as null.
        yield { path, size: text?.length ?? 0 };
      }
    },
    read: async (file) => texts.get(file.path) ?? null,
  };
}
