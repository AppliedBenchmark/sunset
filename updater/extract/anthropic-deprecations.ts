// Parser for Anthropic's model deprecations page (`parser: anthropic-deprecations`). Two kinds of
// table:
// - "Model status": `API model name | Current state | Deprecated | Tentative retirement date`
// - deprecation history, one per announcement: `Retirement date | Deprecated model |
//   Recommended replacement`
//
// Rules:
// - A model in a history table takes its history row (the newest announcement first, as the page
//   orders them), which names the replacement. Other models take their status row, whose
//   `Deprecated` cell is the deprecation date. Values are never combined from both rows: each
//   entry's values must come from the one row its excerpt quotes.
// - Status rows: `Current state` Active, Legacy, Deprecated or Retired; any other value is a
//   problem. History rows are deprecated (retired once the date passes).
// - "Not sooner than" dates are `no_earlier_than`; "To be announced" and "N/A" mean no date.
// - A table with some of these columns but not all of them, a model name that isn't an ID (one
//   with a footnote mark), and a history model without code marks are problems, so a page change
//   can't drop models silently.
// The dates apply to Anthropic-operated platforms only; Bedrock and Vertex set their own.
import type { Extractor } from '../../src/core/ports.ts';
import { parseDateString } from '../../src/core/registry/date-strings.ts';
import {
  type ExtractedRow,
  LayoutChangedError,
  type PageDate,
  type PageState,
} from '../../src/core/registry/extract.ts';
import {
  cellText,
  codeSpans,
  columns,
  looksLikeId,
  startsWithCode,
  type Table,
  type TableRow,
  tables,
  unreadTables,
} from './table.ts';

const NOTES = 'Dates apply to Anthropic-operated platforms; Bedrock and Vertex set their own.';
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

const STATES: Record<string, PageState> = {
  active: 'available',
  legacy: 'legacy',
  deprecated: 'deprecated',
  retired: 'retired',
};

type DateCell =
  | { kind: 'date'; date: PageDate; qualifier: ExtractedRow['qualifier'] }
  | { kind: 'none' };

function readDate(cell: string, row: TableRow, problems: string[]): DateCell | null {
  const text = cellText(cell);
  const parsed = parseDateString(text);
  if (parsed.kind === 'invalid') {
    problems.push(`unrecognized date "${text}" in: ${row.line}`);
    return null;
  }
  if (parsed.kind === 'none') return parsed;
  return { kind: 'date', date: { text, iso: parsed.iso }, qualifier: parsed.qualifier };
}

function base(model_id: string, excerpt: string): ExtractedRow {
  return {
    platform: 'anthropic',
    provider: 'anthropic',
    model_id,
    version: null,
    regions: null,
    state: 'deprecated',
    deprecation: null,
    retirement: null,
    qualifier: 'exact',
    replacements: [],
    excerpt,
    notes: NOTES,
  };
}

const STATUS_HEADERS = {
  model: 'API model name',
  state: 'Current state',
  deprecated: 'Deprecated',
  retirement: 'Tentative retirement date',
} as const;
const HISTORY_HEADERS = {
  date: 'Retirement date',
  model: 'Deprecated model',
  replacement: 'Recommended replacement',
} as const;

function historyRows(table: Table, problems: string[]): ExtractedRow[] {
  const col = columns(table, HISTORY_HEADERS);
  if (!col) return [];
  const rows: ExtractedRow[] = [];
  for (const tableRow of table.rows) {
    const modelCell = tableRow.cells[col.model] ?? '';
    if (!startsWithCode(modelCell)) {
      if (looksLikeId(cellText(modelCell))) {
        problems.push(
          `a model without code marks, which the parser doesn't read: ${tableRow.line}`,
        );
      }
      continue;
    }
    const ids = codeSpans(modelCell).filter((id) => MODEL_ID.test(id));
    const date = readDate(tableRow.cells[col.date] ?? '', tableRow, problems);
    if (!date) continue;
    const replacements = codeSpans(tableRow.cells[col.replacement] ?? '').filter((id) =>
      MODEL_ID.test(id),
    );
    for (const id of ids) {
      rows.push({
        ...base(id, tableRow.line),
        retirement: date.kind === 'date' ? date.date : null,
        qualifier: date.kind === 'date' ? date.qualifier : 'exact',
        replacements: replacements.filter((r) => r !== id),
      });
    }
  }
  return rows;
}

function statusRows(table: Table, problems: string[]): ExtractedRow[] {
  const col = columns(table, STATUS_HEADERS);
  if (!col) return [];
  const rows: ExtractedRow[] = [];
  for (const tableRow of table.rows) {
    const id = cellText(tableRow.cells[col.model] ?? '');
    if (!MODEL_ID.test(id)) {
      if (id !== '') problems.push(`unrecognized model name "${id}" in: ${tableRow.line}`);
      continue;
    }
    const stateText = cellText(tableRow.cells[col.state] ?? '');
    const state = STATES[stateText.toLowerCase()];
    if (!state) {
      problems.push(`unrecognized state "${stateText}" in: ${tableRow.line}`);
      continue;
    }
    const deprecated = readDate(tableRow.cells[col.deprecated] ?? '', tableRow, problems);
    const retirement = readDate(tableRow.cells[col.retirement] ?? '', tableRow, problems);
    if (!deprecated || !retirement) continue;
    rows.push({
      ...base(id, tableRow.line),
      state,
      deprecation: deprecated.kind === 'date' ? deprecated.date : null,
      retirement: retirement.kind === 'date' ? retirement.date : null,
      qualifier: retirement.kind === 'date' ? retirement.qualifier : 'exact',
    });
  }
  return rows;
}

export const extractor: Extractor = {
  id: 'anthropic-deprecations',
  extract(page) {
    const problems: string[] = [];
    const status: ExtractedRow[] = [];
    const history: ExtractedRow[] = [];
    let statusTables = 0;
    let historyTables = 0;
    const all = tables(page.text);
    for (const table of all) {
      const fromStatus = statusRows(table, problems);
      const fromHistory = historyRows(table, problems);
      if (columns(table, STATUS_HEADERS)) statusTables++;
      if (columns(table, HISTORY_HEADERS)) historyTables++;
      status.push(...fromStatus);
      history.push(...fromHistory);
    }
    if (statusTables === 0 || historyTables === 0 || status.length === 0) {
      throw new LayoutChangedError('the "Model status" or deprecation history tables are missing');
    }
    problems.push(
      ...unreadTables(
        all,
        (t) => columns(t, STATUS_HEADERS) !== null || columns(t, HISTORY_HEADERS) !== null,
        [...Object.values(STATUS_HEADERS), ...Object.values(HISTORY_HEADERS)].filter(
          (header) => header !== 'Recommended replacement',
        ),
      ),
    );
    const byId = new Map<string, ExtractedRow>();
    // History first (newest announcement first), then status rows for the remaining models.
    for (const row of [...history, ...status]) {
      if (!byId.has(row.model_id)) byId.set(row.model_id, row);
    }
    return { rows: [...byId.values()], problems, exhaustive: true };
  },
};
