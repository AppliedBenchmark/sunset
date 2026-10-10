// Registry validation. Pure: callers read the files and pass in what they have. The
// schema and key checks always run; source checks need `sources`, and excerpt checks need
// `snapshots` too (CI has both; a remote registry loaded at scan time has neither).
import { Ajv2020, type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js';
import schema from '../../../registry/schema.json' with { type: 'json' };
import { daysBetween, parseIsoDate } from '../dates.ts';
import type {
  IsoDate,
  PlatformFormats,
  Registry,
  RegistryEntry,
  Source,
  SourcesFile,
} from '../types.ts';
import { excerptInSnapshot, groundEntry, idAppears } from './grounding.ts';

export interface RegistryIssue {
  level: 'error' | 'warning';
  /** The entry or source the issue is about; null for the file as a whole. */
  subject: string | null;
  message: string;
}

export interface Validated<T> {
  /** The input, typed, when there are no errors. */
  value: T | null;
  issues: RegistryIssue[];
}

const SCHEMA_ID = schema.$id;
let ajv: Ajv2020 | null = null;
const validators = new Map<string, ValidateFunction>();

function validatorFor(ref: string): ValidateFunction {
  let validator = validators.get(ref);
  if (!validator) {
    if (!ajv) {
      ajv = new Ajv2020({ allErrors: true, strict: true });
      ajv.addKeyword('tsType');
      ajv.addSchema(schema);
    }
    validator = ajv.getSchema(`${SCHEMA_ID}${ref}`);
    if (!validator) throw new Error(`registry/schema.json has no ${ref}`);
    validators.set(ref, validator);
  }
  return validator;
}

function describeSchemaError(error: ErrorObject, data: unknown): RegistryIssue {
  const path = error.instancePath;
  // Name the entry or source by its id when the error is inside one.
  const match = /^\/(models|sources)\/(\d+)(\/.*)?$/.exec(path);
  let subject: string | null = null;
  let where = path || '/';
  if (match) {
    const list = (data as Record<string, unknown>)[match[1] as string];
    const item = Array.isArray(list) ? (list[Number(match[2])] as { id?: unknown }) : undefined;
    subject = typeof item?.id === 'string' ? item.id : `${match[1]}[${match[2]}]`;
    where = match[3] ?? '/';
  }
  const extra =
    error.keyword === 'additionalProperties'
      ? ` (\`${(error.params as { additionalProperty: string }).additionalProperty}\`)`
      : error.keyword === 'enum'
        ? ` (${(error.params as { allowedValues: unknown[] }).allowedValues.join(', ')})`
        : '';
  return { level: 'error', subject, message: `schema: ${where} ${error.message ?? ''}${extra}` };
}

function checkSchema(ref: string, data: unknown): RegistryIssue[] {
  const validate = validatorFor(ref);
  if (validate(data)) return [];
  // oneOf failures repeat every branch's errors; keep the first error per location.
  const seen = new Set<string>();
  const issues: RegistryIssue[] = [];
  for (const error of validate.errors ?? []) {
    if (seen.has(error.instancePath)) continue;
    seen.add(error.instancePath);
    issues.push(describeSchemaError(error, data));
  }
  return issues;
}

// ── IDs and URLs ─────────────────────────────────────────────────────────────────────────────

/** The entry `id`: `platform:model_id[@version][#regions]`, regions sorted and comma-separated. */
export function computeEntryId(
  entry: Pick<RegistryEntry, 'platform' | 'model_id' | 'version' | 'regions'>,
): string {
  const version = entry.version === null ? '' : `@${entry.version}`;
  const regions = entry.regions?.length ? `#${[...entry.regions].sort().join(',')}` : '';
  return `${entry.platform}:${entry.model_id}${version}${regions}`;
}

/**
 * True when `url` starts with one of the allowlisted prefixes: same scheme, host and port, and a
 * path that equals the prefix's path or continues it after a `/`.
 */
export function isAllowedUrl(url: string, allow: readonly string[]): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) return false;
  return allow.some((prefix) => {
    const p = new URL(prefix);
    if (p.host !== parsed.host) return false;
    if (p.pathname.endsWith('/')) return parsed.pathname.startsWith(p.pathname);
    return parsed.pathname === p.pathname || parsed.pathname.startsWith(`${p.pathname}/`);
  });
}

