// Merges one source's parsed rows into the registry. Pure: the caller reads and writes the files.
//
// - Every row is grounded first: its excerpt must be on the page and carry its values. One
//   ungrounded row fails the whole source.
// - New models are added. Values change only together with the row's grounded excerpt.
// - Nothing is ever deleted: an entry the page no longer lists is reported as missing.
// - Providers don't bring retired models back, so a change that takes an entry out of `retired`,
//   or drops its retirement date, is reported for a human instead of applied.
// - Human-owned fields are kept: aliases, notes and drop_in (drop_in is cleared when the
//   replacements it vouched for change; the updater never sets it).
// - An entry belongs to one source. A row for an entry another source owns is a problem, except on
//   a page that only adds models (ADDS_ONLY_PARSERS), where it is left to the owner.
// - An entry whose values are unchanged gets a new verified_on only once its source's newest
//   check is REVERIFY_AFTER_DAYS old, so the registry stays visibly fresh without a daily diff.
import { daysBetween } from '../src/core/dates.ts';
import {
  type ExtractedRow,
  type Extraction,
  groundRow,
  rowToEntry,
} from '../src/core/registry/extract.ts';
import { excerptInSnapshot, type GroundingProblem } from '../src/core/registry/grounding.ts';
import type { IsoDate, Registry, RegistryEntry, Source } from '../src/core/types.ts';

export const REVERIFY_AFTER_DAYS = 14;

/**
 * Parsers of pages that repeat models another page owns and only add the models no other source
 * lists: Azure's retired-models page repeats the retirement schedule's retired versions, and the
 * Gemini API release notes repeat shutdowns the deprecations table lists. The owner's page is the
 * one to quote for those models, so a row for an entry another source owns is left to it.
 */
export const ADDS_ONLY_PARSERS: ReadonlySet<string> = new Set([
  'azure-retired-models',
  'gemini-api-release-notes',
]);

export type ChangeKind = 'added' | 'updated' | 'excerpt' | 'reverified';

export interface Change {
  kind: ChangeKind;
  before: RegistryEntry | null;
  after: RegistryEntry;
  /** The fields whose values changed (`updated` only). */
  fields: string[];
}

export interface RejectedRow {
  row: ExtractedRow;
  problems: GroundingProblem[];
}

export interface SourceMerge {
  source: Source;
  changes: Change[];
  /** Entries of this source that the page no longer lists (exhaustive sources only). */
  missing: RegistryEntry[];
  /** Rows that failed grounding. Any rejected row means the source's changes aren't applied. */
  rejected: RejectedRow[];
  /** Duplicate row ids, rows owned by another source, and changes a human must confirm. */
  problems: string[];
  /** Rows of a best-effort source whose model isn't in the registry yet (to review by hand). */
  unreviewed: ExtractedRow[];
}

/** The values a row sets; equal values mean the row confirms the entry. */
const VALUE_FIELDS = [
  'status',
  'deprecation_date',
  'retirement_date',
  'retirement_date_qualifier',
  'recommended_replacements',
] as const;

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export interface MergeInput {
  registry: Registry;
  source: Source;
  extraction: Extraction;
  /** The normalized page the rows came from. */
  page: string;
  today: IsoDate;
}

