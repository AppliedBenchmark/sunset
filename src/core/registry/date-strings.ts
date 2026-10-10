// Parses the date strings providers write in their lifecycle tables. Only the verified
// formats are accepted; anything else is a parse failure, which the updater reports as an issue
// rather than guessing.
import { parseIsoDate } from '../dates.ts';
import type { DateQualifier, IsoDate } from '../types.ts';

export type ParsedDateString =
  | {
      kind: 'date';
      iso: IsoDate;
      qualifier: DateQualifier /** The date itself, without qualifier words. */;
      date: string;
    }
  | { kind: 'none' }
  | { kind: 'invalid' };

const MONTHS: Record<string, number> = {
  january: 1,
  february: 2,
  march: 3,
  april: 4,
  may: 5,
  june: 6,
  july: 7,
  august: 8,
  september: 9,
  october: 10,
  november: 11,
  december: 12,
};
for (const [name, number] of Object.entries(MONTHS)) MONTHS[name.slice(0, 3)] = number;
MONTHS.sept = 9;

/** "No date" markers. Compared case-insensitively, after trimming a final period. */
const NO_DATE = new Set([
  'to be announced',
  'no shutdown date announced',
  'no retirement date announced',
  'n/a',
  '—',
  '',
]);

// Qualifier words around the date. "at earliest", "sooner than", "or later" and "no earlier
// than" all mean the provider promises only that the model won't retire before the date.
const PREFIXES = [
  /^at (?:the )?earliest:?\s+/i,
  /^(?:not|no) sooner than:?\s+/i,
  /^no earlier than:?\s+/i,
];
const SUFFIXES = [/,?\s+or later$/i, /,?\s+at (?:the )?earliest$/i];

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_DAY_YEAR = /^([A-Za-z]+)\.? (\d{1,2}), (\d{4})$/;

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** `YYYY-MM-DD`, `Month D, YYYY` or `Mon D, YYYY`, as an ISO date. */
export function parsePlainDate(text: string): IsoDate | null {
  if (ISO.test(text)) return parseIsoDate(text);
  const match = MONTH_DAY_YEAR.exec(text);
  if (!match) return null;
  const month = MONTHS[(match[1] as string).toLowerCase()];
  if (month === undefined) return null;
  return parseIsoDate(`${match[3]}-${pad(month)}-${pad(Number(match[2]))}`);
}

/**
 * Parses one date cell or phrase:
 * - `YYYY-MM-DD`, `Month D, YYYY`, `Mon D, YYYY`
 * - `at earliest …`, `Not sooner than …`, `No sooner than …`, `No earlier than …`, `… or later`
 *   (qualifier `no_earlier_than`)
 * - a "no date" marker (`To be announced`, `No shutdown date announced`, `N/A`, `—`, …)
 */
export function parseDateString(raw: string): ParsedDateString {
  let text = raw.replace(/\s+/g, ' ').trim().replace(/\.$/, '');
  if (NO_DATE.has(text.toLowerCase())) return { kind: 'none' };
  let qualifier: DateQualifier = 'exact';
  for (const pattern of PREFIXES) {
    if (pattern.test(text)) {
      text = text.replace(pattern, '');
      qualifier = 'no_earlier_than';
    }
  }
  for (const pattern of SUFFIXES) {
    if (pattern.test(text)) {
      text = text.replace(pattern, '');
      qualifier = 'no_earlier_than';
    }
  }
  const iso = parsePlainDate(text);
  return iso === null ? { kind: 'invalid' } : { kind: 'date', iso, qualifier, date: text };
}
