// Human-readable messages for findings, unresolved references and diagnostics.
import { describeContext, ROUTER_NAMES } from './registry/formats.ts';
import { type Assessment, assessAll } from './severity.ts';
import type {
  IsoDate,
  Platform,
  ReferenceContext,
  Registry,
  RegistryEntry,
  Replacement,
  Router,
  UnresolvedReason,
} from './types.ts';

/**
 * `bedrock`, `bedrock us-gov-west-1` or, when a sibling entry is region-scoped, `bedrock
 * other regions`; Azure entries add their version.
 */
export function entryLabel(entry: RegistryEntry, siblings: readonly RegistryEntry[] = []): string {
  const version = entry.version ? ` ${entry.version}` : '';
  const scoped = siblings.some(
    (s) => s !== entry && s.platform === entry.platform && s.regions?.length,
  );
  const regions = entry.regions?.length
    ? ` ${entry.regions.join(', ')}`
    : scoped
      ? ' other regions'
      : '';
  return `${entry.platform}${version}${regions}`;
}

function qualified(entry: RegistryEntry): string {
  const date = entry.retirement_date as string;
  switch (entry.retirement_date_qualifier) {
    case 'exact':
      return `on ${date}`;
    case 'no_earlier_than':
      return `no earlier than ${date}`;
    case 'approximate':
      return `around ${date}`;
  }
}

const days = (n: number): string => `${n} ${n === 1 ? 'day' : 'days'}`;

function lifecycle(entry: RegistryEntry, assessment: Assessment): string {
  const left = assessment.daysLeft;
  switch (assessment.rule) {
    case 'model-retired': {
      if (left === null) return 'is retired';
      if (left > 0) return `is marked retired (scheduled date ${entry.retirement_date})`;
      // An approximate date that has passed says when the model was due to go, not that it went.
      if (entry.retirement_date_qualifier === 'approximate' && entry.status !== 'retired') {
        return `was due to retire around ${entry.retirement_date}`;
      }
      if (left === 0) return `is retired as of today (${entry.retirement_date})`;
      return `was retired ${qualified(entry)}`;
    }
    case 'model-retiring':
      if (left !== null && left <= 0) {
        return `may be retired at any time (announced retirement no earlier than ${entry.retirement_date})`;
      }
      return `retires ${qualified(entry)}, in ${days(left ?? 0)}`;
    case 'model-deprecated':
      return entry.retirement_date
        ? `is deprecated and retires ${qualified(entry)}`
        : 'is deprecated; no retirement date has been announced';
    case 'model-unverified':
      return "is in the registry, but its lifecycle isn't verified from an official source yet";
    case 'model-legacy':
      return 'is a legacy model';
    case 'model-reference-unresolved':
    case 'model-id-unknown':
    case 'suppression-expired':
      return 'is referenced';
  }
}

/** A recommended replacement that is retired, or retires within 90 days, itself. */
export interface ReplacementTrouble {
  /** `retired on 2024-10-27`, `retiring around 2026-11-01`. */
  status: string;
  /** The first model down the chain of recommended replacements that isn't in trouble. */
  next: Replacement | null;
}

export type ReplacementCheck = (replacement: Replacement) => ReplacementTrouble | null;

/**
 * Checks recommended replacements against the registry on `today`. A replacement the registry
 * doesn't list has no announced retirement, so it isn't in trouble. An Azure replacement is a
 * model name without a version, which can't be checked.
 */
export function createReplacementCheck(registry: Registry, today: IsoDate): ReplacementCheck {
  const key = (r: Replacement): string => `${r.platform}\u0000${r.model_id}`;
  const byId = new Map<string, RegistryEntry[]>();
  for (const entry of registry.models) {
    for (const id of [entry.model_id, ...entry.aliases]) {
      const k = key({ model_id: id, platform: entry.platform });
      byId.set(k, [...(byId.get(k) ?? []), entry]);
    }
  }
  const troubled = (r: Replacement): RegistryEntry | null => {
    if (r.platform === 'azure-openai') return null;
    const best = assessAll(byId.get(key(r)) ?? [], today, { legacy: false });
    if (!best || best.assessment.severity === 'notice') return null;
    return best.assessment.rule === 'model-retired' || best.assessment.rule === 'model-retiring'
      ? best.entry
      : null;
  };
  return (replacement) => {
    const entry = troubled(replacement);
    if (!entry) return null;
    const status = entry.retirement_date
      ? `${entry.status === 'retired' ? 'retired' : 'retiring'} ${qualified(entry)}`
      : 'retired';
    // Follow the first replacement of each until one is fine; a chain may loop back.
    const seen = new Set([key(replacement)]);
    let next = entry.recommended_replacements[0];
    while (next && !seen.has(key(next))) {
      seen.add(key(next));
      const step = troubled(next);
      if (!step) return { status, next };
      next = step.recommended_replacements[0];
    }
    return { status, next: null };
  };
}

