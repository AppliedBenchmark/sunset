// The updater's fetcher: allowlisted redirects, conditional requests, no Accept-Language of its
// own, a size cap, soft-404 detection and the markup page's row classes.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import type { Source, SourcesFile } from '../../src/core/types.ts';
import { createFetcher, USER_AGENT } from '../../updater/fetch-source.ts';

const source = (overrides: Partial<Source> = {}): Source => ({
  id: 'gemini-api/deprecations',
  provider: 'gemini-api',
  platforms: ['gemini-api'],
  url: 'https://ai.google.dev/gemini-api/docs/deprecations',
  fetch: {
    kind: 'url',
    url: 'https://ai.google.dev/gemini-api/docs/deprecations.md.txt',
    format: 'markdown',
  },
  expect: 'Shutdown date',
  parser: 'gemini-api-deprecations',
  ...overrides,
});

const sources: SourcesFile = {
  schema_version: 1,
  providers: { 'gemini-api': { allow: ['https://ai.google.dev/gemini-api/docs/'] } },
  sources: [],
};

interface Call {
  url: string;
  headers: Record<string, string>;
}

function fakeFetch(routes: Record<string, () => Response>) {
  const calls: Call[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, headers: { ...(init?.headers as Record<string, string>) } });
    const route = routes[url];
    if (!route) return new Response('not found', { status: 404 });
    return route();
  }) as typeof fetch;
  return { impl, calls };
}

const PAGE = '| **Model** | **Shutdown date** |\n|---|---|\n| `gemini-x` | June 1, 2026 |\n';
const MD = 'https://ai.google.dev/gemini-api/docs/deprecations.md.txt';

