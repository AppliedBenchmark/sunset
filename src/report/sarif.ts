// SARIF 2.1.0 for GitHub code scanning.
//
// - Exactly one run: since 2025-07-22 GitHub rejects several runs for the same tool and category.
// - Each result has one location (GitHub reads only the first) with a repo-relative URI.
// - `columnKind` is set: the schema has no default, and our columns are UTF-16 code units.
// - No `automationDetails`: `upload-sarif` then sets the category itself, one per workflow job and
//   matrix combination, or the value of its `category` input. A category in the file would win
//   over that input.
// - No `partialFingerprints`: `upload-sarif` computes them when they are missing.
// - At most 25,000 results per run. Past that, the most severe are kept and a tool notification
//   says how many were dropped.
//
// Docs mentions and suppressed findings are left out. Diagnostics become tool configuration
// notifications, since they are problems with Sunset's own input.
import type { Log, Notification, ReportingDescriptor, Result } from 'sarif';
import type { ScanResult, Severity } from '../core/types.ts';
import { byLocation, bySeverity, type Item, items, type ReportContext } from './common.ts';
import { helpUri, qualifiedRuleId, RULES } from './rules.ts';

export const SARIF_SCHEMA = 'https://json.schemastore.org/sarif-2.1.0.json';
export const SARIF_MAX_RESULTS = 25_000;
export const INFORMATION_URI = 'https://github.com/AppliedBenchmark/sunset';

export interface SarifOptions {
  maxResults?: number;
}

const LEVELS: Record<Severity, Result.level> = {
  error: 'error',
  warning: 'warning',
  notice: 'note',
};

function rule(info: (typeof RULES)[number]): ReportingDescriptor {
  return {
    id: qualifiedRuleId(info.id),
    name: info.name,
    shortDescription: { text: info.short },
    fullDescription: { text: info.full },
    help: { text: plainHelp(info.help), markdown: info.help },
    helpUri: helpUri(info.id),
    defaultConfiguration: { level: LEVELS[info.defaultSeverity] },
    properties: { tags: ['maintainability', 'ai-models'] },
  };
}

/** Markdown help without the code backticks, for `help.text`. */
const plainHelp = (markdown: string): string => markdown.replace(/`([^`]*)`/g, '$1');

export function sarifReport(result: ScanResult, ctx: ReportContext, opts: SarifOptions = {}): Log {
  const max = opts.maxResults ?? SARIF_MAX_RESULTS;
  const ruleIndex = new Map(RULES.map((r, i) => [r.id as string, i]));
  const all = items(result).filter((i) => ruleIndex.has(i.rule));
  const kept = all.length > max ? all.sort(bySeverity).slice(0, max).sort(byLocation) : all;

  const executionNotifications: Notification[] = [];
  if (kept.length < all.length) {
    executionNotifications.push({
      level: 'warning',
      descriptor: { id: 'results-truncated' },
      message: {
        text: `Sunset found ${all.length} results; only the ${kept.length} most severe are included, because GitHub accepts at most ${max} per run. See the JSON report or the job summary for the rest.`,
      },
    });
  }

  const configurationNotifications: Notification[] = result.diagnostics.map((d) => ({
    level: 'note',
    descriptor: { id: d.kind },
    message: { text: d.message },
    ...(d.location ? { locations: [physical(d.location.path, d.location)] } : {}),
  }));

  return {
    $schema: SARIF_SCHEMA,
    version: '2.1.0',
    runs: [
      {
        tool: {
          driver: {
            name: 'Sunset',
            semanticVersion: ctx.version,
            version: ctx.version,
            informationUri: INFORMATION_URI,
            rules: RULES.map(rule),
          },
        },
        columnKind: 'utf16CodeUnits',
        invocations: [
          {
            executionSuccessful: true,
            toolExecutionNotifications: executionNotifications,
            toolConfigurationNotifications: configurationNotifications,
          },
        ],
        results: kept.map((item) => toResult(item, ruleIndex.get(item.rule) as number)),
        properties: {
          today: result.today,
          registry: {
            origin: ctx.registryOrigin,
            version: result.registry.registryVersion,
            newestCheck: result.registry.newestCheck,
          },
        },
      },
    ],
  };
}

function physical(path: string, l: Item['location']) {
  return {
    physicalLocation: {
      artifactLocation: { uri: encodePath(path), uriBaseId: '%SRCROOT%' },
      region: {
        startLine: l.line,
        startColumn: l.column,
        endLine: l.endLine,
        endColumn: l.endColumn,
      },
    },
  };
}

/** A relative URI reference: each segment percent-encoded, slashes kept. */
const encodePath = (path: string): string => path.split('/').map(encodeURIComponent).join('/');

function toResult(item: Item, index: number): Result {
  const source = item.source;
  const properties: Record<string, unknown> = {};
  if ('entry' in source && source.entry) {
    properties.modelId = source.modelId;
    properties.entry = source.entry.id;
    properties.platform = source.entry.platform;
    properties.retirementDate = source.retirementDate;
    properties.daysLeft = source.daysLeft;
  } else if ('reason' in source) {
    properties.reason = source.reason;
    properties.expression = source.expression;
  }
  return {
    ruleId: qualifiedRuleId(item.rule as (typeof RULES)[number]['id']),
    ruleIndex: index,
    level: LEVELS[item.severity],
    message: { text: item.message },
    locations: [physical(item.location.path, item.location)],
    ...(Object.keys(properties).length ? { properties } : {}),
  };
}

/** The log as written to a file. */
export const sarifReportText = (
  result: ScanResult,
  ctx: ReportContext,
  opts?: SarifOptions,
): string => `${JSON.stringify(sarifReport(result, ctx, opts), null, 2)}\n`;
