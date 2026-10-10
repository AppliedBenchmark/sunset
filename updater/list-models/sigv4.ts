// AWS Signature Version 4 for a GET with an empty body (Bedrock `ListFoundationModels`), so
// the optional Bedrock check needs no AWS SDK.
// https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_sigv-create-signed-request.html
import { createHash, createHmac } from 'node:crypto';

export interface SigV4Request {
  method: 'GET';
  url: string;
  region: string;
  service: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string | undefined;
  now: Date;
}

const sha256 = (data: string) => createHash('sha256').update(data).digest('hex');
const hmac = (key: Buffer | string, data: string) =>
  createHmac('sha256', key).update(data).digest();

/** RFC 3986 encoding, as SigV4 requires. */
const encode = (s: string) =>
  encodeURIComponent(s).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );

/** The headers to send: `x-amz-date`, `authorization` and, for temporary credentials, the token. */
export function sigV4Headers(req: SigV4Request): Record<string, string> {
  const url = new URL(req.url);
  const amzDate = req.now.toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
  const date = amzDate.slice(0, 8);
  const headers: Record<string, string> = { host: url.host, 'x-amz-date': amzDate };
  if (req.sessionToken) headers['x-amz-security-token'] = req.sessionToken;
  const names = Object.keys(headers).sort();
  const query = [...url.searchParams]
    .map(([k, v]) => `${encode(k)}=${encode(v)}`)
    .sort()
    .join('&');
  const canonical = [
    req.method,
    url.pathname.split('/').map(encode).join('/') || '/',
    query,
    ...names.map((n) => `${n}:${headers[n]}`),
    '',
    names.join(';'),
    sha256(''),
  ].join('\n');
  const scope = `${date}/${req.region}/${req.service}/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonical)].join('\n');
  let key = hmac(`AWS4${req.secretAccessKey}`, date);
  for (const part of [req.region, req.service, 'aws4_request']) key = hmac(key, part);
  const signature = createHmac('sha256', key).update(toSign).digest('hex');
  const { host: _host, ...rest } = headers;
  return {
    ...rest,
    authorization: `AWS4-HMAC-SHA256 Credential=${req.accessKeyId}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}`,
  };
}
