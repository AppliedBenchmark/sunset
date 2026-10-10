// Parser for Azure's retired Foundry models page (`parser: azure-retired-models`). Each model
// maker has a `## <maker>` section. The Azure OpenAI table has the columns
// `Model | Version | Deprecation date | Retirement date | Suggested replacement`; the other
// makers' tables have no Version column.
//
// - Every model on the page is retired. Entries are keyed by (model, version), because Azure
//   deployments are matched on both, so rows without a version and the tables without a Version
//   column are left out.
// - A model cell can name several models (`gpt-4`<br>`gpt-4-32k`); each gets an entry with the
//   row as its excerpt.
// - Replacements are the code spans of the Suggested replacement cell, without the versions that
//   follow some of them (`gpt-4o` version: `2024-11-20`) and without the model itself.
// - The page repeats versions the retirement schedule still lists; the merge leaves those to
//   azure-openai/model-retirement-schedule (ADDS_ONLY_PARSERS in merge.ts).
// - A (model, version) listed more than once with different values can't be tied to one quote,
//   so it becomes `unverified`.
// Any other table with a `Model` or `Retirement date` column is a problem.

import type { Extractor } from '../../src/core/ports.ts';
import { parseDateString } from '../../src/core/registry/date-strings.ts';
import {
  type ExtractedRow,
  LayoutChangedError,
  type PageDate,
} from '../../src/core/registry/extract.ts';
import { maker } from './azure-retirement-tables.ts';
import { cellText, codeSpans, columns, type TableRow, tables, unreadTables } from './table.ts';

const HEADERS = {
  model: 'Model',
  version: 'Version',
  deprecation: 'Deprecation date',
  retirement: 'Retirement date',
  replacement: 'Suggested replacement',
} as const;
// The other makers' tables: their models have no version.
const VERSIONLESS = {
  model: 'Model',
  retirement: 'Retirement date',
  replacement: 'Suggested replacement',
} as const;

const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const VERSION_SPAN = /^\d{4}(?:-\d{2}-\d{2})?$/;
const LINE_BREAK = /<br\s*\/?>/i;

export const extractor: Extractor = {
  id: 'azure-retired-models',
  extract(page) {
    const problems: string[] = [];
    const all = tables(page.text);
    const versioned = all.filter((t) => columns(t, HEADERS) !== null);
    const known = (t: (typeof all)[number]) =>
      columns(t, HEADERS) !== null ||
      (columns(t, VERSIONLESS) !== null && !t.headers.some((h) => h.toLowerCase() === 'version'));
    problems.push(...unreadTables(all, known, [HEADERS.model, HEADERS.retirement]));
    if (versioned.length === 0) {
      throw new LayoutChangedError(
        `no table with the columns ${Object.values(HEADERS).join(', ')}`,
      );
    }

    const date = (row: TableRow, index: number, what: string): PageDate | null | undefined => {
      const text = cellText(row.cells[index] ?? '');
      const parsed = parseDateString(text);
      if (parsed.kind === 'none') return null;
      if (parsed.kind === 'invalid') {
        problems.push(`unrecognized ${what} "${text}" in: ${row.line}`);
        return undefined;
      }
      return { text, iso: parsed.iso };
    };

    const byKey = new Map<string, { row: ExtractedRow; values: string }[]>();
    for (const table of versioned) {
      const col = columns(table, HEADERS) as Record<keyof typeof HEADERS, number>;
      const provider = maker(table.heading);
      for (const line of table.rows) {
        const version = cellText(line.cells[col.version] ?? '');
        if (parseDateString(version).kind === 'none') continue;
        const models = (line.cells[col.model] ?? '')
          .split(LINE_BREAK)
          .map(cellText)
          .filter(Boolean);
        if (
          !/^\S+$/.test(version) ||
          models.length === 0 ||
          !models.every((m) => MODEL_ID.test(m))
        ) {
          problems.push(`unrecognized model or version in: ${line.line}`);
          continue;
        }
        const deprecation = date(line, col.deprecation, 'deprecation date');
        const retirement = date(line, col.retirement, 'retirement date');
        if (deprecation === undefined || retirement === undefined) continue;
        if (retirement === null) {
          problems.push(`a retired model without a retirement date: ${line.line}`);
          continue;
        }
        const spans = codeSpans(line.cells[col.replacement] ?? '').filter(
          (span) => MODEL_ID.test(span) && !VERSION_SPAN.test(span),
        );
        for (const model of models) {
          const replacements = [...new Set(spans.filter((span) => span !== model))];
          const row: ExtractedRow = {
            platform: 'azure-openai',
            provider,
            model_id: model,
            version,
            regions: null,
            state: 'retired',
            deprecation,
            retirement,
            qualifier: 'exact',
            replacements,
            excerpt: line.line,
            notes: null,
          };
          const key = `${model}@${version}`;
          const values = JSON.stringify([deprecation?.iso, retirement.iso, replacements]);
          byKey.set(key, [...(byKey.get(key) ?? []), { row, values }]);
        }
      }
    }
    const rows: ExtractedRow[] = [];
    for (const list of byKey.values()) {
      const first = list[0] as { row: ExtractedRow; values: string };
      if (list.every((item) => item.values === first.values)) {
        rows.push(first.row);
      } else {
        rows.push({
          ...first.row,
          state: 'unverified',
          deprecation: null,
          retirement: null,
          replacements: [],
          notes: 'The page lists this model and version more than once with different values.',
        });
      }
    }
    if (rows.length === 0 && problems.length === 0) {
      throw new LayoutChangedError('the retired-models table has no rows with a version');
    }
    return { rows, problems, exhaustive: true };
  },
};