describe('createFetcher', () => {
  it('sends our user agent and no Accept-Language of its own', async () => {
    const { impl, calls } = fakeFetch({
      [MD]: () => new Response(PAGE, { headers: { etag: '"v1"' } }),
    });
    const page = await createFetcher(sources, { fetch: impl }).fetch(source(), null);
    expect(page).toMatchObject({ etag: '"v1"', urls: [MD], row_classes: {} });
    expect(calls[0]?.headers['user-agent']).toBe(USER_AGENT);
    expect(USER_AGENT).toMatch(
      /^sunset-registry-updater\/\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)? \(\+https:\/\/github\.com\/AppliedBenchmark\/sunset\)$/,
    );
    expect(Object.keys(calls[0]?.headers ?? {}).map((h) => h.toLowerCase())).not.toContain(
      'accept-language',
    );
  });

  it('makes a conditional request and reports a 304 as not modified', async () => {
    const { impl, calls } = fakeFetch({ [MD]: () => new Response(null, { status: 304 }) });
    const result = await createFetcher(sources, { fetch: impl }).fetch(source(), {
      etag: '"v1"',
      last_modified: 'Wed, 07 Oct 2026 23:03:44 GMT',
    });
    expect(result).toBe('not-modified');
    expect(calls[0]?.headers).toMatchObject({
      'if-none-match': '"v1"',
      'if-modified-since': 'Wed, 07 Oct 2026 23:03:44 GMT',
    });
  });

  it('follows allowlisted redirects and refuses others', async () => {
    const moved = 'https://ai.google.dev/gemini-api/docs/moved.md.txt';
    const ok = fakeFetch({
      [MD]: () =>
        new Response(null, { status: 301, headers: { location: '/gemini-api/docs/moved.md.txt' } }),
      [moved]: () => new Response(PAGE),
    });
    expect(await createFetcher(sources, { fetch: ok.impl }).fetch(source(), null)).toMatchObject({
      urls: [moved],
    });
    const evil = fakeFetch({
      [MD]: () =>
        new Response(null, { status: 302, headers: { location: 'https://evil.example/x' } }),
    });
    await expect(
      createFetcher(sources, { fetch: evil.impl }).fetch(source(), null),
    ).rejects.toThrow('https://evil.example/x is not on the allowlist');
    expect(evil.calls.map((c) => c.url)).toEqual([MD]);
  });

  it('caps the response size', async () => {
    const { impl } = fakeFetch({
      [MD]: () => new Response('x', { headers: { 'content-length': String(6 * 1024 * 1024) } }),
    });
    await expect(createFetcher(sources, { fetch: impl }).fetch(source(), null)).rejects.toThrow(
      'over the size cap',
    );
  });

  it('retries once after a server error or a network error, then gives up', async () => {
    const statuses = [503, 200];
    const once = fakeFetch({ [MD]: () => new Response(PAGE, { status: statuses.shift() ?? 200 }) });
    const fetcher = createFetcher(sources, { fetch: once.impl, retryDelayMs: 0 });
    expect(await fetcher.fetch(source(), null)).toMatchObject({ urls: [MD] });
    expect(once.calls).toHaveLength(2);

    const down = fakeFetch({ [MD]: () => new Response('busy', { status: 429 }) });
    await expect(
      createFetcher(sources, { fetch: down.impl, retryDelayMs: 0 }).fetch(source(), null),
    ).rejects.toThrow(`${MD}: HTTP 429`);
    expect(down.calls).toHaveLength(2);

    let failures = 1;
    const flaky = (async (input: string | URL | Request) => {
      if (failures-- > 0) throw new TypeError('fetch failed');
      return input === MD ? new Response(PAGE) : new Response('', { status: 404 });
    }) as typeof fetch;
    expect(
      await createFetcher(sources, { fetch: flaky, retryDelayMs: 0 }).fetch(source(), null),
    ).toMatchObject({ urls: [MD] });
  });

  it('does not retry a client error, or a server that asks to wait long', async () => {
    const gone = fakeFetch({ [MD]: () => new Response('gone', { status: 410 }) });
    await expect(
      createFetcher(sources, { fetch: gone.impl, retryDelayMs: 0 }).fetch(source(), null),
    ).rejects.toThrow(`${MD}: HTTP 410`);
    expect(gone.calls).toHaveLength(1);

    const later = fakeFetch({
      [MD]: () => new Response('busy', { status: 503, headers: { 'retry-after': '3600' } }),
    });
    await expect(
      createFetcher(sources, { fetch: later.impl, retryDelayMs: 0 }).fetch(source(), null),
    ).rejects.toThrow(`${MD}: HTTP 503`);
    expect(later.calls).toHaveLength(1);
  });

  it('stops reading a body without a length once it passes the size cap', async () => {
    const chunk = new Uint8Array(64 * 1024).fill(120);
    let pulled = 0;
    const endless = () =>
      new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            // 64 MiB in all, if nobody stops reading.
            if (pulled >= 64 * 1024 * 1024) controller.close();
            else {
              pulled += chunk.byteLength;
              controller.enqueue(chunk);
            }
          },
        }),
      );
    const { impl } = fakeFetch({ [MD]: endless });
    await expect(createFetcher(sources, { fetch: impl }).fetch(source(), null)).rejects.toThrow(
      'over the size cap',
    );
    expect(pulled).toBeLessThan(6 * 1024 * 1024);
  });

  it('detects a soft 404 by the expected text', async () => {
    const { impl } = fakeFetch({ [MD]: () => new Response('# Welcome to our home page\n') });
    await expect(createFetcher(sources, { fetch: impl }).fetch(source(), null)).rejects.toThrow(
      'doesn\'t contain "Shutdown date"',
    );
  });

  it('reads row classes from the markup page, without a conditional request', async () => {
    const html = 'https://ai.google.dev/gemini-api/docs/deprecations';
    const { impl, calls } = fakeFetch({
      [MD]: () => new Response(PAGE),
      [html]: () =>
        new Response(
          '<table><tr><th>Model</th><th>Shutdown date</th></tr>' +
            '<tr class="row-gray"><td><code>gemini-old</code></td><td>June 1, 2025</td></tr>' +
            '<tr><td><code>gemini-x</code></td><td>June 1, 2026</td></tr></table>',
        ),
    });
    const page = await createFetcher(sources, { fetch: impl }).fetch(
      source({ markup: { url: html, row_classes: ['row-gray'] } }),
      { etag: '"v1"', last_modified: null },
    );
    expect(page).toMatchObject({ row_classes: { 'row-gray': ['gemini-old'] }, urls: [MD, html] });
    expect(calls[0]?.headers['if-none-match']).toBeUndefined();
  });

  it('refuses a markup page without the expected text, such as one in another language', async () => {
    const html = 'https://ai.google.dev/gemini-api/docs/deprecations?hl=en';
    const { impl } = fakeFetch({
      [MD]: () => new Response(PAGE),
      [html]: () =>
        new Response(
          '<table><tr><th>モデル</th><th>提供終了日</th></tr>' +
            '<tr class="row-gray"><td><code>gemini-old</code></td><td>2025年6月1日</td></tr></table>',
        ),
    });
    await expect(
      createFetcher(sources, { fetch: impl }).fetch(
        source({ markup: { url: html, row_classes: ['row-gray'] } }),
        null,
      ),
    ).rejects.toThrow(`the HTML page ${html} doesn't contain "Shutdown date"`);
  });

  it("pins Google's HTML pages to English, which otherwise redirect to a random language", () => {
    const file = parse(
      readFileSync(new URL('../../registry/sources.yaml', import.meta.url), 'utf8'),
    ) as SourcesFile;
    const markups = file.sources.flatMap((s) => (s.markup ? [new URL(s.markup.url)] : []));
    expect(markups.length).toBeGreaterThan(0);
    for (const url of markups) {
      if (url.hostname.endsWith('google.dev') || url.hostname.endsWith('google.com')) {
        expect(url.searchParams.get('hl'), url.href).toBe('en');
      }
    }
  });
});
