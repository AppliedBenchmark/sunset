// Platform ID formats: expands registry entries into every form an ID can be written
// in, and classifies the context of a match (Bedrock profile or ARN, Vertex resource path,
// a model router's slug, a library's prefix), which narrows the platforms it can refer to.
import { own } from '../own.ts';
import type { ExpandedForm } from '../ports.ts';
import type {
  Platform,
  PlatformFormats,
  ReferenceContext,
  Registry,
  RegistryEntry,
  Router,
} from '../types.ts';

/**
 * Every form an entry's IDs can take, except Azure: Azure deployments are matched on (model name,
 * version) by their own detector, because the model name alone (`gpt-4o`) is ambiguous.
 *
 * - each entry's `model_id` and `aliases`
 * - Bedrock: each of those again with every geo prefix (`us.`, `eu.`, …); no `-v1:0` suffix is assumed
 */
export function expandForms(
  registry: Registry,
  formats: PlatformFormats,
): Map<string, ExpandedForm[]> {
  const forms = new Map<string, ExpandedForm[]>();
  const add = (form: string, value: ExpandedForm): void => {
    const list = forms.get(form);
    if (!list) forms.set(form, [value]);
    else if (!list.some((f) => f.entry === value.entry && f.geo === value.geo)) list.push(value);
  };
  for (const entry of registry.models) {
    if (entry.platform === 'azure-openai') continue;
    for (const id of [entry.model_id, ...entry.aliases]) {
      add(id, { entry, geo: null });
      if (entry.platform === 'bedrock') {
        for (const geo of formats.bedrock.geo_prefixes) add(`${geo}.${id}`, { entry, geo });
      }
    }
  }
  return forms;
}

/** Azure entries keyed by model name (`model_id` and aliases). */
export function azureIndex(registry: Registry): Map<string, RegistryEntry[]> {
  const index = new Map<string, RegistryEntry[]>();
  for (const entry of registry.models) {
    if (entry.platform !== 'azure-openai') continue;
    for (const name of [entry.model_id, ...entry.aliases]) {
      const list = index.get(name) ?? [];
      if (!list.includes(entry)) list.push(entry);
      index.set(name, list);
    }
  }
  return index;
}

/** How far back from a match the context patterns look. ARNs and resource paths are short. */
const LOOKBEHIND = 256;