/** The URL the snapshot tool fetches for a source (for `github-dir`, the directory's raw prefix). */
export function fetchUrlOf(source: Source): string {
  const fetch = source.fetch;
  switch (fetch.kind) {
    case 'url':
      return fetch.url;
    case 'github-file':
      return `https://raw.githubusercontent.com/${fetch.repo}/${fetch.ref}/${fetch.path}`;
    case 'github-dir':
      return `https://raw.githubusercontent.com/${fetch.repo}/${fetch.ref}/${fetch.path}/`;
  }
}

// ── Aliases ──────────────────────────────────────────────────────────────────────────────────

// A pinned snapshot suffix after the alias: a date, an Anthropic/Vertex date, an MMDD or a 3-digit
// version.
const SNAPSHOT_SUFFIX = /^(?:[-@](?:\d{4}-\d{2}-\d{2}|\d{8}|\d{4}|\d{3}))+$/;

/**
 * True when an alias looks like a floating alias (one that moves to newer models), which belongs
 * in its own entry: `*-latest`, or the model ID without its snapshot suffix (`gpt-4o` for
 * `gpt-4o-2024-08-06`).
 */
export function looksFloating(alias: string, modelId: string): boolean {
  if (/(?:^|[-.:])latest$/.test(alias)) return true;
  return modelId.startsWith(alias) && SNAPSHOT_SUFFIX.test(modelId.slice(alias.length));
}

// ── Files ────────────────────────────────────────────────────────────────────────────────────

export function validateFormats(data: unknown): Validated<PlatformFormats> {
  const issues = checkSchema('#/$defs/PlatformFormats', data);
  return { value: issues.length ? null : (data as PlatformFormats), issues };
}

export function validateSources(data: unknown): Validated<SourcesFile> {
  const issues = checkSchema('#/$defs/SourcesFile', data);
  if (issues.length) return { value: null, issues };
  const file = data as SourcesFile;
  const seen = new Set<string>();
  for (const source of file.sources) {
    const error = (message: string) => issues.push({ level: 'error', subject: source.id, message });
    if (seen.has(source.id)) error('duplicate source id');
    seen.add(source.id);
    if (!source.id.startsWith(`${source.provider}/`)) {
      error(`the id must start with the provider, \`${source.provider}/\``);
    }
    const allow = file.providers[source.provider]?.allow;
    if (!allow) {
      error(`provider \`${source.provider}\` has no allowlist`);
      continue;
    }
    if (!isAllowedUrl(source.url, allow)) error(`url ${source.url} is not on the allowlist`);
    const fetchUrl = fetchUrlOf(source);
    if (!isAllowedUrl(fetchUrl, allow)) error(`fetch URL ${fetchUrl} is not on the allowlist`);
    if (source.markup && !isAllowedUrl(source.markup.url, allow)) {
      error(`markup URL ${source.markup.url} is not on the allowlist`);
    }
  }
  return { value: issues.some((i) => i.level === 'error') ? null : file, issues };
}

/**
 * Checks what sources say about their whole page against the snapshots: the `page_qualifier`
 * excerpt and the `models` IDs must appear on the page.
 */
export function validatePageFacts(
  sources: SourcesFile,
  snapshots: ReadonlyMap<string, string>,
): RegistryIssue[] {
  const issues: RegistryIssue[] = [];
  for (const source of sources.sources) {
    const snapshot = snapshots.get(source.id);
    if (source.page_qualifier && snapshot !== undefined) {
      if (!excerptInSnapshot(source.page_qualifier.excerpt, snapshot)) {
        issues.push({
          level: 'error',
          subject: source.id,
          message: 'page_qualifier.excerpt is not in the snapshot',
        });
      }
    }
    for (const id of source.models ?? []) {
      if (snapshot !== undefined && !idAppears(id, snapshot)) {
        issues.push({
          level: 'error',
          subject: source.id,
          message: `model \`${id}\` is not in the snapshot`,
        });
      }
    }
  }
  return issues;
}

