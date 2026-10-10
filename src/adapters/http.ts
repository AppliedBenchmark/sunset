// HTTP for the scan path: only the registry fetch goes through here. Every request has
// a timeout and a size cap, and the body is read as a stream so an oversized response is cut off
// instead of buffered. Redirects are followed by hand, so that one can't leave https, the rule for a
// mirror's URL: a redirect to `http://` could otherwise reach a self-hosted runner's network, and a
// pull request's `.sunset.yml` chooses the mirror.

/** Redirects followed before giving up, as many as browsers allow. */
const MAX_REDIRECTS = 20;

export interface GetOptions {
  timeoutMs: number;
  maxBytes: number;
}

export interface HttpClient {
  /** The body as UTF-8 text. Rejects on a non-2xx status, a timeout or a body over the cap. */
  getText(url: string, opts: GetOptions): Promise<string>;
}

export function createHttpClient(fetchImpl: typeof fetch = fetch): HttpClient {
  return {
    async getText(url, { timeoutMs, maxBytes }) {
      const signal = AbortSignal.timeout(timeoutMs);
      let response: Response;
      let current = url;
      for (let redirects = 0; ; redirects++) {
        try {
          response = await fetchImpl(current, { signal, redirect: 'manual' });
        } catch (error) {
          throw new Error(describeFetchError(error, timeoutMs));
        }
        const location = response.headers.get('location');
        if (response.status < 300 || response.status > 399 || location === null) break;
        await response.body?.cancel().catch(() => undefined);
        if (redirects === MAX_REDIRECTS) throw new Error(`more than ${MAX_REDIRECTS} redirects`);
        const next = new URL(location, current);
        if (next.protocol !== 'https:' && next.protocol !== new URL(current).protocol) {
          throw new Error(`a redirect from https to ${next.protocol}`);
        }
        current = next.href;
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        throw new Error(
          `HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ''}`,
        );
      }
      const declared = Number(response.headers.get('content-length'));
      if (declared > maxBytes) {
        await response.body?.cancel().catch(() => undefined);
        throw new Error(
          `the response is ${bytes(declared)} bytes; the limit is ${bytes(maxBytes)}`,
        );
      }
      if (!response.body) return '';

      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > maxBytes) {
            await reader.cancel().catch(() => undefined);
            throw new Error(`the response is over the ${bytes(maxBytes)}-byte limit`);
          }
          chunks.push(value);
        }
      } catch (error) {
        if (error instanceof Error && error.message.includes('-byte limit')) throw error;
        throw new Error(describeFetchError(error, timeoutMs));
      }
      return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
    },
  };
}

const bytes = (n: number): string => n.toLocaleString('en-US');

function describeFetchError(error: unknown, timeoutMs: number): string {
  const name = (error as { name?: string } | null)?.name;
  if (name === 'TimeoutError' || name === 'AbortError') return `no response within ${timeoutMs} ms`;
  const cause = (error as { cause?: { code?: string; message?: string } } | null)?.cause;
  return cause?.code ?? cause?.message ?? (error instanceof Error ? error.message : String(error));
}
