// The Markdown job summary: counts, findings grouped by model, then collapsed sections
// for directive problems, unresolved references, docs mentions, models not in the registry and
// suppressions, and a line about the registry. GitHub caps a step's summary at 1 MiB, so rows are
// dropped from the least important sections first and a note says so.

import { compareLocations } from '../core/scan/lines.ts';
import { compareSeverity } from '../core/severity.ts';
import type { Finding, ScanResult, Severity } from '../core/types.ts';
import {
  cell,
  code,
  countFindings,
  entryName,
  locationLink,
  plural,
  type ReportContext,
  registryLine,
  replacementsText,
  utf8Bytes,
} from './common.ts';
import { RULE_INFO } from './rules.ts';

/** GitHub's limit for one step's summary. */
export const SUMMARY_LIMIT_BYTES = 1024 * 1024;
/** Locations listed per model before "and N more". */
const LOCATIONS_PER_ROW = 5;

export interface SummaryOptions {
  maxBytes?: number;
  /** The heading; the PR comment uses its own. */
  title?: string;
}

/** A table or list whose rows can be dropped to fit the size limit. */
interface Section {
  head: string[];
  rows: string[];
  tail: string[];
  /** Lower numbers are dropped first. */
  keep: number;
  omitted: number;
}

const SEVERITY_LABEL: Record<Severity, string> = {
  error: '**error**',
  warning: 'warning',
  notice: 'notice',
};

export function summaryMarkdown(
  result: ScanResult,
  ctx: ReportContext,
  opts: SummaryOptions = {},
): string {
  const max = opts.maxBytes ?? SUMMARY_LIMIT_BYTES;
  const intro = [`## ${opts.title ?? 'Sunset'}`, '', tallyLine(result)];
  const footer = [
    '',
    `<sub>sunset ${ctx.version} · ${registryLine(result, ctx)} · dates as of ${result.today}</sub>`,
  ];
  const sections = [
    findingsSection(result.findings, ctx),
    diagnosticsSection(result),
    unresolvedSection(result, ctx),
    mentionsSection(result, ctx),
    inventorySection(result, ctx),
    suppressedSection(result, ctx),
  ].filter((s): s is Section => s !== null);

  const render = (note: string[]) =>
    `${[
      ...intro,
      ...note,
      ...sections.flatMap((s) => [
        '',
        ...s.head,
        ...s.rows,
        ...(s.omitted ? [`| _…and ${s.omitted.toLocaleString('en-US')} more, not shown_ |`] : []),
        ...s.tail,
      ]),
      ...footer,
    ].join('\n')}\n`;

  let text = render([]);
  if (utf8Bytes(text) <= max) return text;

  const note = [
    '',
    `> [!NOTE]\n> This summary was shortened to fit GitHub's ${Math.floor(max / 1024).toLocaleString('en-US')} KiB limit. The JSON report has every result.`,
  ];
  // Reserve room for the note and one "more" line per section, then drop rows.
  let bytes = utf8Bytes(render(note)) + sections.length * 64;
  for (const section of [...sections].sort((a, b) => a.keep - b.keep)) {
    while (bytes > max && section.rows.length > 0) {
      bytes -= utf8Bytes(section.rows.pop() as string) + 1;
      section.omitted++;
    }
  }
  text = render(note);
  return text;
}

function tallyLine(result: ScanResult): string {
  const c = countFindings(result.findings);
  const main = `**${plural(c.error, 'error')}**, **${plural(c.warning, 'warning')}**, ${plural(c.notice, 'notice')}`;
  const extra = [
    result.unresolved.length && plural(result.unresolved.length, 'unresolved reference'),
    result.mentions.length && `${plural(result.mentions.length, 'mention')} in docs`,
    result.suppressed.length && `${result.suppressed.length.toLocaleString('en-US')} suppressed`,
  ].filter((p): p is string => typeof p === 'string');
  const files = `in ${plural(result.stats.files.scanned, 'file')}`;
  return [`${main} ${files}`, ...extra].join(' · ');
}

// ── Findings by model ────────────────────────────────────────────────────────────────────────

interface Group {
  severity: Severity;
  findings: Finding[];
}

function groupKey(f: Finding): string {
  return `${f.severity}\u0000${f.rule}\u0000${f.entry?.id ?? f.modelId}`;
}

function retirement(f: Finding): string {
  if (!f.retirementDate || !f.entry) return '';
  const q = f.entry.retirement_date_qualifier;
  const prefix = q === 'no_earlier_than' ? 'not before ' : q === 'approximate' ? 'around ' : '';
  const left = f.daysLeft;
  const when =
    left === null
      ? ''
      : left > 0
        ? ` (in ${plural(left, 'day')})`
        : left === 0
          ? ' (today)'
          : ` (${plural(-left, 'day')} ago)`;
  return `${prefix}${f.retirementDate}${when}`;
}

function model(f: Finding): string {
  if (!f.entry) return code(f.modelId);
  const written = f.modelId === f.entry.model_id ? '' : `<br>written as ${code(f.modelId)}`;
  return `${code(f.entry.model_id)} (${entryName(f.entry)})${written}`;
}

