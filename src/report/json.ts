// The JSON report. Its shape is versioned and described by
// docs/schemas/report-v1.schema.json; a breaking change means a new `report_version`.
// Field names are snake_case, like the registry's.
import type {
  Diagnostic,
  Finding,
  InventoryItem,
  Location,
  Mention,
  ReferenceContext,
  RegistryEntry,
  ScanResult,
  Suppressed,
  UnresolvedReference,
} from '../core/types.ts';
import { countFindings, type ReportContext, registryAgeDays } from './common.ts';
import { qualifiedRuleId } from './rules.ts';

export const REPORT_VERSION = 1;
export const REPORT_SCHEMA_URL =
  'https://raw.githubusercontent.com/AppliedBenchmark/sunset/main/docs/schemas/report-v1.schema.json';

const location = (l: Location) => ({
  path: l.path,
  line: l.line,
  column: l.column,
  end_line: l.endLine,
  end_column: l.endColumn,
});

const entry = (e: RegistryEntry) => ({
  id: e.id,
  provider: e.provider,
  platform: e.platform,
  model_id: e.model_id,
  version: e.version,
  regions: e.regions ?? null,
  status: e.status,
  deprecation_date: e.deprecation_date,
  retirement_date: e.retirement_date,
  retirement_date_qualifier: e.retirement_date_qualifier,
  recommended_replacements: e.recommended_replacements.map((r) => ({
    model_id: r.model_id,
    platform: r.platform,
  })),
  drop_in: e.drop_in,
  source_url: e.source_url,
  verified_on: e.verified_on,
});

function context(c: ReferenceContext | null) {
  if (c === null) return null;
  switch (c.kind) {
    case 'literal':
      return { kind: c.kind };
    case 'bedrock-profile':
      return { kind: c.kind, geo: c.geo };
    case 'bedrock-arn':
      return { kind: c.kind, resource: c.resource, geo: c.geo };
    case 'vertex-path':
      return { kind: c.kind, publisher: c.publisher };
    case 'openrouter':
    case 'vercel-ai-gateway':
      return { kind: c.kind, vendor: c.vendor };
    case 'prefix':
      return { kind: c.kind, prefix: c.prefix };
    case 'azure-deployment':
      return { kind: c.kind, source: c.source };
  }
}

const finding = (f: Finding) => ({
  rule: qualifiedRuleId(f.rule),
  severity: f.severity,
  message: f.message,
  location: location(f.location),
  file_class: f.fileClass,
  model_id: f.modelId,
  context: context(f.context),
  retirement_date: f.retirementDate,
  days_left: f.daysLeft,
  entry: f.entry ? entry(f.entry) : null,
  entries: f.entries.map(entry),
});

const unresolved = (u: UnresolvedReference) => ({
  rule: qualifiedRuleId(u.rule),
  severity: u.severity,
  message: u.message,
  location: location(u.location),
  file_class: u.fileClass,
  reason: u.reason,
  key: u.key,
  expression: u.expression,
  entries: u.entries.map(entry),
});

const mention = (m: Mention) => ({
  severity_in_code: m.severity,
  message: m.message,
  location: location(m.location),
  model_id: m.modelId,
  entry: entry(m.entry),
  entries: m.entries.map(entry),
});

const inventoryItem = (i: InventoryItem) => ({
  model_id: i.modelId,
  locations: i.locations.map(location),
});

const suppressed = (s: Suppressed) => ({
  rule: qualifiedRuleId(s.rule),
  location: location(s.location),
  model_id: s.modelId,
  by: s.by,
  until: s.until,
  reason: s.reason,
});

const diagnostic = (d: Diagnostic) => ({
  kind: d.kind,
  message: d.message,
  location: d.location ? location(d.location) : null,
});

export type JsonReport = ReturnType<typeof jsonReport>;

export function jsonReport(result: ScanResult, ctx: ReportContext) {
  const counts = countFindings(result.findings);
  // Timings are left out so the same input gives byte-identical output; they're logged.
  const { files, lines } = result.stats;
  return {
    $schema: REPORT_SCHEMA_URL,
    report_version: REPORT_VERSION,
    tool: { name: 'sunset', version: ctx.version },
    today: result.today,
    registry: {
      origin: ctx.registryOrigin,
      schema_version: result.registry.schemaVersion,
      registry_version: result.registry.registryVersion,
      generated_at: result.registry.generatedAt,
      entries: result.registry.entries,
      newest_check: result.registry.newestCheck,
      age_days: registryAgeDays(result),
    },
    summary: {
      errors: counts.error,
      warnings: counts.warning,
      notices: counts.notice,
      unresolved: result.unresolved.length,
      mentions: result.mentions.length,
      inventory: result.inventory.length,
      suppressed: result.suppressed.length,
      diagnostics: result.diagnostics.length,
    },
    findings: result.findings.map(finding),
    unresolved: result.unresolved.map(unresolved),
    mentions: result.mentions.map(mention),
    inventory: result.inventory.map(inventoryItem),
    suppressed: result.suppressed.map(suppressed),
    diagnostics: result.diagnostics.map(diagnostic),
    stats: {
      files: {
        listed: files.listed,
        scanned: files.scanned,
        lexed: files.lexed,
        skipped: { ...files.skipped },
      },
      lines,
    },
  };
}

/** The report as written to a file: two-space indent and a final newline. */
export const jsonReportText = (result: ScanResult, ctx: ReportContext): string =>
  `${JSON.stringify(jsonReport(result, ctx), null, 2)}\n`;