export interface RegistryContext {
  /** Enables the source checks. */
  sources?: SourcesFile;
  /** Normalized snapshot text by source id. Enables the excerpt checks (needs `sources`). */
  snapshots?: ReadonlyMap<string, string>;
  /** Enables the `verified_on` check. */
  today?: IsoDate;
}

export function validateRegistry(
  data: unknown,
  context: RegistryContext = {},
): Validated<Registry> {
  const issues = checkSchema('#', data);
  if (issues.length) return { value: null, issues };
  const registry = data as Registry;
  const sources = new Map(context.sources?.sources.map((s) => [s.id, s]));

  // One at a time: `push(...)` overflows the stack with a few hundred thousand issues.
  for (const entry of registry.models) {
    for (const issue of checkEntry(entry, context, sources)) issues.push(issue);
  }
  for (const issue of checkKeys(registry.models)) issues.push(issue);
  return { value: issues.some((i) => i.level === 'error') ? null : registry, issues };
}

/**
 * The errors of one entry on its own: the schema, and every check that doesn't need another entry,
 * the sources or the snapshots.
 */
export function entryErrors(item: unknown): RegistryIssue[] {
  const id = (item as { id?: unknown } | null)?.id;
  const subject = typeof id === 'string' ? id : null;
  const schemaIssues = checkSchema('#/$defs/RegistryEntry', item);
  if (schemaIssues.length) return schemaIssues.map((issue) => ({ ...issue, subject }));
  return checkEntry(item as RegistryEntry, {}, new Map()).filter((i) => i.level === 'error');
}

function checkEntry(
  entry: RegistryEntry,
  context: RegistryContext,
  sources: ReadonlyMap<string, Source>,
): RegistryIssue[] {
  const issues: RegistryIssue[] = [];
  const subject = entry.id;
  const error = (message: string) => issues.push({ level: 'error', subject, message });
  const warning = (message: string) => issues.push({ level: 'warning', subject, message });

  const expected = computeEntryId(entry);
  if (entry.id !== expected) error(`id must be \`${expected}\` (computed from the entry)`);
  if (entry.regions && entry.regions.join(',') !== [...entry.regions].sort().join(',')) {
    error('regions must be sorted');
  }

  // Versions: Azure deployments are matched on (name, version), so Azure entries need one.
  if (entry.platform === 'azure-openai' && entry.version === null) {
    error('azure-openai entries need a version');
  }
  if (entry.platform !== 'azure-openai' && entry.version !== null) {
    error('only azure-openai entries have a version');
  }

  // Dates.
  for (const field of ['deprecation_date', 'retirement_date', 'verified_on'] as const) {
    const value = entry[field];
    if (value !== null && parseIsoDate(value) === null) error(`${field} ${value} is not a date`);
  }
  if (
    entry.deprecation_date !== null &&
    entry.retirement_date !== null &&
    entry.deprecation_date > entry.retirement_date
  ) {
    error(
      `deprecation_date ${entry.deprecation_date} is after retirement_date ${entry.retirement_date}`,
    );
  }
  // One day of slack: `today` is a UTC date, and contributors east of UTC are a day ahead.
  if (context.today && daysBetween(context.today, entry.verified_on) > 1) {
    error(`verified_on ${entry.verified_on} is in the future`);
  }

  // Status.
  const hasDate = entry.deprecation_date !== null || entry.retirement_date !== null;
  if ((entry.status === 'retired' || entry.status === 'deprecated') && !hasDate) {
    error(`a ${entry.status} entry needs a date; without one it must be unverified`);
  }
  if (entry.source_excerpt === null) {
    if (entry.status !== 'unverified') error('only unverified entries may omit source_excerpt');
    if (hasDate || entry.recommended_replacements.length) {
      error('dates and replacements need a source_excerpt that supports them');
    }
  }

  // Replacements.
  if (entry.drop_in && entry.recommended_replacements.length === 0) {
    error('drop_in is true but there is no replacement');
  }
  for (const r of entry.recommended_replacements) {
    if (r.platform === entry.platform && r.model_id === entry.model_id) {
      error('the entry lists itself as a replacement');
    }
  }

  // Aliases.
  for (const alias of entry.aliases) {
    if (alias === entry.model_id) error(`alias \`${alias}\` repeats the model ID`);
    else if (looksFloating(alias, entry.model_id)) {
      warning(
        `alias \`${alias}\` looks like a floating alias; floating aliases need their own entry`,
      );
    }
  }

  // Source: an allowlisted page with a committed snapshot.
  if (context.sources) {
    const source = sources.get(entry.source);
    if (!source) {
      error(`source \`${entry.source}\` is not in registry/sources.yaml`);
    } else {
      if (!source.platforms.includes(entry.platform)) {
        error(`source \`${source.id}\` doesn't cover platform ${entry.platform}`);
      }
      if (entry.source_url !== source.url) {
        error(`source_url must be the source's url, ${source.url}`);
      }
      const allow = context.sources.providers[source.provider]?.allow ?? [];
      if (!isAllowedUrl(entry.source_url, allow)) {
        error(`source_url ${entry.source_url} is not on the ${source.provider} allowlist`);
      }
    }

    // Excerpt: word for word in the snapshot.
    if (context.snapshots && entry.source_excerpt !== null) {
      const snapshot = context.snapshots.get(entry.source);
      if (snapshot === undefined) {
        error(`there is no snapshot for source \`${entry.source}\``);
      } else if (!excerptInSnapshot(entry.source_excerpt, snapshot)) {
        error(`source_excerpt is not in the snapshot of \`${entry.source}\``);
      }
      const page = { qualifier: source?.page_qualifier?.qualifier, models: source?.models };
      for (const problem of groundEntry(entry, entry.source_excerpt, page)) {
        issues.push({ level: problem.level, subject, message: problem.message });
      }
    }
  }
  return issues;
}