/** Works out what one source's rows change; `applyMerges` writes the changes. */
export function mergeSource({
  registry,
  source,
  extraction,
  page,
  today,
}: MergeInput): SourceMerge {
  const result: SourceMerge = {
    source,
    changes: [],
    missing: [],
    rejected: [],
    problems: [],
    unreviewed: [],
  };
  const byId = new Map(registry.models.map((entry) => [entry.id, entry]));
  const own = registry.models.filter((entry) => entry.source === source.id);
  const newestCheck = own.reduce<IsoDate | null>(
    (max, e) => (max === null || e.verified_on > max ? e.verified_on : max),
    null,
  );
  const reverify = newestCheck !== null && daysBetween(newestCheck, today) >= REVERIFY_AFTER_DAYS;

  const seen = new Set<string>();
  for (const row of extraction.rows) {
    const proposed = rowToEntry(row, source, today);
    if (seen.has(proposed.id)) {
      result.problems.push(`the page lists \`${proposed.id}\` more than once`);
      continue;
    }
    seen.add(proposed.id);
    const problems = groundRow(row, page, source, today).filter((p) => p.level === 'error');
    if (problems.length) {
      result.rejected.push({ row, problems });
      continue;
    }
    const existing = byId.get(proposed.id);
    if (!extraction.exhaustive) {
      if (!existing) result.unreviewed.push(row);
      continue;
    }
    if (!existing) {
      result.changes.push({ kind: 'added', before: null, after: proposed, fields: [] });
      continue;
    }
    if (existing.source !== source.id) {
      if (!ADDS_ONLY_PARSERS.has(source.parser)) {
        result.problems.push(
          `\`${proposed.id}\` is also on this page, but its entry comes from ${existing.source}`,
        );
      }
      continue;
    }
    const fields = VALUE_FIELDS.filter((field) => !same(existing[field], proposed[field]));
    const unretire = unretiring(existing, proposed);
    if (unretire) {
      result.problems.push(unretire);
      continue;
    }
    if (fields.length) {
      const replacementsChanged = fields.includes('recommended_replacements');
      result.changes.push({
        kind: 'updated',
        before: existing,
        after: {
          ...existing,
          ...Object.fromEntries(fields.map((field) => [field, proposed[field]])),
          drop_in: replacementsChanged ? false : existing.drop_in,
          source_url: source.url,
          source_excerpt: proposed.source_excerpt,
          verified_on: today,
        },
        fields,
      });
    } else if (
      existing.source_excerpt === null ||
      !excerptInSnapshot(existing.source_excerpt, page)
    ) {
      result.changes.push({
        kind: 'excerpt',
        before: existing,
        after: { ...existing, source_excerpt: proposed.source_excerpt, verified_on: today },
        fields: [],
      });
    } else if (reverify && existing.verified_on < today) {
      result.changes.push({
        kind: 'reverified',
        before: existing,
        after: { ...existing, verified_on: today },
        fields: [],
      });
    }
  }
  if (extraction.exhaustive) {
    result.missing = own.filter((entry) => !seen.has(entry.id));
  }
  return result;
}

/**
 * Why a change that brings a retired model back needs a human, or null: a page that stops marking
 * models as shut down (a markup change, a parser bug) looks just like that.
 */
function unretiring(existing: RegistryEntry, proposed: RegistryEntry): string | null {
  if (existing.status === 'retired' && proposed.status !== 'retired') {
    return `\`${existing.id}\` would go from retired to ${proposed.status}; providers don't bring retired models back, so check the page and the parser`;
  }
  if (existing.retirement_date !== null && proposed.retirement_date === null) {
    return `\`${existing.id}\` would lose its retirement date ${existing.retirement_date}; check the page and the parser`;
  }
  return null;
}

/** True when a source merge can be applied: nothing was rejected and there were no problems. */
export function mergeIsClean(merge: SourceMerge): boolean {
  return merge.rejected.length === 0 && merge.problems.length === 0;
}

/**
 * Applies the changes of clean merges to a copy of the registry. New entries go after the last
 * entry of their source, or, for a source without entries yet, after the last entry of their
 * platform, so the file stays grouped by platform. If anything changed, `registry_version` goes up
 * by one and `generated_at` becomes midnight UTC of `today`: only the day, like `verified_on`,
 * because with the time of day every run's file would differ, even a rerun with the same changes.
 */
export function applyMerges(registry: Registry, merges: SourceMerge[], today: IsoDate): Registry {
  const changes = merges.filter(mergeIsClean).flatMap((m) => m.changes);
  if (changes.length === 0) return registry;
  const replaced = new Map(changes.filter((c) => c.before).map((c) => [c.after.id, c.after]));
  const models = registry.models.map((entry) => replaced.get(entry.id) ?? entry);
  for (const change of changes.filter((c) => c.kind === 'added')) {
    let last = models.findLastIndex((entry) => entry.source === change.after.source);
    if (last < 0) last = models.findLastIndex((entry) => entry.platform === change.after.platform);
    models.splice(last < 0 ? models.length : last + 1, 0, change.after);
  }
  return {
    ...registry,
    registry_version: registry.registry_version + 1,
    generated_at: `${today}T00:00:00Z`,
    models,
  };
}
