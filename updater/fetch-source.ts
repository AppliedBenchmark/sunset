// Fetches and normalizes a source's machine-readable variant. Every URL requested, including each
// redirect hop, must be on the provider's allowlist, so the registry only quotes the providers'
// own pages. Pages are untrusted input: responses are size-capped while they are read, and only
// ever read as text. A network error, a timeout, a 429 or a 5xx is retried once, so a blip
// doesn't open an issue.
//
// Node's fetch sends `Accept-Language: *`, which Google's HTML docs answer with a redirect to a
// random `?hl=` language. Their Markdown variants don't redirect, and sources.yaml pins the HTML
// page to `hl=en`; `expect` catches a page in another language all the same.
import { readFileSync } from 'node:fs';
import { setTimeout } from 'node:timers/promises';
import type { FetchedPage, Fetcher, PreviousFetch } from '../src/core/ports.ts';
import { normalizeText } from '../src/core/registry/normalize.ts';
import { fetchUrlOf, isAllowedUrl } from '../src/core/registry/validate.ts';
import type { Source, SourcesFile } from '../src/core/types.ts';
import { htmlToText, rowClasses } from './html-to-text.ts';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  version: string;
};

export const USER_AGENT = `sunset-registry-updater/${pkg.version} (+https://github.com/AppliedBenchmark/sunset)`;
const TIMEOUT_MS = 30_000;
const MAX_BYTES = 5 * 1024 * 1024;
const RETRY_DELAY_MS = 2_000;
const MAX_RETRY_AFTER_MS = 30_000;
const MAX_REDIRECTS = 5;
const GITHUB_API = 'https://api.github.com';

export interface FetcherOptions {
  /** Injected for tests; defaults to the global fetch. */
  fetch?: typeof globalThis.fetch | undefined;
  /** Raises GitHub's API rate limit for `github-dir` listings. */
  githubToken?: string | undefined;
  /** The wait before the retry when the server doesn't say (Retry-After); tests set 0. */
  retryDelayMs?: number | undefined;
}

interface Got {
  text: string;
  url: string;
  etag: string | null;
  lastModified: string | null;
}

/**
 * How long to wait before retrying: the server's Retry-After in seconds, or `fallback` without
 * one. Null when the server asks for more than MAX_RETRY_AFTER_MS; the next daily run comes soon
 * enough.
 */
function retryWait(response: Response, fallback: number): number | null {
  const seconds = Number(response.headers.get('retry-after') ?? Number.NaN);
  if (!Number.isFinite(seconds) || seconds < 0) return fallback;
  return seconds * 1000 <= MAX_RETRY_AFTER_MS ? seconds * 1000 : null;
}