const VERTEX_PATH =
  /(?:projects\/[^/\s"'`]+\/locations\/[^/\s"'`]+\/)?publishers\/([A-Za-z0-9_-]+)\/models\/$/;
/** The resource type of a Bedrock ARN, which ends right before the ID. */
const ARN_RESOURCE = /(?:^|[^A-Za-z0-9_.-])(foundation-model|inference-profile)\/$/;
/**
 * The whole ARN, `arn:<partition>:bedrock:<region>:<account>:<resource>/`, for its partition. The
 * region and the account may be empty, `*` or placeholders such as `{region}` and
 * `${AWS::AccountId}`; so may the partition, which then isn't checked.
 */
const ARN =
  /arn:([a-z-]+|\$?\{[^}]*\}):bedrock:(?:\$?\{[^}]*\}|[^:\s"'`{}$])*:(?:\$?\{[^}]*\}|[^:\s"'`{}$])*:(?:foundation-model|inference-profile)\/$/;
/** Gemini API model names and REST paths: `models/gemini-2.0-flash`, `/v1beta/models/…`. */
const MODELS_PATH = /(?:^|[^A-Za-z0-9_.-])models\/$/;
/** The Bedrock runtime API: `/model/<id>/invoke`, `/model/<id>/converse`. */
const BEDROCK_RUNTIME_PATH = /(?:^|\/)model\/$/;
const BEDROCK_RUNTIME_ACTION = /^\/(?:invoke|converse)/;
/** Azure OpenAI's REST path names a deployment: `/openai/deployments/<deployment>/…`. */
const AZURE_DEPLOYMENT_PATH = /openai\/deployments\/$/;
const OPAQUE_ARN =
  /arn:[a-z-]+:bedrock:[a-z0-9-]*:\d*:(?:application-inference-profile|provisioned-model)\/[A-Za-z0-9._-]+/g;

/**
 * A character of a prefix before an ID: `bedrock/converse/`, `anthropic:messages:`. Letters and
 * digits of any script are read too, so that `éopenai:` is an unknown prefix rather than `openai:`.
 */
export const PREFIX_CHARACTER = /[\p{L}\p{M}\p{N}_./:-]/u;
const PREFIX = /^(?:[A-Za-z0-9_.-]+[/:])+$/;
const SEGMENT = /([A-Za-z0-9_.-]+)([/:])/g;
/**
 * The key of a placeholder whose default follows: Spring's `${key:` (also Quarkus and Micronaut),
 * the shell's and Compose's `${NAME:-` and `${NAME-`.
 */
const PLACEHOLDER_KEY = /^(?:[A-Za-z0-9_.-]+:-?|[A-Za-z_][A-Za-z0-9_]*-)/;
/**
 * Prefixes that leave the choice to what follows: LiteLLM's proxy, LiteLLM itself (the OpenAI
 * Agents SDK's `litellm/`, Pydantic AI's `litellm:`), and the routers' own segments.
 */
const PASS_THROUGH = new Set(['litellm_proxy', 'litellm', 'openrouter', 'vercel_ai_gateway']);
/**
 * The segment that names a router before `<vendor>/<id>`: `openrouter/`, LiteLLM's
 * `vercel_ai_gateway/`.
 */
const ROUTE_SEGMENTS: Readonly<Record<string, Router>> = {
  openrouter: 'openrouter',
  vercel_ai_gateway: 'vercel-ai-gateway',
};
/** How messages name each router. */
export const ROUTER_NAMES: Readonly<Record<Router, string>> = {
  openrouter: 'OpenRouter',
  'vercel-ai-gateway': 'the Vercel AI Gateway',
};

/** A router's vendor slugs → the platforms whose IDs its slugs reuse. */
function routerVendors(formats: PlatformFormats, router: Router): Record<string, Platform[]> {
  return (router === 'openrouter' ? formats.openrouter : formats.vercel_ai_gateway)?.vendors ?? {};
}

/** The router a context's slug goes through, or null. */
export function routerOf(context: ReferenceContext): Router | null {
  return context.kind === 'openrouter' || context.kind === 'vercel-ai-gateway'
    ? context.kind
    : null;
}

interface Segment {
  name: string;
  separator: string;
}

/**
 * The segments of the prefix that ends at `start` (`bedrock/`, `converse/`), when the prefix
 * starts a token: after a space, a quote or another delimiter. Null for the middle of a longer
 * path or a URL, whose `//` no segment can contain. In a placeholder's default
 * (`${MODEL:gpt-4o}`, `${MODEL:-bedrock/…}`) the placeholder's key isn't a segment.
 */
function prefixSegments(text: string, start: number): Segment[] | null {
  const limit = Math.max(0, start - LOOKBEHIND);
  let i = start;
  while (i > limit && PREFIX_CHARACTER.test(text[i - 1] as string)) i--;
  if (i === limit && limit > 0) return null;
  if (i >= 2 && text.startsWith('${', i - 2)) {
    i += PLACEHOLDER_KEY.exec(text.slice(i, start))?.[0].length ?? 0;
    if (i === start) return [];
  }
  const prefix = text.slice(i, start);
  if (!PREFIX.test(prefix)) return null;
  return [...prefix.matchAll(SEGMENT)].map((m) => ({
    name: m[1] as string,
    separator: m[2] as string,
  }));
}

/**
 * The context of a match, from the text around it and from the forms it can be. Returns null when
 * the match isn't a reference the literal detector reports: a segment of a path or a URL, an Azure
 * deployment name (the Azure detector reads those), a geo-prefixed ID in a `foundation-model/`
 * ARN, an unknown partition.
 *
 * Before a `/` or `:`, in order:
 *
 * 1. Resource paths: a Bedrock ARN or runtime API path, a Vertex `publishers/<p>/models/`
 *    path, Gemini's `models/`. A prefix that comes from a variable (`{provider}/`) allows any
 *    platform.
 * 2. `<publisher>/<id>-maas`: Vertex's name for an open model it serves
 *    (`meta/llama-3.3-70b-instruct-maas`).
 * 3. `<vendor>/<id>`, when the router's vendor's platform has the ID: a model router's slug,
 *    after the router's own segment (`openrouter/`) or, without one, when `router` says the text
 *    goes through a router. Elsewhere it's LiteLLM's form for calling the vendor's own API, read
 *    as a prefix (4).
 * 4. A library's prefix from formats.yaml, `gemini/` or `anthropic:messages:`, after any
 *    pass-through prefix (`litellm_proxy/`, `litellm/`, a router's segment): its platforms.
 *
 * Anything else before a `/` or `:` makes the match part of a path, and a `/` after it too. A
 * placeholder's key isn't a prefix: `${MODEL:gpt-4o}` is plain. An ID followed by `*` is a glob
 * (`openai/gpt-4*`, as in LiteLLM's wildcard routes), unless the `*` closes emphasis
 * (`*gpt-4*`, `**gpt-4**`).
 */
export function contextOf(
  text: string,
  start: number,
  end: number,
  forms: readonly ExpandedForm[],
  formats: PlatformFormats,
  router: () => Router | null = () => null,
): ReferenceContext | null {
  if (text[end] === '*' && text[end + 1] !== '*' && text[start - 1] !== '*') return null;
  const geo = forms[0]?.geo ?? null;
  const plain: ReferenceContext =
    geo === null ? { kind: 'literal' } : { kind: 'bedrock-profile', geo };
  const left = text[start - 1];
  if (left !== '/' && left !== ':') return text[end] === '/' ? null : plain;
  const before = text.slice(Math.max(0, start - LOOKBEHIND), start);

  const arn = ARN_RESOURCE.exec(before);
  if (arn) {
    const partition = ARN.exec(before)?.[1];
    if (
      partition &&
      !partition.includes('{') &&
      !formats.bedrock.arn_partitions.includes(partition)
    ) {
      return null;
    }
    const resource = arn[1] as 'foundation-model' | 'inference-profile';
    // Foundation models are never geo-prefixed; inference profiles always are.
    if ((resource === 'foundation-model') !== (geo === null)) return null;
    return { kind: 'bedrock-arn', resource, geo };
  }
  const vertex = VERTEX_PATH.exec(before);
  if (vertex) return { kind: 'vertex-path', publisher: vertex[1] as string };
  if (AZURE_DEPLOYMENT_PATH.test(before)) return null;
  if (BEDROCK_RUNTIME_PATH.test(before) && BEDROCK_RUNTIME_ACTION.test(text.slice(end, end + 9))) {
    return plain;
  }
  if (text[end] === '/') return null;
  if (MODELS_PATH.test(before)) return plain;
  // `{provider}/gpt-…`: the prefix comes from a variable, so every platform's dates apply.
  if (left === '/' && text[start - 2] === '}') return plain;

  const segments = prefixSegments(text, start);
  if (!segments) return null;
  let routed: Router | null = null;
  while (segments[0] && PASS_THROUGH.has(segments[0].name)) {
    routed = own(ROUTE_SEGMENTS, segments[0].name) ?? routed;
    segments.shift();
  }
  const [first] = segments;
  if (!first) return plain;
  const slug = segments.length === 1 && first.separator === '/' && geo === null;
  if (slug && text.endsWith('-maas', end) && forms.some((f) => f.entry.platform === 'vertex')) {
    return { kind: 'vertex-path', publisher: first.name };
  }
  const via = slug ? (routed ?? router()) : null;
  const vendor = via ? own(routerVendors(formats, via), first.name) : undefined;
  if (via && vendor && forms.some((f) => vendor.includes(f.entry.platform))) {
    return { kind: via, vendor: first.name };
  }
  const platforms = own(formats.prefixes ?? {}, first.name);
  if (!platforms || platforms.includes('azure-openai')) return null;
  if (geo !== null) return platforms.includes('bedrock') ? plain : null;
  return { kind: 'prefix', prefix: `${first.name}${first.separator}` };
}

/** The platforms a context allows, or null for any. */
export function platformsFor(
  context: ReferenceContext,
  formats: PlatformFormats,
): readonly Platform[] | null {
  switch (context.kind) {
    case 'literal':
      return null;
    case 'bedrock-profile':
    case 'bedrock-arn':
      return ['bedrock'];
    case 'vertex-path':
      return ['vertex'];
    case 'openrouter':
    case 'vercel-ai-gateway':
      return own(routerVendors(formats, context.kind), context.vendor) ?? [];
    case 'prefix':
      return own(formats.prefixes ?? {}, context.prefix.slice(0, -1)) ?? [];
    case 'azure-deployment':
      return ['azure-openai'];
  }
}

/** Opaque Bedrock ARNs: application inference profiles and provisioned models hide the model ID. */
export function findOpaqueArns(text: string): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = [];
  for (const m of text.matchAll(OPAQUE_ARN)) {
    out.push({ start: m.index, end: m.index + m[0].length });
  }
  return out;
}

/** A short label for a context, used in messages. */
export function describeContext(context: ReferenceContext): string | null {
  switch (context.kind) {
    case 'literal':
      return null;
    case 'bedrock-profile':
      return `Bedrock ${context.geo}. inference profile`;
    case 'bedrock-arn':
      return context.resource === 'inference-profile'
        ? `Bedrock inference-profile ARN (${context.geo}.)`
        : 'Bedrock foundation-model ARN';
    case 'vertex-path':
      return `Vertex, publisher ${context.publisher}`;
    case 'openrouter':
    case 'vercel-ai-gateway':
      return `via ${ROUTER_NAMES[context.kind]} (${context.vendor}/)`;
    case 'prefix':
      return `prefix ${context.prefix}`;
    case 'azure-deployment':
      return `Azure deployment (${context.source})`;
  }
}
