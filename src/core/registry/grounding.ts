// Grounding: an entry's excerpt must appear word for word in the normalized snapshot of its
// source, and the entry's model ID, dates and replacements must appear in the excerpt. Values
// therefore can't be combined from different rows of a page.
import { escapeRegExp } from '../escape-regexp.ts';
import type { DateQualifier, IsoDate, RegistryEntry } from '../types.ts';
import { LEFT_BOUNDARY, RIGHT_BOUNDARY } from './matcher.ts';
import { collapseWhitespace } from './normalize.ts';

const MONTHS = [
  ['January', 'Jan'],
  ['February', 'Feb'],
  ['March', 'Mar'],
  ['April', 'Apr'],
  ['May'],
  ['June', 'Jun'],
  ['July', 'Jul'],
  ['August', 'Aug'],
  ['September', 'Sep', 'Sept'],
  ['October', 'Oct'],
  ['November', 'Nov'],
  ['December', 'Dec'],
] as const;

/** True when the excerpt appears in the snapshot, ignoring differences in whitespace. */
export function excerptInSnapshot(excerpt: string, snapshot: string): boolean {
  const needle = collapseWhitespace(excerpt);
  return needle !== '' && collapseWhitespace(snapshot).includes(needle);
}

/**
 * A regex matching the ways providers write a date: `2026-11-05`, `2026/11/05`, `11/5/2026`,
 * `November 5, 2026`, `Nov 5, 2026`, `Nov. 5th, 2026`, `5 November 2026`, …
 */
export function datePattern(date: IsoDate): RegExp {
  const [year, month, day] = date.split('-') as [string, string, string];
  const m = Number(month);
  const d = Number(day);
  const days = `0?${d}`;
  // Full names, and abbreviations with or without a period.
  const names = (MONTHS[m - 1] ?? []).flatMap((name, i) =>
    i === 0 ? [name] : [name, `${name}\\.`],
  );
  const monthName = `(?:${names.join('|')})`;
  const ordinal = '(?:st|nd|rd|th)?';
  const forms = [
    `${year}-${month}-${day}`,
    `${year}/${month}/${day}`,
    `0?${m}/${days}/${year}`,
    `${monthName} ${days}${ordinal},? ${year}`,
    `${days}${ordinal} ${monthName},? ${year}`,
  ];
  return new RegExp(`(?<![0-9A-Za-z])(?:${forms.join('|')})(?![0-9])`);
}

export function dateAppears(date: IsoDate, excerpt: string): boolean {
  return datePattern(date).test(collapseWhitespace(excerpt));
}

/**
 * True when `id` appears in the excerpt as a whole ID, with the scanner's boundary rules: not
 * inside a longer ID, and not followed by a Vertex `@version` or a Bedrock `:version`.
 */
export function idAppears(id: string, excerpt: string): boolean {
  return new RegExp(`${LEFT_BOUNDARY}${escapeRegExp(id)}${RIGHT_BOUNDARY}`, 'u').test(excerpt);
}

const NO_EARLIER_THAN = /(?:not|no) sooner than|no earlier than|or later|at (?:the )?earliest/i;

export interface GroundingProblem {
  level: 'error' | 'warning';
  message: string;
}

/** What the whole page says, as opposed to the excerpt (see Source in registry/schema.json). */
export interface PageFacts {
  /** A qualifier the page states once for all of its dates. */
  qualifier?: DateQualifier | undefined;
  /** The only models the page is about (a model card). */
  models?: readonly string[] | undefined;
}

/**
 * Checks that the entry's values are supported by its excerpt (not that the excerpt is in the
 * page).
 */
export function groundEntry(
  entry: RegistryEntry,
  excerpt: string,
  page: PageFacts = {},
): GroundingProblem[] {
  const problems: GroundingProblem[] = [];
  const names = [entry.model_id, ...entry.aliases];
  const pageIsAboutIt = names.some((name) => page.models?.includes(name));
  if (!pageIsAboutIt && !names.some((name) => idAppears(name, excerpt))) {
    problems.push({
      level: 'error',
      message: `the excerpt doesn't contain the model ID \`${entry.model_id}\`${entry.aliases.length ? ' or an alias' : ''}`,
    });
  }
  if (entry.version !== null && !idAppears(entry.version, excerpt)) {
    problems.push({
      level: 'error',
      message: `the excerpt doesn't contain the version \`${entry.version}\``,
    });
  }
  for (const field of ['deprecation_date', 'retirement_date'] as const) {
    const date = entry[field];
    if (date !== null && !dateAppears(date, excerpt)) {
      problems.push({ level: 'error', message: `the excerpt doesn't contain ${field} ${date}` });
    }
  }
  for (const replacement of entry.recommended_replacements) {
    if (!idAppears(replacement.model_id, excerpt)) {
      problems.push({
        level: 'error',
        message: `the excerpt doesn't contain the replacement \`${replacement.model_id}\``,
      });
    }
  }
  if (
    entry.retirement_date !== null &&
    entry.retirement_date_qualifier === 'no_earlier_than' &&
    page.qualifier !== 'no_earlier_than' &&
    !NO_EARLIER_THAN.test(excerpt)
  ) {
    problems.push({
      level: 'warning',
      message: "retirement_date_qualifier is no_earlier_than, but the excerpt doesn't say so",
    });
  }
  if (entry.drop_in && !/drop-in/i.test(excerpt)) {
    problems.push({
      level: 'warning',
      message: "drop_in is true, but the excerpt doesn't say drop-in",
    });
  }
  return problems;
}
