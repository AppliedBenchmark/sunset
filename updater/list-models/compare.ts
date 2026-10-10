// Compares a list-models response with the registry. It only ever reports: the
// registry comes from official pages, and an API listing is account-specific, so a difference is
// something for a human to look at, never a change.
import type { Platform, PlatformFormats, Registry, RegistryEntry } from '../../src/core/types.ts';
import type { ListedModel, Lister } from './listers.ts';

export interface Discrepancy {
  model: string;
  message: string;
}

/** Entries that should be callable: not retired, and not unverified. */
const live = (e: RegistryEntry) => e.status !== 'retired' && e.status !== 'unverified';

function byName(entries: RegistryEntry[]): Map<string, RegistryEntry[]> {
  const map = new Map<string, RegistryEntry[]>();
  for (const entry of entries) {
    for (const name of [entry.model_id, ...entry.aliases]) {
      map.set(name, [...(map.get(name) ?? []), entry]);
    }
  }
  return map;
}

/** The entry for every region: a region-scoped sibling has its own, regional, dates. */
const global = (entries: RegistryEntry[] | undefined) => entries?.find((e) => !e.regions?.length);

function compareDates(
  lister: Lister,
  model: ListedModel,
  entry: RegistryEntry,
  out: Discrepancy[],
): void {
  const date = model.end_date;
  if (date === undefined) return;
  if (date === null) {
    // Only OpenAI documents null as "not announced".
    if (lister.name === 'openai' && entry.retirement_date !== null && live(entry)) {
      out.push({
        model: model.id,
        message: `the API announces no shutdown date; the registry says ${entry.retirement_date}`,
      });
    }
    return;
  }
  if (date !== entry.retirement_date && date !== entry.deprecation_date) {
    out.push({
      model: model.id,
      message: `the API says ${date}; the registry says ${entry.retirement_date ?? 'no date'} (\`${entry.id}\`)`,
    });
  }
}

export function compareListing(
  lister: Lister,
  listed: readonly ListedModel[],
  registry: Registry,
  formats: PlatformFormats,
): Discrepancy[] {
  const out: Discrepancy[] = [];
  if (lister.name === 'openrouter') {
    for (const model of listed) {
      const [vendor, ...rest] = model.id.split('/');
      const id = rest.join('/');
      const platforms: readonly Platform[] = formats.openrouter.vendors[vendor ?? ''] ?? [];
      if (!id || model.end_date === undefined || model.end_date === null) continue;
      // OpenRouter serves a slug through any of its platforms (`google/` through the Gemini API
      // and Vertex AI), so one platform with the same date agrees.
      const entries = platforms.flatMap((platform) => {
        const entry = global(
          byName(registry.models.filter((e) => e.platform === platform)).get(id),
        );
        return entry ? [entry] : [];
      });
      if (entries.length && !entries.some((e) => e.retirement_date === model.end_date)) {
        const says = entries
          .map((e) => `${e.retirement_date ?? 'no date'} for \`${e.id}\``)
          .join(', ');
        out.push({
          model: model.id,
          message: `OpenRouter expires it on ${model.end_date}; the registry says ${says}`,
        });
      }
    }
    return out;
  }

  const platform = lister.name as Platform;
  const entries = registry.models.filter((e) => e.platform === platform);
  const names = byName(entries);
  const listedIds = new Set(listed.map((m) => m.id));
  for (const model of listed) {
    const entry = global(names.get(model.id));
    if (!entry) continue;
    if (entry.status === 'retired') {
      out.push({
        model: model.id,
        message: `still listed, but the registry says it retired on ${entry.retirement_date ?? '(no date)'}`,
      });
      continue;
    }
    compareDates(lister, model, entry, out);
    if (
      model.replacement &&
      !entry.recommended_replacements.some((r) => r.model_id === model.replacement)
    ) {
      out.push({
        model: model.id,
        message: `the API names the replacement \`${model.replacement}\`, which the registry doesn't list`,
      });
    }
    if (model.lifecycle === 'LEGACY' && entry.status === 'active') {
      out.push({ model: model.id, message: 'the API says LEGACY; the registry says active' });
    }
  }
  for (const entry of entries) {
    if (!live(entry) || entry.regions?.length) continue;
    if (![entry.model_id, ...entry.aliases].some((name) => listedIds.has(name))) {
      out.push({
        model: entry.model_id,
        message: `in the registry as ${entry.status}, but the API doesn't list it`,
      });
    }
  }
  return out.sort((a, b) => a.model.localeCompare(b.model) || a.message.localeCompare(b.message));
}

export function listingIssue(
  lister: Lister,
  found: Discrepancy[],
): { title: string; body: string } {
  return {
    title: `List-models check: ${lister.name} (${found.length} ${found.length === 1 ? 'difference' : 'differences'})`,
    body: [
      `## List-models check: ${lister.name}`,
      '',
      `The ${lister.name} list-models API disagrees with the registry (compared: ${lister.fields}). ` +
        'The check never changes the registry: listings depend on the account, and the registry follows ' +
        "the provider's lifecycle pages. Check each model against its source page; fix the registry or the " +
        'page parser if the page has changed. This issue closes when the listing agrees again.',
      '',
      ...found.slice(0, 200).map((d) => `- \`${d.model}\`: ${d.message}`),
      ...(found.length > 200 ? [`- … and ${found.length - 200} more`] : []),
    ].join('\n'),
  };
}