/** Why a reference's verdict is what it is, beyond its dates. */
export interface Verdict {
  /** Platforms that share the ID but where it isn't an error, so an error became a warning. */
  unaffected?: readonly Platform[];
  /** The platforms the repository's dependencies settled a shared ID for. */
  judgedFor?: readonly Platform[];
  /** The router whose slug's error is reported as a warning. */
  router?: Router | null;
  /** Says which recommended replacements are in trouble themselves. */
  replacements?: ReplacementCheck;
}

function replacementText(replacement: Replacement, check: ReplacementCheck | undefined): string {
  const trouble = check?.(replacement);
  if (!trouble) return `${replacement.model_id} (${replacement.platform})`;
  const { next } = trouble;
  const then = next
    ? `, replaced by ${next.model_id}${next.platform === replacement.platform ? '' : ` (${next.platform})`}`
    : '';
  return `${replacement.model_id} (${replacement.platform}; itself ${trouble.status}${then})`;
}

export function referenceMessage(
  text: string,
  entry: RegistryEntry,
  assessment: Assessment,
  entries: readonly RegistryEntry[],
  context: ReferenceContext,
  { unaffected = [], judgedFor = [], router = null, replacements: check }: Verdict = {},
): string {
  const where = describeContext(context);
  let message = `${text} (${entryLabel(entry, entries)}${where ? `; ${where}` : ''}) ${lifecycle(entry, assessment)}.`;
  const replacements = entry.recommended_replacements;
  if (replacements.length > 0) {
    const list = replacements.map((r) => replacementText(r, check)).join(', ');
    message += ` Recommended replacement: ${list}${entry.drop_in ? ', a drop-in replacement' : ''}.`;
  }
  const others = entries.filter((e) => e !== entry);
  if (others.length > 0) {
    message += ` Other dates: ${others
      .map((e) => `${entryLabel(e, entries)}: ${e.retirement_date ?? `no date (${e.status})`}`)
      .join('; ')}.`;
  }
  if (unaffected.length > 0) {
    message += ` Reported as a warning, not an error: the ID is also served on ${unaffected.join(', ')}, where it isn't an error.`;
  }
  if (router) {
    const name = ROUTER_NAMES[router];
    message += ` ${name[0]?.toUpperCase()}${name.slice(1)} may still route this slug to other providers, so this is a warning, not an error.`;
  }
  if (judgedFor.length > 0) {
    message += ` Judged for ${judgedFor.join(', ')}, which this repository's dependencies use; set \`platforms\` in .sunset.yml to change that.`;
  } else if (new Set(entries.map((e) => e.platform)).size > 1) {
    message += ' If you use only some of these platforms, set `platforms` in .sunset.yml.';
  }
  return message;
}

export function unknownMessage(text: string, known: readonly string[]): string {
  return `${text} isn't a model ID any provider lists. Did you mean ${known.join(' or ')}? Requests with an unknown ID fail.`;
}

export function unresolvedMessage(
  reason: UnresolvedReason,
  key: string | null,
  expression: string,
  entries: readonly RegistryEntry[],
  today: IsoDate,
): string {
  const subject = key ? `\`${key}\`` : 'This reference';
  const check = "Sunset can't check it; make sure the model it names isn't deprecated or retiring.";
  const versions = versionsNote(entries, today);
  switch (reason) {
    case 'environment':
      return `${subject} comes from the environment (${expression}). ${check}`;
    case 'variable':
      return `${subject} is set from ${expression}. ${check}${versions}`;
    case 'interpolated':
      return `${subject} is built from an interpolated string (${expression}). ${check}`;
    case 'opaque-arn':
      return `${expression} is an application inference profile or provisioned model, which hides the model ID. ${check}`;
    case 'azure-no-version':
      return `The Azure deployment of ${expression} has no model version, so Azure assigns its default version at deployment time.${versions}`;
    case 'azure-unknown':
      return entries.length > 0
        ? `The Azure deployment of ${entries[0]?.model_id} version ${expression} isn't in Sunset's registry, so Sunset can't check it.${versions}`
        : `The Azure deployment of ${expression} isn't in Sunset's registry, so Sunset can't check it; make sure the model isn't deprecated or retiring.`;
    case 'azure-deployment-name':
      return `${expression} calls an Azure deployment by name. A deployment named after a model usually runs it, but its version is set where the deployment is created.${versions}`;
  }
}

function versionsNote(entries: readonly RegistryEntry[], today: IsoDate): string {
  if (entries.length === 0) return '';
  const list = [...entries]
    .sort((a, b) => ((a.version ?? '') < (b.version ?? '') ? -1 : 1))
    .map((e) => `${e.version ?? '?'} (${retirement(e, today)})`)
    .join(', ');
  return ` Known versions: ${list}.`;
}

/** `retires 2027-04-14`, `retired 2025-02-13` once the date is today or past, or the status. */
function retirement(entry: RegistryEntry, today: IsoDate): string {
  const date = entry.retirement_date;
  if (date === null) return entry.status;
  // Only an exact date that has come says the model is gone.
  if (entry.retirement_date_qualifier !== 'exact') return `retirement ${qualified(entry)}`;
  return `${date <= today ? 'retired' : 'retires'} ${date}`;
}
