// Calendar dates in UTC. Every date in Sunset is a whole `YYYY-MM-DD` day; times never appear.
import type { IsoDate } from './types.ts';

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 86_400_000;

/** Parses a strict `YYYY-MM-DD` calendar date, or returns null (also for dates like 2099-02-30). */
export function parseIsoDate(text: string): IsoDate | null {
  const match = ISO_DATE.exec(text);
  if (!match) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  return text as IsoDate;
}

function toDayNumber(date: IsoDate): number {
  return Date.parse(`${date}T00:00:00Z`) / DAY_MS;
}

/** Whole days from `from` to `to`: positive when `to` is later. */
export function daysBetween(from: IsoDate, to: IsoDate): number {
  return toDayNumber(to) - toDayNumber(from);
}