function findingsSection(findings: readonly Finding[], ctx: ReportContext): Section | null {
  if (findings.length === 0) {
    return {
      head: ['No deprecated, retiring or retired models were found.'],
      rows: [],
      tail: [],
      keep: 99,
      omitted: 0,
    };
  }
  const groups = new Map<string, Group>();
  for (const f of findings) {
    const key = groupKey(f);
    const group = groups.get(key) ?? { severity: f.severity, findings: [] };
    group.findings.push(f);
    groups.set(key, group);
  }
  const sorted = [...groups.values()].sort((a, b) => {
    const fa = a.findings[0] as Finding;
    const fb = b.findings[0] as Finding;
    return (
      compareSeverity(a.severity, b.severity) ||
      (fa.daysLeft ?? Number.POSITIVE_INFINITY) - (fb.daysLeft ?? Number.POSITIVE_INFINITY) ||
      compareLocations(fa.location, fb.location)
    );
  });
  const rows = sorted.map(({ severity, findings: group }) => {
    const f = group[0] as Finding;
    const shown = group.slice(0, LOCATIONS_PER_ROW).map((g) => locationLink(g.location, ctx));
    const more = group.length - shown.length;
    const locations =
      shown.join(', ') + (more > 0 ? `, and ${more.toLocaleString('en-US')} more` : '');
    return `| ${SEVERITY_LABEL[severity]} | ${model(f)} | ${cell(RULE_INFO[f.rule].title)} | ${retirement(f)} | ${replacementsText(f.entry)} | ${locations} |`;
  });
  return {
    head: [
      '### Findings',
      '',
      '| Severity | Model | Rule | Retirement | Replacement | Where |',
      '|---|---|---|---|---|---|',
    ],
    rows,
    tail: [],
    keep: 50,
    omitted: 0,
  };
}

// ── Collapsed sections ───────────────────────────────────────────────────────────────────────

/** A `<details>` block; the table inside needs blank lines around it to render. */
function collapsed(
  summary: string,
  intro: string,
  header: string[],
  rows: string[],
  keep: number,
): Section {
  return {
    head: ['<details>', `<summary>${summary}</summary>`, '', intro, '', ...header],
    rows,
    tail: ['', '</details>'],
    keep,
    omitted: 0,
  };
}

function diagnosticsSection(result: ScanResult): Section | null {
  if (result.diagnostics.length === 0) return null;
  const rows = result.diagnostics.map(
    (d) =>
      `| ${d.location ? code(`${d.location.path}:${d.location.line}`) : '_config_'} | ${cell(d.message)} |`,
  );
  return collapsed(
    `Directive and config problems (${result.diagnostics.length.toLocaleString('en-US')})`,
    'These suppressions are malformed or expired, so they no longer apply.',
    ['| Where | Problem |', '|---|---|'],
    rows,
    40,
  );
}

function unresolvedSection(result: ScanResult, ctx: ReportContext): Section | null {
  if (result.unresolved.length === 0) return null;
  const rows = result.unresolved.map(
    (u) => `| ${locationLink(u.location, ctx)} | ${cell(u.message)} |`,
  );
  return collapsed(
    `Unresolved references (${result.unresolved.length.toLocaleString('en-US')})`,
    "The model here is chosen at run time, so Sunset can't check it.",
    ['| Where | Details |', '|---|---|'],
    rows,
    30,
  );
}

function mentionsSection(result: ScanResult, ctx: ReportContext): Section | null {
  if (result.mentions.length === 0) return null;
  const rows = result.mentions.map(
    (m) =>
      `| ${locationLink(m.location, ctx)} | ${code(m.modelId)} (${entryName(m.entry)}) | ${m.severity} | ${cell(m.message)} |`,
  );
  return collapsed(
    `Mentioned in docs (${result.mentions.length.toLocaleString('en-US')})`,
    "Model IDs in documentation never fail a run. The level is what they'd be in code.",
    ['| Where | Model | Level in code | Details |', '|---|---|---|---|'],
    rows,
    20,
  );
}

function inventorySection(result: ScanResult, ctx: ReportContext): Section | null {
  if (result.inventory.length === 0) return null;
  const rows = result.inventory.map((i) => {
    const shown = i.locations.slice(0, LOCATIONS_PER_ROW).map((l) => locationLink(l, ctx));
    const more = i.locations.length - shown.length;
    return `| ${code(i.modelId)} | ${shown.join(', ')}${more > 0 ? `, and ${more.toLocaleString('en-US')} more` : ''} |`;
  });
  return collapsed(
    `Not in the registry (${result.inventory.length.toLocaleString('en-US')})`,
    "These look like model IDs, but Sunset's registry doesn't know them, so their lifecycle is unknown.",
    ['| Model | Where |', '|---|---|'],
    rows,
    10,
  );
}

function suppressedSection(result: ScanResult, ctx: ReportContext): Section | null {
  if (result.suppressed.length === 0) return null;
  const rows = result.suppressed.map(
    (s) =>
      `| ${locationLink(s.location, ctx)} | ${code(s.modelId)} | ${cell(RULE_INFO[s.rule].title)} | ${s.by} | ${s.until ?? ''} | ${cell(s.reason ?? '')} |`,
  );
  return collapsed(
    `Suppressed (${result.suppressed.length.toLocaleString('en-US')})`,
    'Findings hidden by an inline directive or a config ignore.',
    ['| Where | Model | Rule | By | Until | Reason |', '|---|---|---|---|---|---|'],
    rows,
    0,
  );
}
