// The severity of a reference, from its registry entries and today's date. docs/rules.md describes
// the result for users.
import { daysBetween } from './dates.ts';
import type { IsoDate, Platform, RegistryEntry, RuleId, Severity } from './types.ts';

export const ERROR_DAYS = 30;
export const WARNING_DAYS = 90;

export interface Assessment {
  severity: Severity;
  rule: RuleId;
  /** Whole UTC days until retirement; negative once it has passed; null without a date. */
  daysLeft: number | null;
}

export interface SeverityOptions {
  /** Report `legacy` entries as notices. Off by default. */
  legacy: boolean;
}

/**
 * How a reference to `entry` is reported on `today`, or null if it isn't reported.
 *
 * | Case                                                    | Result                      |
 * |---------------------------------------------------------|-----------------------------|
 * | status `retired`, or retirement date ≤ today            | error   `model-retired`     |
 * | `no_earlier_than` date ≤ today (not `active`)           | error   `model-retiring`    |
 * | retires in < 30 days (any status)                       | error   `model-retiring`    |
 * | retires in < 90 days (any status)                       | warning `model-retiring`    |
 * | `deprecated`, retirement later or unknown               | notice  `model-deprecated`  |
 * | `unverified`                                            | notice  `model-unverified`  |
 * | `legacy`                                                | notice `model-legacy` if opted in, else null |
 * | `active`, no retirement within 90 days                  | null                        |
 *
 * `approximate` dates use the same thresholds; only the message differs. So do `no_earlier_than`
 * dates, except on `active` entries: a "not sooner than" date only says the model won't retire
 * before it, so while the provider still lists the model as active it is at most a warning, also
 * once the date has passed ("may be retired at any time").
 */
export function assess(
  entry: RegistryEntry,
  today: IsoDate,
  opts: SeverityOptions,
): Assessment | null {
  const daysLeft = entry.retirement_date ? daysBetween(today, entry.retirement_date) : null;
  if (
    entry.status === 'active' &&
    entry.retirement_date_qualifier === 'no_earlier_than' &&
    daysLeft !== null
  ) {
    return daysLeft < WARNING_DAYS
      ? { severity: 'warning', rule: 'model-retiring', daysLeft }
      : null;
  }
  if (entry.status === 'retired') return { severity: 'error', rule: 'model-retired', daysLeft };
  if (daysLeft !== null && daysLeft <= 0) {
    // A passed "no earlier than" date doesn't mean the model is gone, only that it may go any day.
    const rule =
      entry.retirement_date_qualifier === 'no_earlier_than' ? 'model-retiring' : 'model-retired';
    return { severity: 'error', rule, daysLeft };
  }
  if (daysLeft !== null && daysLeft < ERROR_DAYS) {
    return { severity: 'error', rule: 'model-retiring', daysLeft };
  }
  if (daysLeft !== null && daysLeft < WARNING_DAYS) {
    return { severity: 'warning', rule: 'model-retiring', daysLeft };
  }
  switch (entry.status) {
    case 'deprecated':
      return { severity: 'notice', rule: 'model-deprecated', daysLeft };
    case 'unverified':
      return { severity: 'notice', rule: 'model-unverified', daysLeft };
    case 'legacy':
      return opts.legacy ? { severity: 'notice', rule: 'model-legacy', daysLeft } : null;
    case 'active':
      return null;
  }
}

const RANK: Record<Severity, number> = { error: 0, warning: 1, notice: 2 };

/** Orders severities from most to least severe. */
export function compareSeverity(a: Severity, b: Severity): number {
  return RANK[a] - RANK[b];
}

export interface Assessed {
  entry: RegistryEntry;
  assessment: Assessment;
  /**
   * Platforms that share the ID but where it isn't an error. Set when an error was downgraded to a
   * warning because the platforms disagree; empty otherwise.
   */
  unaffected: Platform[];
}

/**
 * Picks the entry that decides a reference's severity when it has several candidates (other
 * regions, or other platforms sharing the ID): the most severe, then the earliest date.
 * Returns null if none of them is reported.
 *
 * Platforms that share an ID can disagree (`gemini-2.5-pro` retiring on Vertex but not on the
 * Gemini API), and the code usually doesn't say which one it calls. An error therefore stands
 * only if every candidate platform says error; otherwise it becomes a warning that names the
 * platforms where the ID isn't an error. Regions of one platform still take the earliest date.
 */
export function assessAll(
  entries: readonly RegistryEntry[],
  today: IsoDate,
  opts: SeverityOptions,
): Assessed | null {
  let best: { entry: RegistryEntry; assessment: Assessment } | null = null;
  const platformsWithError = new Set<Platform>();
  for (const entry of entries) {
    const assessment = assess(entry, today, opts);
    if (!assessment) continue;
    if (assessment.severity === 'error') platformsWithError.add(entry.platform);
    if (!best || isWorse(assessment, best.assessment)) best = { entry, assessment };
  }
  if (!best) return null;
  const unaffected = [...new Set(entries.map((e) => e.platform))].filter(
    (p) => !platformsWithError.has(p),
  );
  if (best.assessment.severity !== 'error' || unaffected.length === 0) {
    return { ...best, unaffected: [] };
  }
  return { ...best, assessment: { ...best.assessment, severity: 'warning' }, unaffected };
}

function isWorse(a: Assessment, b: Assessment): boolean {
  const bySeverity = compareSeverity(a.severity, b.severity);
  if (bySeverity !== 0) return bySeverity < 0;
  if (a.daysLeft === null) return false;
  return b.daysLeft === null || a.daysLeft < b.daysLeft;
}
