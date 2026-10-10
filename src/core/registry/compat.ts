// Reading a registry written for a newer Sunset. Released versions keep fetching the registry from
// `main` for as long as they're used, so within one schema_version the registry only grows: new
// optional fields, new platforms, statuses or date qualifiers, and values an older schema doesn't
// accept, such as a new kind of region name. A reader leaves out what it can't read instead of
// rejecting the whole file, which would keep it on its bundled copy for good. A fetched registry
// then gets the bundled copy's entry for every ID it lacks, so it never knows less than the release
// that reads it. A change that an older reader can't safely ignore needs a new schema_version.
import schema from '../../../registry/schema.json' with { type: 'json' };
import type { RegistryEntry } from '../types.ts';
import { entryErrors } from './validate.ts';

const KNOWN_KEYS = {
  top: new Set(Object.keys(schema.properties)),
  entry: new Set(Object.keys(schema.$defs.RegistryEntry.properties)),
  replacement: new Set(Object.keys(schema.$defs.Replacement.properties)),
};
const PLATFORMS: ReadonlySet<unknown> = new Set(schema.$defs.Platform.enum);
/** The fields whose values a newer version may add to. */
const KNOWN_VALUES = [
  ['platform', PLATFORMS],
  ['status', new Set<unknown>(schema.$defs.ModelStatus.enum)],
  ['retirement_date_qualifier', new Set<unknown>(schema.$defs.DateQualifier.enum)],
] as const;

type JsonObject = Record<string, unknown>;

const isObject = (value: unknown): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const pick = (object: JsonObject, keys: ReadonlySet<string>): JsonObject =>
  Object.fromEntries(Object.entries(object).filter(([key]) => keys.has(key)));

/** An entry left out, and why. */
export interface SkippedEntry {
  /** The entry's `id`, or its place in the list. */
  entry: string;
  reason: string;
}

/**
 * The part of a parsed registry that this version can read. Unknown fields are dropped, and so are
 * replacements on an unknown platform. An entry is left out when its platform, status or date
 * qualifier is unknown, or when it fails a check of its own (the schema, the computed `id`,
 * consistent dates). Checks across entries are left to the validator: leaving entries out never
 * makes those fail. A file that isn't a registry at all is passed through for the validator to
 * reject.
 */
export function readablePart(data: unknown): { data: unknown; skipped: SkippedEntry[] } {
  if (!isObject(data) || !Array.isArray(data.models)) return { data, skipped: [] };
  const skipped: SkippedEntry[] = [];
  const models: unknown[] = [];
  for (const [index, item] of data.models.entries()) {
    const name = isObject(item) && typeof item.id === 'string' ? item.id : `models[${index}]`;
    const entry = isObject(item) ? readable(item) : null;
    const reason = entry ? unreadable(entry) : 'not a mapping';
    if (reason) skipped.push({ entry: name, reason });
    else models.push(entry);
  }
  return { data: { ...pick(data, KNOWN_KEYS.top), models }, skipped };
}

/** The entry without the fields, and the replacements, this version doesn't know. */
function readable(item: JsonObject): JsonObject {
  const entry = pick(item, KNOWN_KEYS.entry);
  const replacements = entry.recommended_replacements;
  if (Array.isArray(replacements)) {
    const known = replacements.flatMap((r: unknown) => {
      if (!isObject(r)) return [r];
      return PLATFORMS.has(r.platform) ? [pick(r, KNOWN_KEYS.replacement)] : [];
    });
    // `drop_in` is about the replacements: with none left, nothing is dropped in.
    if (known.length === 0 && replacements.length > 0 && entry.drop_in === true) {
      entry.drop_in = false;
    }
    entry.recommended_replacements = known;
  }
  return entry;
}

/** Why this version can't read the entry, or null. */
function unreadable(entry: JsonObject): string | null {
  for (const [key, known] of KNOWN_VALUES) {
    if (entry[key] === undefined) return `no ${key}`;
    if (!known.has(entry[key])) return `unknown ${key} ${JSON.stringify(entry[key])}`;
  }
  return entryErrors(entry)[0]?.message ?? null;
}

/**
 * `data` with the entries of `bundled` whose `id` it lacks added at the end: the entries this
 * version can't read in their new form, as a registry only grows, and any removed by mistake.
 */
export function withBundled(
  data: unknown,
  bundled: readonly RegistryEntry[],
): { data: unknown; kept: RegistryEntry[] } {
  if (!isObject(data) || !Array.isArray(data.models)) return { data, kept: [] };
  const ids = new Set(data.models.map((item: unknown) => (isObject(item) ? item.id : undefined)));
  const kept = bundled.filter((entry) => !ids.has(entry.id));
  return { data: { ...data, models: [...data.models, ...kept] }, kept };
}