/** Duplicate ids, alias collisions, region overlaps and dangling replacements. */
function checkKeys(models: readonly RegistryEntry[]): RegistryIssue[] {
  const issues: RegistryIssue[] = [];
  const byId = new Map<string, RegistryEntry>();
  // (platform, name) → the model key, `model_id@version`, that owns the name.
  const names = new Map<string, { key: string; entry: RegistryEntry }>();
  // Entries for the same model in different regions.
  const siblings = new Map<string, RegistryEntry[]>();

  for (const entry of models) {
    if (byId.has(entry.id)) {
      issues.push({ level: 'error', subject: entry.id, message: 'duplicate id' });
    }
    byId.set(entry.id, entry);
    const key = `${entry.model_id}@${entry.version ?? ''}`;
    const group = `${entry.platform}:${key}`;
    siblings.set(group, [...(siblings.get(group) ?? []), entry]);
    for (const name of [entry.model_id, ...entry.aliases]) {
      const owner = names.get(`${entry.platform}:${name}`);
      if (owner && owner.key !== key) {
        // Azure entries share a model name across versions; only aliases may not collide there.
        const sameAzureModel =
          entry.platform === 'azure-openai' && owner.entry.model_id === entry.model_id;
        if (!sameAzureModel) {
          issues.push({
            level: 'error',
            subject: entry.id,
            message: `\`${name}\` is already a model ID or alias of ${owner.entry.id}`,
          });
        }
      } else if (!owner) {
        names.set(`${entry.platform}:${name}`, { key, entry });
      }
    }
  }

  for (const group of siblings.values()) {
    if (group.length < 2) continue;
    if (group.filter((e) => !e.regions?.length).length > 1) {
      // Reported as a duplicate id already.
      continue;
    }
    const seen = new Map<string, string>();
    for (const entry of group) {
      for (const region of entry.regions ?? []) {
        const other = seen.get(region);
        if (other) {
          issues.push({
            level: 'error',
            subject: entry.id,
            message: `region ${region} is also listed by ${other}`,
          });
        }
        seen.set(region, entry.id);
      }
    }
  }

  for (const entry of models) {
    for (const r of entry.recommended_replacements) {
      if (!names.has(`${r.platform}:${r.model_id}`)) {
        issues.push({
          level: 'warning',
          subject: entry.id,
          message: `replacement \`${r.model_id}\` (${r.platform}) is not in the registry`,
        });
      }
    }
  }
  return issues;
}
