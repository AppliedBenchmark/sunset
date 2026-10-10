// Clock adapters. The scan only ever sees a UTC calendar date.

import { parseIsoDate } from '../core/dates.ts';
import type { Clock } from '../core/ports.ts';
import type { IsoDate } from '../core/types.ts';

export const systemClock: Clock = {
  today: () => new Date().toISOString().slice(0, 10) as IsoDate,
};

/** A clock stuck on `date` (`--today YYYY-MM-DD`, tests). */
export function fixedClock(date: string): Clock {
  const today = parseIsoDate(date);
  if (!today) throw new Error(`not a valid date (YYYY-MM-DD): ${date}`);
  return { today: () => today };
}