/** The body, refused as soon as it passes MAX_BYTES rather than after it was all read. */
async function readCapped(response: Response, url: string): Promise<Uint8Array> {
  const length = Number(response.headers.get('content-length') ?? 0);
  if (length > MAX_BYTES) {
    await response.body?.cancel();
    throw new Error(`${url}: ${length} bytes is over the size cap`);
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  // Leaving the loop early cancels the stream.
  for await (const chunk of response.body ?? []) {
    total += chunk.byteLength;
    if (total > MAX_BYTES) throw new Error(`${url}: over the size cap`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export function createFetcher(sources: SourcesFile, options: FetcherOptions = {}): Fetcher {
  const fetchFn = options.fetch ?? globalThis.fetch;
  const retryDelay = options.retryDelayMs ?? RETRY_DELAY_MS;

  /** One request, retried once after a network error, a timeout, a 429 or a 5xx. */
  async function request(url: string, init: RequestInit): Promise<Response> {
    for (let attempt = 1; ; attempt++) {
      let response: Response;
      try {
        response = await fetchFn(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
      } catch (error) {
        if (attempt > 1) throw error;
        await setTimeout(retryDelay);
        continue;
      }
      if (attempt > 1 || (response.status !== 429 && response.status < 500)) return response;
      const wait = retryWait(response, retryDelay);
      if (wait === null) return response;
      await response.body?.cancel();
      await setTimeout(wait);
    }
  }

  async function get(
    url: string,
    allow: readonly string[],
    headers: Record<string, string> = {},
  ): Promise<Got | 'not-modified'> {
    let current = url;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      if (!isAllowedUrl(current, allow)) throw new Error(`${current} is not on the allowlist`);
      const response = await request(current, {
        redirect: 'manual',
        headers: { 'user-agent': USER_AGENT, ...headers },
      });
      if (response.status === 304) return 'not-modified';
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        if (!location) throw new Error(`${current}: redirect without a location`);
        current = new URL(location, current).toString();
        continue;
      }
      if (!response.ok) throw new Error(`${current}: HTTP ${response.status}`);
      const body = await readCapped(response, current);
      return {
        text: new TextDecoder('utf-8', { fatal: true }).decode(body),
        url: current,
        etag: response.headers.get('etag'),
        lastModified: response.headers.get('last-modified'),
      };
    }
    throw new Error(`${url}: more than ${MAX_REDIRECTS} redirects`);
  }

  async function getText(url: string, allow: readonly string[]): Promise<Got> {
    const got = await get(url, allow);
    if (got === 'not-modified') throw new Error(`${url}: unexpected 304`);
    return got;
  }

  /** Lists a GitHub directory with the contents API. */
  async function listGithubDir(repo: string, ref: string, path: string): Promise<string[]> {
    const url = `${GITHUB_API}/repos/${repo}/contents/${path}?ref=${encodeURIComponent(ref)}`;
    const response = await request(url, {
      headers: {
        'user-agent': USER_AGENT,
        accept: 'application/vnd.github+json',
        ...(options.githubToken ? { authorization: `Bearer ${options.githubToken}` } : {}),
      },
    });
    if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
    const body = new TextDecoder().decode(await readCapped(response, url));
    const items = JSON.parse(body) as { type: string; name: string }[];
    if (!Array.isArray(items)) throw new Error(`${url}: not a directory`);
    return items.filter((item) => item.type === 'file').map((item) => item.name);
  }

  async function fetchRaw(
    source: Source,
    allow: readonly string[],
    previous: PreviousFetch | null,
  ): Promise<(Got & { urls: string[]; html: boolean; markdown: boolean }) | 'not-modified'> {
    const spec = source.fetch;
    // A conditional request can't tell whether the markup page changed, so it is skipped then.
    const conditional: Record<string, string> = {};
    if (previous && !source.markup) {
      if (previous.etag) conditional['if-none-match'] = previous.etag;
      if (previous.last_modified) conditional['if-modified-since'] = previous.last_modified;
    }
    switch (spec.kind) {
      case 'url': {
        const page = await get(spec.url, allow, {
          ...(spec.accept ? { accept: spec.accept } : {}),
          ...conditional,
        });
        if (page === 'not-modified') return page;
        return {
          ...page,
          urls: [page.url],
          html: spec.format === 'html',
          markdown: spec.format === 'markdown',
        };
      }
      case 'github-file': {
        const page = await get(fetchUrlOf(source), allow, conditional);
        if (page === 'not-modified') return page;
        return { ...page, urls: [page.url], html: false, markdown: spec.path.endsWith('.md') };
      }
      case 'github-dir': {
        const exclude = new Set(spec.exclude ?? []);
        const names = (await listGithubDir(spec.repo, spec.ref, spec.path))
          .filter((name) => name.endsWith(spec.include) && !exclude.has(name))
          .sort();
        if (names.length === 0) throw new Error(`${spec.repo}/${spec.path}: no matching files`);
        const base = fetchUrlOf(source);
        const parts: string[] = [];
        const urls: string[] = [];
        // Sequential, to stay polite to raw.githubusercontent.com.
        for (const name of names) {
          const page = await getText(`${base}${name}`, allow);
          parts.push(`==> ${spec.path}/${name} <==\n${page.text}`);
          urls.push(page.url);
        }
        return {
          text: parts.join('\n'),
          url: base,
          urls,
          etag: null,
          lastModified: null,
          html: false,
          markdown: false,
        };
      }
    }
  }

  return {
    async fetch(source, previous) {
      const allow = sources.providers[source.provider]?.allow ?? [];
      const raw = await fetchRaw(source, allow, previous);
      if (raw === 'not-modified') return raw;
      const text = normalizeText(
        raw.html ? htmlToText(raw.text) : raw.text,
        raw.markdown ? 'markdown' : 'text',
      );
      // Soft 404s: DeepSeek answers unknown paths with its home page and a 200.
      if (source.expect && !text.includes(source.expect)) {
        throw new Error(
          `the page doesn't contain "${source.expect}" (a soft 404 or a new layout?)`,
        );
      }
      const page: FetchedPage = {
        text,
        row_classes: {},
        urls: raw.urls,
        etag: raw.etag,
        last_modified: raw.lastModified,
      };
      if (source.markup) {
        const markup = await getText(source.markup.url, allow);
        // The row classes only mean something on the same page in the same language.
        const markupText = normalizeText(htmlToText(markup.text), 'text');
        if (source.expect && !markupText.includes(source.expect)) {
          throw new Error(
            `the HTML page ${markup.url} doesn't contain "${source.expect}" (another language or a new layout?)`,
          );
        }
        page.row_classes = rowClasses(markup.text, source.markup.row_classes);
        page.urls.push(markup.url);
      }
      return page;
    },
  };
}
