// What the updater's deterministic parsers produce, and the pure rules that turn a
// parsed row into a registry entry. Parsers live in updater/extract/; this module is shared with
// grounding (6.5) and the merge (6.6).
import type {
  DateQualifier,
  IsoDate,
  ModelStatus,
  Platform,
  RegistryEntry,
  Source,
} from '../types.ts';
import { parseDateString } from './date-strings.ts';
import {
  excerptInSnapshot,
  type GroundingProblem,
  groundEntry,
  type PageFacts,
} from './grounding.ts';
import { computeEntryId } from './validate.ts';

/** A date as the page writes it (`text`, a substring of the excerpt) and its ISO form. */
export interface PageDate {
  text: string;
  iso: IsoDate;
}

/**
 * What the page says about a model, before today's date is applied (see `statusFor`).
 * `unverified`: the page lists the model but its values can't be tied to one quote (for example
 * two rows with different dates), so the row carries no dates.
 */
export type PageState = 'available' | 'legacy' | 'deprecated' | 'retired' | 'unverified';

/** One model as a parser read it from one source page. */
export interface ExtractedRow {
  platform: Platform;
  /** Who makes the model (the entry's `provider`). */
  provider: string;
  model_id: string;
  /** azure-openai only. */
  version: string | null;
  /** Region scope; null for every region. */
  regions: string[] | null;
  state: PageState;
  deprecation: PageDate | null;
  retirement: PageDate | null;
  qualifier: DateQualifier;
  /** Replacement IDs on the same platform, each named in the excerpt. */
  replacements: string[];
  /** Verbatim text from the normalized page that carries every value above. */
  excerpt: string;
  /** Used only when the row creates a new entry; existing entries keep their notes. */
  notes: string | null;
}

/** The page a parser reads: the normalized snapshot text, plus state only the markup carries. */
export interface NormalizedPage {
  text: string;
  /**
   * For each table-row class named in the source's `markup`, the first cell of every row that has
   * it (the Gemini API page marks shut-down rows only with `row-gray`).
   */
  row_classes: Record<string, string[]>;
}

export interface ExtractContext {
  source: Source;
  today: IsoDate;
}

export interface Extraction {
  rows: ExtractedRow[];
  /**
   * Text the parser recognized as a model row but couldn't read, such as an unknown date
   * format. Any problem fails the source: an issue is opened and the registry stays unchanged.
   */
  problems: string[];
  /**
   * False for best-effort sources (DeepSeek's free-text change log): rows aren't proposed as
   * changes, and registry entries the parser didn't produce aren't reported as missing.
   */
  exhaustive: boolean;
}

/** Thrown when the page no longer has the structure a parser expects. */
export class LayoutChangedError extends Error {
  override readonly name = 'LayoutChangedError';
}

/**
 * The entry status for a row on `today`:
 * - a retirement date that has passed makes the model `retired`, unless the date is only the
 *   earliest possible one and the page still lists the model (Vertex's "not sooner
 *   than" dates, Gemini API rows not marked as shut down)
 * - otherwise the page's state decides
 */
export function statusFor(row: ExtractedRow, today: IsoDate): ModelStatus {
  if (row.state === 'unverified') return 'unverified';
  const passed = row.retirement !== null && row.retirement.iso <= today;
  if (passed && row.qualifier === 'no_earlier_than' && row.state !== 'retired') {
    return row.state === 'available' ? 'active' : row.state;
  }
  if (passed) return 'retired';
  return row.state === 'available' ? 'active' : row.state;
}

/** The registry entry a row stands for, as a new entry. */
export function rowToEntry(row: ExtractedRow, source: Source, today: IsoDate): RegistryEntry {
  const unverified = row.state === 'unverified';
  const entry: RegistryEntry = {
    id: computeEntryId(row),
    provider: row.provider,
    platform: row.platform,
    model_id: row.model_id,
    version: row.version,
    ...(row.regions?.length ? { regions: [...row.regions].sort() } : {}),
    aliases: [],
    status: statusFor(row, today),
    deprecation_date: unverified ? null : (row.deprecation?.iso ?? null),
    retirement_date: unverified ? null : (row.retirement?.iso ?? null),
    retirement_date_qualifier: row.qualifier,
    recommended_replacements: unverified
      ? []
      : row.replacements.map((model_id) => ({ model_id, platform: row.platform })),
    drop_in: false,
    source: source.id,
    source_url: source.url,
    source_excerpt: row.excerpt,
    verified_on: today,
    notes: row.notes,
  };
  return entry;
}

/**
 * Grounding for a parsed row, stricter than the validator's check of an entry:
 * - the excerpt is a word-for-word substring of the normalized page
 * - the model ID, version, dates and replacements appear in the excerpt
 * - each date string appears in the excerpt as written, and parses to the stored ISO date
 * - an `unverified` row carries no dates and no replacements
 * The updater never sets `drop_in`; `rowToEntry` always writes false.
 */
export function groundRow(
  row: ExtractedRow,
  page: string,
  source: Source,
  today: IsoDate,
): GroundingProblem[] {
  const problems: GroundingProblem[] = [];
  const error = (message: string) => problems.push({ level: 'error', message });
  if (!excerptInSnapshot(row.excerpt, page)) error("the excerpt isn't in the page");
  if (
    row.state === 'unverified' &&
    (row.deprecation || row.retirement || row.replacements.length)
  ) {
    error('an unverified row must not carry dates or replacements');
  }
  for (const [field, date] of [
    ['deprecation', row.deprecation],
    ['retirement', row.retirement],
  ] as const) {
    if (date === null) continue;
    if (!collapse(row.excerpt).includes(collapse(date.text))) {
      error(`the ${field} date "${date.text}" isn't in the excerpt`);
    }
    const parsed = parseDateString(date.text);
    if (parsed.kind !== 'date' || parsed.iso !== date.iso) {
      error(`the ${field} date "${date.text}" doesn't parse to ${date.iso}`);
    }
  }
  const facts: PageFacts = {
    qualifier: source.page_qualifier?.qualifier,
    models: source.models,
  };
  problems.push(...groundEntry(rowToEntry(row, source, today), row.excerpt, facts));
  return problems;
}

function collapse(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}
