// The rules every report uses. IDs are stable; docs/rules.md documents each one,
// and a test keeps the two in step.
import type { RuleId, Severity } from '../core/types.ts';

/** Rule IDs carry the tool's prefix outside Sunset: `sunset/model-retired`. */
export const RULE_PREFIX = 'sunset';

export const qualifiedRuleId = (rule: RuleId): string => `${RULE_PREFIX}/${rule}`;

export const HELP_BASE = 'https://github.com/AppliedBenchmark/sunset/blob/main/docs/rules.md';

export interface RuleInfo {
  id: RuleId;
  /** PascalCase, for SARIF `name`. */
  name: string;
  /** A short title, used for annotations and table headings. */
  title: string;
  short: string;
  full: string;
  /** What to do about it, as Markdown. */
  help: string;
  /** The level when the rule fires without a date to go by. */
  defaultSeverity: Severity;
}

/** Every rule, in the order reports list them. */
export const RULES: readonly RuleInfo[] = [
  {
    id: 'model-retired',
    name: 'ModelRetired',
    title: 'Retired model',
    short: 'The model is retired; requests to it fail.',
    full: 'The code references a model whose retirement date has passed, or that its provider lists as retired. Requests that use it fail or are served by another model.',
    help: 'Move to the recommended replacement, if the message names one, and test the change: replacements are not always drop-in. If the reference is intentional, suppress it with `sunset-ignore` and a `reason`.',
    defaultSeverity: 'error',
  },
  {
    id: 'model-retiring',
    name: 'ModelRetiring',
    title: 'Retiring model',
    short: 'The model retires soon.',
    full: 'The model has an announced retirement date. The finding is an error under 30 days and a warning under 90 days. A date the provider gives as "no earlier than" is the earliest it can happen.',
    help: 'Plan the migration before the date in the message. Use `sunset-ignore until=YYYY-MM-DD` to defer the finding without losing track of it.',
    defaultSeverity: 'warning',
  },
  {
    id: 'model-deprecated',
    name: 'ModelDeprecated',
    title: 'Deprecated model',
    short: 'The model is deprecated.',
    full: 'The provider has deprecated the model, but its retirement is 90 days or more away, or not yet announced.',
    help: 'No action is needed yet. Plan a move to the recommended replacement; the finding becomes a warning 90 days before retirement.',
    defaultSeverity: 'notice',
  },
  {
    id: 'model-unverified',
    name: 'ModelUnverified',
    title: 'Unverified model',
    short: "The model's lifecycle isn't verified from an official source.",
    full: "The model is in Sunset's registry, but its lifecycle couldn't be tied to an official source yet, so Sunset can't say whether it is at risk.",
    help: "Check the provider's documentation for the model's status.",
    defaultSeverity: 'notice',
  },
  {
    id: 'model-legacy',
    name: 'ModelLegacy',
    title: 'Legacy model',
    short: 'The provider lists the model as legacy.',
    full: 'The provider lists the model as legacy but has announced no deprecation. Reported only when `legacy` is enabled.',
    help: 'Consider moving to a current model before it is deprecated.',
    defaultSeverity: 'notice',
  },
  {
    id: 'model-reference-unresolved',
    name: 'ModelReferenceUnresolved',
    title: 'Unresolved model reference',
    short: "A model is chosen at run time, so Sunset can't check it.",
    full: 'A model parameter is set from the environment, a variable or an interpolated string, or an Azure deployment has no model version. Sunset reports it instead of skipping it silently.',
    help: "Make sure the model that ends up here isn't deprecated or retiring. Suppress the notice with `sunset-ignore` once you have checked it.",
    defaultSeverity: 'notice',
  },
  {
    id: 'model-id-unknown',
    name: 'ModelIdUnknown',
    title: 'Unknown model ID',
    short: 'A model ID that no provider lists, but whose parts match one that does.',
    // sunset-ignore-next-line reason="example IDs in the rule's help text"
    full: 'The string has the same words and numbers as a model ID in the registry, in another order (`claude-haiku-3-5` for `claude-3-5-haiku`). Requests with it will most likely fail.',
    help: "Check the provider's model list and use the exact ID. If the ID is right (a custom name on a gateway, say), suppress the notice with `sunset-ignore`.",
    defaultSeverity: 'notice',
  },
  {
    id: 'suppression-expired',
    name: 'SuppressionExpired',
    title: 'Expired suppression',
    short: 'A suppression has passed its `until` date.',
    full: 'An inline `sunset-ignore` directive has an `until` date that has passed, so what it covered is reported again.',
    help: 'Remove the directive, or extend its `until` date if the migration is still pending.',
    defaultSeverity: 'notice',
  },
];

export const RULE_INFO: Readonly<Record<RuleId, RuleInfo>> = Object.fromEntries(
  RULES.map((r) => [r.id, r]),
) as Record<RuleId, RuleInfo>;

export const helpUri = (rule: RuleId): string => `${HELP_BASE}#${rule}`;
