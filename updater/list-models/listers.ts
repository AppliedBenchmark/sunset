// The providers' list-models APIs. Each lister is optional: it runs only when its
// credentials are set. Responses are untrusted input, so only the fields named here are read.
import { sigV4Headers } from './sigv4.ts';

export interface ListedModel {
  id: string;
  /** The documented end date, when the API has one (ISO date), or null when it says none. */
  end_date?: string | null;
  /** Mistral's `deprecation_replacement_model`. */
  replacement?: string | null;
  /** Bedrock's `modelLifecycle.status` (`ACTIVE` or `LEGACY`). */
  lifecycle?: string;
}

export interface Lister {
  /** Also the issue key: `list-models:<name>`. */
  name: 'openai' | 'anthropic' | 'gemini-api' | 'mistral' | 'openrouter' | 'bedrock';
  /** Environment variables the lister needs; it is skipped when one is missing. */
  env: string[];
  /** What the lister compares (shown in the issue). */
  fields: string;
  list(env: Record<string, string>, fetchImpl: typeof fetch): Promise<ListedModel[]>;
}

const TIMEOUT_MS = 30_000;
const MAX_PAGES = 50;

async function getJson(
  fetchImpl: typeof fetch,
  url: string,
  headers: Record<string, string>,
): Promise<unknown> {
  const response = await fetchImpl(url, {
    headers: { 'user-agent': 'sunset-registry-updater', ...headers },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`${new URL(url).host}: HTTP ${response.status}`);
  return response.json();
}

/** A date-only ISO string from an ISO timestamp, a date or Unix seconds; null otherwise. */
export function toIsoDate(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return new Date(value * 1000).toISOString().slice(0, 10);
  }
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value)) return value.slice(0, 10);
  return null;
}

const str = (value: unknown): string | null => (typeof value === 'string' ? value : null);

export const LISTERS: readonly Lister[] = [
  {
    name: 'openai',
    env: ['OPENAI_API_KEY'],
    fields: '`shutdown_date`',
    async list(env, fetchImpl) {
      const body = (await getJson(fetchImpl, 'https://api.openai.com/v1/models', {
        authorization: `Bearer ${env.OPENAI_API_KEY}`,
      })) as { data?: { id?: unknown; shutdown_date?: unknown }[] };
      return (body.data ?? []).flatMap((m) => {
        const id = str(m.id);
        return id ? [{ id, end_date: toIsoDate(m.shutdown_date) }] : [];
      });
    },
  },
  {
    name: 'anthropic',
    env: ['ANTHROPIC_API_KEY'],
    fields: 'presence only',
    async list(env, fetchImpl) {
      const out: ListedModel[] = [];
      let after: string | null = null;
      for (let page = 0; page < MAX_PAGES; page++) {
        const url = `https://api.anthropic.com/v1/models?limit=1000${after ? `&after_id=${encodeURIComponent(after)}` : ''}`;
        const body = (await getJson(fetchImpl, url, {
          'x-api-key': env.ANTHROPIC_API_KEY as string,
          'anthropic-version': '2023-06-01',
        })) as { data?: { id?: unknown }[]; has_more?: unknown; last_id?: unknown };
        for (const m of body.data ?? []) {
          const id = str(m.id);
          if (id) out.push({ id });
        }
        after = str(body.last_id);
        if (body.has_more !== true || !after) break;
      }
      return out;
    },
  },
  {
    name: 'gemini-api',
    env: ['GEMINI_API_KEY'],
    fields: 'presence only',
    async list(env, fetchImpl) {
      const out: ListedModel[] = [];
      let token: string | null = null;
      for (let page = 0; page < MAX_PAGES; page++) {
        const url = `https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000${token ? `&pageToken=${encodeURIComponent(token)}` : ''}`;
        const body = (await getJson(fetchImpl, url, {
          'x-goog-api-key': env.GEMINI_API_KEY as string,
        })) as { models?: { name?: unknown }[]; nextPageToken?: unknown };
        for (const m of body.models ?? []) {
          const name = str(m.name);
          if (name) out.push({ id: name.replace(/^models\//, '') });
        }
        token = str(body.nextPageToken);
        if (!token) break;
      }
      return out;
    },
  },
  {
    name: 'mistral',
    env: ['MISTRAL_API_KEY'],
    fields: '`deprecation` and `deprecation_replacement_model`',
    async list(env, fetchImpl) {
      const body = (await getJson(fetchImpl, 'https://api.mistral.ai/v1/models', {
        authorization: `Bearer ${env.MISTRAL_API_KEY}`,
      })) as {
        data?: { id?: unknown; deprecation?: unknown; deprecation_replacement_model?: unknown }[];
      };
      return (body.data ?? []).flatMap((m) => {
        const id = str(m.id);
        return id
          ? [
              {
                id,
                end_date: toIsoDate(m.deprecation),
                replacement: str(m.deprecation_replacement_model),
              },
            ]
          : [];
      });
    },
  },
  {
    name: 'openrouter',
    env: [],
    fields: '`expiration_date` of `<vendor>/<first-party ID>` slugs',
    async list(_env, fetchImpl) {
      const body = (await getJson(fetchImpl, 'https://openrouter.ai/api/v1/models', {})) as {
        data?: { id?: unknown; expiration_date?: unknown }[];
      };
      return (body.data ?? []).flatMap((m) => {
        const id = str(m.id);
        return id ? [{ id, end_date: toIsoDate(m.expiration_date) }] : [];
      });
    },
  },
  {
    name: 'bedrock',
    env: ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY'],
    fields: '`modelLifecycle` (status and `endOfLifeTime`)',
    async list(env, fetchImpl) {
      const region = env.AWS_REGION || 'us-east-1';
      const url = `https://bedrock.${region}.amazonaws.com/foundation-models`;
      const headers = sigV4Headers({
        method: 'GET',
        url,
        region,
        service: 'bedrock',
        accessKeyId: env.AWS_ACCESS_KEY_ID as string,
        secretAccessKey: env.AWS_SECRET_ACCESS_KEY as string,
        sessionToken: env.AWS_SESSION_TOKEN || undefined,
        now: new Date(),
      });
      const body = (await getJson(fetchImpl, url, headers)) as {
        modelSummaries?: {
          modelId?: unknown;
          modelLifecycle?: { status?: unknown; endOfLifeTime?: unknown };
        }[];
      };
      return (body.modelSummaries ?? []).flatMap((m) => {
        const id = str(m.modelId);
        if (!id) return [];
        const lifecycle = str(m.modelLifecycle?.status);
        return [
          {
            id,
            end_date: toIsoDate(m.modelLifecycle?.endOfLifeTime),
            ...(lifecycle ? { lifecycle } : {}),
          },
        ];
      });
    },
  },
];

/** The environment a lister needs, or null when something is missing (the lister is skipped). */
export function envFor(lister: Lister, env: NodeJS.ProcessEnv): Record<string, string> | null {
  const out: Record<string, string> = {};
  for (const name of [...lister.env, 'AWS_REGION', 'AWS_SESSION_TOKEN']) {
    const value = env[name];
    if (value) out[name] = value;
    else if (lister.env.includes(name)) return null;
  }
  return out;
}
